#!/usr/bin/env node
/**
 * lyrics-video.js
 * Builds a karaoke-style lyrics video from a song, lyrics file, and one image.
 *
 * Usage:
 *   node scripts/lyrics-video.js <lyrics.txt> <audio.(mp3|wav)> <image.(png|jpg)> [output-dir]
 *
 * Optional env overrides:
 *   SECTION_XFADE_S     Crossfade duration between sections  (default: 0.4)
 *   HIGHLIGHT_STYLE     box | underline | color               (default: box)
 *   KARAOKE_COLOR       Hex colour for highlight              (default: #FF8800)
 *   LAND_IMG_RATIO      Fraction of landscape width for image (default: 0.6)
 *   PORT_IMG_RATIO      Fraction of portrait height for image (default: 0.6)
 *   LAND_FONT           Landscape font size                   (default: 48)
 *   PORT_FONT           Portrait font size                    (default: 80)
 *   LAND_TEXT_COLOR     Landscape text colour                 (default: #000000)
 *   PORT_TEXT_COLOR     Portrait text colour                  (default: #000000)
 *   LAND_TEXT_BG        Landscape text bg colour              (default: #ffffff)
 *   PORT_TEXT_BG        Portrait text bg colour               (default: #ffffff)
 *   MUSIC_VOLUME        Song volume 0.0–2.0                   (default: 1.0)
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const sharp         = require('sharp');

const execFileAsync = promisify(execFile);

// ─── Config ────────────────────────────────────────────────────────────────────

const LAND_W = 1920;
const LAND_H = 1080;
const PORT_W = 1080;
const PORT_H = 1920;

const LAND_IMG_RATIO  = parseFloat(process.env.LAND_IMG_RATIO  || '0.6');
const PORT_IMG_RATIO  = parseFloat(process.env.PORT_IMG_RATIO  || '0.6');

const LAND_IMG_W = Math.round(LAND_W * LAND_IMG_RATIO);
const LAND_TXT_X = LAND_IMG_W;
const LAND_TXT_Y = 0;
const LAND_TXT_W = LAND_W - LAND_IMG_W;
const LAND_TXT_H = LAND_H;

const PORT_IMG_H = Math.round(PORT_H * PORT_IMG_RATIO);
const PORT_TXT_X = 0;
const PORT_TXT_Y = PORT_IMG_H;
const PORT_TXT_W = PORT_W;
const PORT_TXT_H = PORT_H - PORT_IMG_H;

const LAND_FONT        = parseInt(process.env.LAND_FONT        || '48');
const PORT_FONT        = parseInt(process.env.PORT_FONT        || '80');
const LAND_TEXT_COLOR  = process.env.LAND_TEXT_COLOR  || '#000000';
const PORT_TEXT_COLOR  = process.env.PORT_TEXT_COLOR  || '#000000';
const LAND_TEXT_BG     = process.env.LAND_TEXT_BG     || '#ffffff';
const PORT_TEXT_BG     = process.env.PORT_TEXT_BG     || '#ffffff';

const SECTION_XFADE_S  = parseFloat(process.env.SECTION_XFADE_S || '0.4');
const HIGHLIGHT_STYLE  = process.env.HIGHLIGHT_STYLE  || 'box';
const KARAOKE_COLOR    = process.env.KARAOKE_COLOR    || '#FF8800';
const MUSIC_VOLUME     = parseFloat(process.env.MUSIC_VOLUME    || '1.0');

// ─── FFmpeg helpers ────────────────────────────────────────────────────────────

function ffmpeg(...args) {
  return execFileAsync('ffmpeg', ['-y', ...args], { maxBuffer: 100 * 1024 * 1024 });
}

async function getMediaDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const dur = parseFloat(stdout.trim());
  if (!isFinite(dur)) throw new Error(`Could not read duration of "${path.basename(filePath)}"`);
  return dur;
}

// ─── Lyrics parser ─────────────────────────────────────────────────────────────
// Splits lyrics into sections.  Labels like "(Verse 1)" or "(Chorus)" are
// stripped — only the lyric text is kept.
// Returns [{ label: string, text: string }]

function parseLyrics(raw) {
  const sectionRe = /^\(([^)]+)\)\s*/;
  const sections  = [];
  let currentLabel = '';
  let lines        = [];

  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) sections.push({ label: currentLabel, text });
    lines = [];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = sectionRe.exec(line);
    if (m) {
      flush();
      currentLabel = m[1];
      const rest = line.slice(m[0].length).trim();
      if (rest) lines.push(rest);
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

// ─── Word-timing alignment ─────────────────────────────────────────────────────
// Runs faster-whisper on the audio file and caches the result as a JSON sidecar.
// Returns [{word, start, end}] for the entire song.

async function getWordTimings(audioPath, cacheDir) {
  const base      = path.basename(audioPath, path.extname(audioPath));
  const jsonPath  = path.join(cacheDir, `${base}_timings.json`);
  if (fs.existsSync(jsonPath)) {
    try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
  }
  console.log('Aligning lyrics to audio with Whisper (this may take a moment)...');
  await execFileAsync(
    'py', ['-3.11', path.join(__dirname, 'whisper_align.py'), audioPath, jsonPath],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

// Normalise a word for matching: lowercase, strip non-alphanumeric.
function normWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

// Maps whisper timings to sections by sequential word matching.
// Each section gets the absolute start/end time in the song and its matched
// word timings (absolute).  Gaps between sections extend the preceding section
// so clips tile without gaps.
// Returns sections enriched with { words, clipStart, clipEnd }.

function mapTimingsToSections(sections, allTimings, songDuration) {
  // Flatten lyric words with their section index
  const lyricWords = sections.flatMap((s, si) =>
    s.text.split(/\s+/).filter(Boolean).map(w => ({ norm: normWord(w), sectionIdx: si }))
  );

  const sectionWordTimings = sections.map(() => []);
  let tIdx = 0;

  for (const lw of lyricWords) {
    if (!lw.norm) continue;
    const LOOK = 15;
    for (let t = tIdx; t < Math.min(tIdx + LOOK, allTimings.length); t++) {
      if (normWord(allTimings[t].word) === lw.norm) {
        sectionWordTimings[lw.sectionIdx].push(allTimings[t]);
        tIdx = t + 1;
        break;
      }
    }
  }

  // Compute raw start/end from matched words
  const rich = sections.map((s, i) => {
    const words = sectionWordTimings[i];
    return {
      ...s,
      words,
      rawStart: words.length ? words[0].start        : null,
      rawEnd:   words.length ? words[words.length - 1].end : null,
    };
  });

  // Extend each section's clip to the next section's start (fills gaps / instrumentals).
  // Last section extends to end of song.
  return rich.map((s, i) => {
    const clipStart = s.rawStart ?? 0;
    const clipEnd   = i < rich.length - 1
      ? (rich[i + 1].rawStart ?? s.rawEnd ?? songDuration)
      : songDuration;
    return { ...s, clipStart, clipEnd, clipDuration: Math.max(0.1, clipEnd - clipStart) };
  });
}

// ─── Text layout utilities ─────────────────────────────────────────────────────
// Replicates the storybook word-wrap + box layout so karaoke highlights align.

const ARIAL_WIDTHS = {
  ' ':0.278,'!':0.278,'"':0.355,'#':0.556,'$':0.556,'%':0.889,
  '&':0.667,"'":0.222,'(':0.333,')':0.333,'*':0.389,
  '+':0.584,',':0.278,'-':0.333,'.':0.278,'/':0.278,
  '0':0.556,'1':0.556,'2':0.556,'3':0.556,'4':0.556,
  '5':0.556,'6':0.556,'7':0.556,'8':0.556,'9':0.556,
  ':':0.278,';':0.278,'<':0.584,'=':0.584,'>':0.584,
  '?':0.556,'@':1.015,
  'A':0.667,'B':0.667,'C':0.722,'D':0.722,'E':0.667,
  'F':0.611,'G':0.778,'H':0.722,'I':0.278,'J':0.500,
  'K':0.667,'L':0.611,'M':0.833,'N':0.722,'O':0.778,
  'P':0.667,'Q':0.778,'R':0.722,'S':0.667,'T':0.611,
  'U':0.722,'V':0.667,'W':0.944,'X':0.667,'Y':0.667,
  'Z':0.611,'[':0.278,'\\':0.278,']':0.278,'^':0.469,'_':0.556,
  '`':0.333,
  'a':0.556,'b':0.556,'c':0.500,'d':0.556,'e':0.556,
  'f':0.278,'g':0.556,'h':0.556,'i':0.222,'j':0.222,
  'k':0.500,'l':0.222,'m':0.833,'n':0.556,'o':0.556,
  'p':0.556,'q':0.556,'r':0.333,'s':0.500,'t':0.278,
  'u':0.556,'v':0.500,'w':0.722,'x':0.500,'y':0.500,
  'z':0.500,'{':0.334,'|':0.260,'}':0.334,'~':0.584,
};

function arialPx(str, fontSize) {
  let w = 0;
  for (const ch of str) w += (ARIAL_WIDTHS[ch] ?? 0.556) * fontSize;
  return w;
}

function wrapWords(text, maxCharsPerLine) {
  const result = [];
  for (const para of text.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = [], lineLen = 0;
    for (const word of words) {
      const testLen = lineLen === 0 ? word.length : lineLen + 1 + word.length;
      if (testLen > maxCharsPerLine && line.length > 0) {
        result.push(line);
        line = [word];
        lineLen = word.length;
      } else {
        line.push(word);
        lineLen = testLen;
      }
    }
    if (line.length) result.push(line);
  }
  return result;
}

// Returns [{x, y, w, h, word, fontSize}] in canvas pixel coords.
function calcWordBoxes(text, layout, startFontSize) {
  const { x: txtX, y: txtY, w: W, h: H } = layout;
  const SCALE_V   = W / 2550;
  const mX        = Math.round(W * 0.04);
  const mY        = Math.round(H * 0.08);
  const availW    = W - mX * 2;
  const availH    = H - mY * 2;
  const GAP_RATIO = 0.4;
  const minFont   = Math.max(12, Math.round(18 * SCALE_V));
  const step      = Math.max(2,  Math.round(4  * SCALE_V));
  let fontSize    = startFontSize ?? Math.round(76 * SCALE_V);

  const coupletLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const hasCouplet   = coupletLines.length >= 2;
  let lineHeight, lineGroups, totalH;

  while (fontSize >= minFont) {
    lineHeight = Math.round(fontSize * 1.35);
    const maxChars = Math.floor(availW / (fontSize * 0.55));
    lineGroups = coupletLines.map(cl => wrapWords(cl, maxChars));
    const totalLines = lineGroups.reduce((s, g) => s + g.length, 0);
    const gapTotal   = hasCouplet ? (lineGroups.length - 1) * Math.round(lineHeight * GAP_RATIO) : 0;
    totalH = totalLines * lineHeight + gapTotal;
    if (totalH <= availH) break;
    fontSize -= step;
  }

  const gapPx  = hasCouplet ? Math.round(lineHeight * GAP_RATIO) : 0;
  const startY = mY + Math.round((availH - totalH) / 2) + fontSize;
  const spaceW = ARIAL_WIDTHS[' '] * fontSize;

  const boxes = [];
  let y = startY;
  lineGroups.forEach((group, gi) => {
    group.forEach(lineWords => {
      const wordPxWidths = lineWords.map(w => arialPx(w, fontSize));
      const linePixW = wordPxWidths.reduce((s, w) => s + w, 0)
                     + Math.max(0, lineWords.length - 1) * spaceW;
      const lineStartX = (W / 2) - (linePixW / 2);
      let xOff = 0;
      for (let wi = 0; wi < lineWords.length; wi++) {
        const wPx = wordPxWidths[wi];
        boxes.push({
          x: Math.round(txtX + lineStartX + xOff),
          y: Math.round(txtY + y - fontSize),
          w: Math.round(wPx),
          h: Math.round(fontSize * 1.2),
          word: lineWords[wi],
          fontSize,
        });
        xOff += wPx + spaceW;
      }
      y += lineHeight;
    });
    if (gi < lineGroups.length - 1) y += gapPx;
  });

  return boxes;
}

// ─── Karaoke filter builder ────────────────────────────────────────────────────
// Builds the FFmpeg drawbox highlight filter for a section.
// wordTimings are absolute times; timeOffset shifts them into clip-relative time.

async function buildKaraokeFilter(text, wordTimings, timeOffset, layout, startFontSize, canvasW, canvasH) {
  if (!wordTimings || !wordTimings.length) return { filter: '', wordFiles: [], overlays: [] };

  const wordBoxes = calcWordBoxes(text, layout, startFontSize);
  if (!wordBoxes.length) return { filter: '', wordFiles: [], overlays: [] };

  const rawColor = KARAOKE_COLOR.replace('#', '0x');
  const segments = [];
  const wordFiles = [];
  const overlays  = [];
  const n = Math.min(wordBoxes.length, wordTimings.length);

  for (let i = 0; i < n; i++) {
    const box = wordBoxes[i];
    const tim = wordTimings[i];
    const t0  = (tim.start - timeOffset);
    const t1  = (tim.end   - timeOffset);
    if (t1 <= t0 || t0 < 0) continue;
    const enable = `enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'`;

    if (HIGHLIGHT_STYLE === 'underline') {
      const lineH = Math.max(2, Math.round(box.fontSize * 0.07));
      const lineY = box.y + box.h - lineH;
      segments.push(`drawbox=x=${box.x}:y=${lineY}:w=${box.w}:h=${lineH}:color=${rawColor}@1.0:t=fill:${enable}`);
    } else if (HIGHLIGHT_STYLE === 'color') {
      const xmlWord = box.word.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const svgBuf = Buffer.from(
        `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
        `<text x="${box.x}" y="${box.y + box.fontSize}" text-anchor="start" ` +
        `font-family="Arial, Helvetica, sans-serif" font-size="${box.fontSize}" ` +
        `fill="${KARAOKE_COLOR}" stroke="${KARAOKE_COLOR}" stroke-width="1" ` +
        `paint-order="stroke fill">${xmlWord}</text></svg>`
      );
      const pngBuf  = await sharp(svgBuf).png().toBuffer();
      const pngPath = path.join(os.tmpdir(), `lv_overlay_${Date.now()}_${i}.png`);
      fs.writeFileSync(pngPath, pngBuf);
      wordFiles.push(pngPath);
      overlays.push({ pngPath, t0, t1 });
    } else {
      segments.push(`drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${rawColor}@0.4:t=fill:${enable}`);
    }
  }

  return { filter: segments.join(','), wordFiles, overlays };
}

// ─── Frame builders ────────────────────────────────────────────────────────────
// Build a static PNG frame compositing the image and text for one section.

function safeXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildTextSvg(text, W, H, startFontSize, textColor) {
  const mX = Math.round(W * 0.04);
  const mY = Math.round(H * 0.08);
  const availW = W - mX * 2;
  const availH = H - mY * 2;
  const GAP_RATIO = 0.4;
  const SCALE_V = W / 2550;
  const minFont = Math.max(12, Math.round(18 * SCALE_V));
  const step    = Math.max(2,  Math.round(4  * SCALE_V));
  let fontSize  = startFontSize;

  const coupletLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const hasCouplet   = coupletLines.length >= 2;
  let lineHeight, lineGroups, totalH;

  while (fontSize >= minFont) {
    lineHeight = Math.round(fontSize * 1.35);
    const maxChars = Math.floor(availW / (fontSize * 0.55));
    lineGroups = coupletLines.map(cl => wrapWords(cl, maxChars));
    const totalLines = lineGroups.reduce((s, g) => s + g.length, 0);
    const gapTotal   = hasCouplet ? (lineGroups.length - 1) * Math.round(lineHeight * GAP_RATIO) : 0;
    totalH = totalLines * lineHeight + gapTotal;
    if (totalH <= availH) break;
    fontSize -= step;
  }

  const gapPx  = hasCouplet ? Math.round(lineHeight * GAP_RATIO) : 0;
  const startY = mY + Math.round((availH - totalH) / 2) + fontSize;
  const tspans = [];
  let y = startY;

  lineGroups.forEach((group, gi) => {
    group.forEach(lineWords => {
      tspans.push(`<tspan x="${W / 2}" y="${y}">${safeXml(lineWords.join(' '))}</tspan>`);
      y += lineHeight;
    });
    if (gi < lineGroups.length - 1) y += gapPx;
  });

  return Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${W / 2}" y="${startY}" text-anchor="middle" ` +
    `font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="${fontSize}" font-weight="normal" fill="${textColor}">${tspans.join('')}</text></svg>`
  );
}

async function buildLandscapeFrame(imagePath, text) {
  const tmpPath = path.join(os.tmpdir(), `lv_land_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const imgBuf  = await sharp(imagePath).resize(LAND_IMG_W, LAND_H, { fit: 'cover', position: 'centre' }).png().toBuffer();
  const txtSvg  = buildTextSvg(text, LAND_TXT_W, LAND_TXT_H, LAND_FONT, LAND_TEXT_COLOR);
  const txtBuf  = await sharp({ create: { width: LAND_TXT_W, height: LAND_TXT_H, channels: 4, background: LAND_TEXT_BG } })
    .composite([{ input: txtSvg, top: 0, left: 0 }]).png().toBuffer();
  await sharp({ create: { width: LAND_W, height: LAND_H, channels: 4, background: '#ffffff' } })
    .composite([{ input: imgBuf, top: 0, left: 0 }, { input: txtBuf, top: LAND_TXT_Y, left: LAND_TXT_X }])
    .png().toFile(tmpPath);
  return tmpPath;
}

async function buildPortraitFrame(imagePath, text) {
  const tmpPath = path.join(os.tmpdir(), `lv_port_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const imgBuf  = await sharp(imagePath).resize(PORT_W, PORT_IMG_H, { fit: 'cover', position: 'centre' }).png().toBuffer();
  const txtSvg  = buildTextSvg(text, PORT_TXT_W, PORT_TXT_H, PORT_FONT, PORT_TEXT_COLOR);
  const txtBuf  = await sharp({ create: { width: PORT_TXT_W, height: PORT_TXT_H, channels: 4, background: PORT_TEXT_BG } })
    .composite([{ input: txtSvg, top: 0, left: 0 }]).png().toBuffer();
  await sharp({ create: { width: PORT_W, height: PORT_H, channels: 4, background: '#ffffff' } })
    .composite([{ input: imgBuf, top: 0, left: 0 }, { input: txtBuf, top: PORT_TXT_Y, left: PORT_TXT_X }])
    .png().toFile(tmpPath);
  return tmpPath;
}

// ─── Clip builder ──────────────────────────────────────────────────────────────
// Builds a silent video clip from a static frame PNG with karaoke highlights.

async function buildClip(framePath, duration, canvasW, canvasH, vFilter, highlightFilter, overlays, outPath) {
  if (fs.existsSync(outPath)) return;

  const filterScript = path.join(os.tmpdir(), `lv_clip_${Date.now()}.txt`);
  let filterContent;

  if (overlays.length > 0) {
    const lines = [`[0:v]${vFilter}[base]`];
    let prev = 'base';
    for (let idx = 0; idx < overlays.length; idx++) {
      const ov  = overlays[idx];
      const cur = idx === overlays.length - 1 ? 'vout' : `v${idx}`;
      lines.push(`[${prev}][${idx + 1}:v]overlay=enable='between(t,${ov.t0.toFixed(3)},${ov.t1.toFixed(3)})'[${cur}]`);
      prev = cur;
    }
    filterContent = lines.join(';\n');
  } else {
    const full = highlightFilter ? `${vFilter},${highlightFilter}` : vFilter;
    filterContent = `[0:v]${full}[vout]`;
  }

  fs.writeFileSync(filterScript, filterContent, 'utf8');
  const extraInputs = overlays.flatMap(ov => ['-i', ov.pngPath]);
  try {
    await ffmpeg(
      '-loop', '1', '-i', framePath,
      ...extraInputs,
      '-/filter_complex', filterScript,
      '-map', '[vout]',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', outPath
    );
  } finally {
    try { fs.unlinkSync(filterScript); } catch {}
  }
}

// ─── Video assembly ────────────────────────────────────────────────────────────
// Crossfades all section clips together, then overlays the song audio.

async function assembleVideo(clips, audioPath, songDuration, outPath) {
  const N = clips.length;
  const tmpVideo = outPath + '_video.mp4';
  const tmpFinal = outPath + '_tmp.mp4';

  // Step 1: build video track with xfade=fade between sections
  if (N === 1) {
    await ffmpeg('-i', clips[0], '-c:v', 'copy', tmpVideo);
  } else {
    const inputs     = clips.flatMap(c => ['-i', c]);
    const vFilters   = [];
    let prevV        = '[0:v]';
    let offset       = 0;

    for (let i = 0; i < N - 1; i++) {
      const clipDur = await getMediaDuration(clips[i]);
      offset += clipDur - SECTION_XFADE_S;
      const last = i === N - 2;
      const vOut = last ? '[vfinal]' : `[v${i + 1}]`;
      vFilters.push(`${prevV}[${i + 1}:v]xfade=transition=fade:duration=${SECTION_XFADE_S}:offset=${offset.toFixed(3)}${vOut}`);
      prevV = vOut;
    }

    await ffmpeg(
      ...inputs,
      '-filter_complex', vFilters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', tmpVideo
    );
  }

  // Step 2: overlay song audio, trim to the shorter of video/audio
  try {
    await ffmpeg(
      '-i', tmpVideo,
      '-i', audioPath,
      '-filter_complex',
        `[1:a]volume=${MUSIC_VOLUME}[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
      '-shortest',
      tmpFinal
    );
  } finally {
    try { fs.unlinkSync(tmpVideo); } catch {}
  }

  try { fs.unlinkSync(outPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.renameSync(tmpFinal, outPath);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, lyricsPath, audioPath, imagePath, outputDir = '.'] = process.argv;

  if (!lyricsPath || !audioPath || !imagePath) {
    console.error('Usage: node lyrics-video.js <lyrics.txt> <audio.(mp3|wav)> <image.(png|jpg)> [output-dir]');
    process.exit(1);
  }

  for (const f of [lyricsPath, audioPath, imagePath]) {
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // ── Parse lyrics ─────────────────────────────────────────────────────────────
  const raw      = fs.readFileSync(lyricsPath, 'utf8');
  const sections = parseLyrics(raw);
  if (!sections.length) throw new Error('No lyric sections found in lyrics file.');
  console.log(`Parsed ${sections.length} sections.`);

  // ── Align timings ─────────────────────────────────────────────────────────────
  const allTimings   = await getWordTimings(audioPath, outputDir);
  const songDuration = await getMediaDuration(audioPath);
  const richSections = mapTimingsToSections(sections, allTimings, songDuration);

  console.log('\nSection timing map:');
  richSections.forEach(s => {
    console.log(`  [${s.label}] ${s.clipStart.toFixed(2)}s → ${s.clipEnd.toFixed(2)}s  (${s.words.length} words matched)`);
  });

  // ── Build landscape clips ──────────────────────────────────────────────────────
  console.log('\nBuilding landscape (16:9) clips...');
  const landClips   = [];
  const landLayout  = { x: LAND_TXT_X, y: LAND_TXT_Y, w: LAND_TXT_W, h: LAND_TXT_H };
  const tmpFrames   = [];

  for (let i = 0; i < richSections.length; i++) {
    const s         = richSections[i];
    const framePath = await buildLandscapeFrame(imagePath, s.text);
    tmpFrames.push(framePath);
    const clipPath  = path.join(outputDir, `land_clip_${String(i).padStart(2, '0')}.mp4`);
    const vFilter   = `scale=${LAND_W}:${LAND_H}`;

    const { filter, wordFiles, overlays } = await buildKaraokeFilter(
      s.text, s.words, s.clipStart, landLayout, LAND_FONT, LAND_W, LAND_H
    );
    process.stdout.write(`  Section ${i + 1}/${richSections.length} [${s.label}]... `);
    await buildClip(framePath, s.clipDuration, LAND_W, LAND_H, vFilter, filter, overlays, clipPath);
    for (const wf of wordFiles) try { fs.unlinkSync(wf); } catch {}
    landClips.push(clipPath);
    console.log('done');
  }

  // ── Build portrait clips ───────────────────────────────────────────────────────
  console.log('\nBuilding portrait (9:16) clips...');
  const portClips  = [];
  const portLayout = { x: PORT_TXT_X, y: PORT_TXT_Y, w: PORT_TXT_W, h: PORT_TXT_H };

  for (let i = 0; i < richSections.length; i++) {
    const s         = richSections[i];
    const framePath = await buildPortraitFrame(imagePath, s.text);
    tmpFrames.push(framePath);
    const clipPath  = path.join(outputDir, `port_clip_${String(i).padStart(2, '0')}.mp4`);
    const vFilter   = `scale=${PORT_W}:${PORT_H}`;

    const { filter, wordFiles, overlays } = await buildKaraokeFilter(
      s.text, s.words, s.clipStart, portLayout, PORT_FONT, PORT_W, PORT_H
    );
    process.stdout.write(`  Section ${i + 1}/${richSections.length} [${s.label}]... `);
    await buildClip(framePath, s.clipDuration, PORT_W, PORT_H, vFilter, filter, overlays, clipPath);
    for (const wf of wordFiles) try { fs.unlinkSync(wf); } catch {}
    portClips.push(clipPath);
    console.log('done');
  }

  // ── Assemble final videos ──────────────────────────────────────────────────────
  const baseName    = path.basename(audioPath, path.extname(audioPath));
  const landOutPath = path.join(outputDir, `${baseName}_16x9.mp4`);
  const portOutPath = path.join(outputDir, `${baseName}_9x16.mp4`);

  console.log('\nAssembling 16:9 landscape video...');
  await assembleVideo(landClips, audioPath, songDuration, landOutPath);
  console.log(`Done  →  ${landOutPath}`);

  console.log('Assembling 9:16 portrait video...');
  await assembleVideo(portClips, audioPath, songDuration, portOutPath);
  console.log(`Done  →  ${portOutPath}`);

  // ── Cleanup ────────────────────────────────────────────────────────────────────
  for (const f of [...tmpFrames, ...landClips, ...portClips]) {
    try { fs.unlinkSync(f); } catch {}
  }

  console.log('\nAll done!');
  console.log(`  16:9  →  ${landOutPath}`);
  console.log(`  9:16  →  ${portOutPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  });
}

module.exports = { parseLyrics, mapTimingsToSections, buildLandscapeFrame, buildPortraitFrame };
