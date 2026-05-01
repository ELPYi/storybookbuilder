#!/usr/bin/env node
/**
 * build-video.js
 * Builds an animated narrated video from the storybook pages.
 *
 * Requirements:
 *   - Run `npm run build-book` first (needs output/pages/*.png)
 *   - FFmpeg installed: sudo apt install ffmpeg
 *   - edge-tts installed: pipx install edge-tts
 *
 * Usage:
 *   npm run build-video
 *
 * Optional env overrides:
 *   VOICE_ID    edge-tts voice name (default: en-US-JennyNeural)
 *   MUSIC_PATH  Path to background music file
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp   = require('sharp');

const execFileAsync = promisify(execFile);

// ─── Config ────────────────────────────────────────────────────────────────────
// af_heart — warm, natural American female (Kokoro TTS, MIT licensed)
const VOICE_ID = process.env.VOICE_ID || 'af_heart';

// Font size maxima — must match the values used by build-book.js so karaoke boxes align
const FONT_COVER = parseInt(process.env.FONT_COVER || '90');
const FONT_STORY = parseInt(process.env.FONT_STORY || '76');

// Highlight style: 'box' | 'underline' | 'color'
const HIGHLIGHT_STYLE = process.env.HIGHLIGHT_STYLE || 'box';


// Pick music: MUSIC_PATH env override → random file from DATA_ROOT/music/
function resolveMusicPath() {
  if (process.env.MUSIC_PATH) return process.env.MUSIC_PATH;
  const musicDir = path.join(DATA_ROOT, 'music');
  if (fs.existsSync(musicDir)) {
    const files = fs.readdirSync(musicDir).filter(f =>
      /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f)
    );
    if (files.length) {
      const pick = files[Math.floor(Math.random() * files.length)];
      console.log(`Music: ${pick} (picked at random from music/)`);
      return path.join(musicDir, pick);
    }
  }
  throw new Error('No music files found. Add .mp3/.wav files to the music/ folder.');
}

const TTS_VOLUME   = parseFloat(process.env.TTS_VOLUME   || '1.0');
const MUSIC_VOLUME = parseFloat(process.env.MUSIC_VOLUME || '0.65');
const MUSIC_FADE      = 5;     // seconds for fade in / fade out
const MUSIC_LOOP_XFADE = 2;    // crossfade duration between music loops
const PAGE_PAUSE   = 1.5;   // silence after each narration before next page slides in
const STILL_SECS   = 3.0;   // display duration for non-narrated pages (title, copyright)
const TYPEWRITER_S = 2.0;   // seconds for the text wipe-reveal animation
const TRANSITION_S = 0.5;   // xfade slide transition duration between pages
const THUMBNAIL_SECS = 2.0; // duration of the thumbnail frame appended to the 9:16 Shorts video

const SHORTS_THUMBNAIL_PATH = process.env.SHORTS_THUMBNAIL_PATH || '';

// ─── Page dimensions (from book build settings) ────────────────────────────────
const DPI    = 300;
const BLEED  = Math.round(0.125 * DPI);  // 38px — always 0.125" at 300 DPI

// These are set dynamically in initDimensions() after reading the first PNG
let PAGE_W, PAGE_H, vidW, vidH, VIDEO_SIZE, TXT_X, TXT_Y, TXT_W, TXT_H;

// ─── Portrait (9:16 Shorts) constants ─────────────────────────────────────────
const PORT_W         = 1080;
const PORT_H         = 1920;
const PORT_IMG_RATIO = parseFloat(process.env.PORT_IMG_RATIO || '0.6');
const PORT_IMG_H     = Math.round(PORT_H * PORT_IMG_RATIO);
const PORT_TXT_X     = 0;
const PORT_TXT_Y     = PORT_IMG_H;
const PORT_TXT_W     = PORT_W;
const PORT_TXT_H     = PORT_H - PORT_IMG_H;
const PORT_FONT_COVER        = parseInt(process.env.PORT_FONT_COVER        || '90');
const PORT_FONT_STORY        = parseInt(process.env.PORT_FONT_STORY        || '80');
const PORT_TEXT_COLOR_COVER  = process.env.PORT_TEXT_COLOR_COVER  || '#000000';
const PORT_TEXT_COLOR_STORY  = process.env.PORT_TEXT_COLOR_STORY  || '#000000';
const PORT_TEXT_BG           = process.env.PORT_TEXT_BG           || '#ffffff';

// Landscape (16:9) constants: left image, right text.
const LAND_W         = 1920;
const LAND_H         = 1080;
const LAND_IMG_RATIO = parseFloat(process.env.LAND_IMG_RATIO || '0.6');
const LAND_IMG_W     = Math.round(LAND_W * LAND_IMG_RATIO);
const LAND_TXT_X     = LAND_IMG_W;
const LAND_TXT_Y     = 0;
const LAND_TXT_W     = LAND_W - LAND_IMG_W;
const LAND_TXT_H     = LAND_H;
const LAND_FONT_COVER        = parseInt(process.env.LAND_FONT_COVER        || '90');
const LAND_FONT_STORY        = parseInt(process.env.LAND_FONT_STORY        || '48');
const LAND_TEXT_COLOR_COVER  = process.env.LAND_TEXT_COLOR_COVER  || '#000000';
const LAND_TEXT_COLOR_STORY  = process.env.LAND_TEXT_COLOR_STORY  || '#000000';
const LAND_TEXT_BG           = process.env.LAND_TEXT_BG           || '#ffffff';

async function initDimensions(firstImgPath) {
  // Always detect from the actual PNG — settings-passed env vars may reflect a different
  // page size than what was actually rendered, so we trust the file on disk.
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    firstImgPath
  ]);
  const [imgW, imgH] = stdout.trim().split(',').map(Number);
  // Crop out the bleed border — content area is the image minus one bleed on each side
  PAGE_W = imgW - 2 * BLEED;
  PAGE_H = imgH - 2 * BLEED;
  console.log(`Detected image ${imgW}x${imgH}, content area ${PAGE_W}x${PAGE_H}`);

  // Scale page to fit within 1920×1080, preserving aspect ratio.
  // Landscape pages fill the full 16:9 frame; portrait/square pages fill 1080px tall.
  const MAX_W = 1920;
  const MAX_H = 1080;
  const pageScale = Math.min(MAX_W / PAGE_W, MAX_H / PAGE_H);
  vidW = Math.round(PAGE_W * pageScale);
  vidH = Math.round(PAGE_H * pageScale);
  vidW += vidW % 2;  // h264 requires even dimensions
  vidH += vidH % 2;
  VIDEO_SIZE = `${vidW}:${vidH}`;

  // Text box in video pixels (used by the typewriter reveal and word highlights).
  // Always read from the layout saved during the last Build Book run so that
  // highlight positions exactly match the text positions on the rendered pages,
  // even if the user has changed the layout setting since then.
  const DEFAULT_LAYOUT = {
    imageBox: { x: 0.03, y: 0.03, w: 0.94, h: 0.56 },
    textBox:  { x: 0.03, y: 0.61, w: 0.94, h: 0.36 },
  };
  const pagesLayoutFile = path.join(OUTPUT_PAGES_DIR, '.build-layout.json');
  const layout = (() => {
    // Prefer the layout stamped by the last Build Book run (guaranteed to match the pages).
    if (fs.existsSync(pagesLayoutFile)) {
      try { return JSON.parse(fs.readFileSync(pagesLayoutFile, 'utf8')); } catch {}
    }
    // Fall back to the env var (passed from app settings) or the hard-coded default.
    try { return process.env.STORYBOOK_LAYOUT ? JSON.parse(process.env.STORYBOOK_LAYOUT) : DEFAULT_LAYOUT; }
    catch { return DEFAULT_LAYOUT; }
  })();
  TXT_X = Math.round(layout.textBox.x * vidW);
  TXT_Y = Math.round(layout.textBox.y * vidH);
  TXT_W = Math.round(layout.textBox.w * vidW);
  TXT_H = Math.round(layout.textBox.h * vidH);
}

// ─── Layout (text box position for typewriter effect) ──────────────────────────
// (computed in initDimensions above)

// ─── Paths ─────────────────────────────────────────────────────────────────────
const ROOT             = path.resolve(__dirname, '..');
const DATA_ROOT        = process.env.STORYBOOK_DATA_ROOT || ROOT;
const INPUT_TXT        = path.join(DATA_ROOT, 'input', 'book.txt');
const INPUT_IMG_DIR    = path.join(DATA_ROOT, 'input', 'images');
const OUTPUT_DIR       = path.join(DATA_ROOT, 'output');
const OUTPUT_PAGES_DIR = path.join(OUTPUT_DIR, 'pages');
const OUTPUT_VIDEO_DIR = path.join(OUTPUT_DIR, 'video');
function titleToSlug(title) {
  return title.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function computeImagesHash(imagesDir) {
  if (!fs.existsSync(imagesDir)) return '';
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const files = fs.readdirSync(imagesDir)
    .filter(f => exts.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const full = path.join(imagesDir, f);
    const st = fs.statSync(full);
    h.update(`${f}|${st.size}|${st.mtimeMs}\n`);
  }
  return h.digest('hex');
}

function listInputImages(imagesDir) {
  if (!fs.existsSync(imagesDir)) return [];
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  return fs.readdirSync(imagesDir)
    .filter(f => exts.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map(f => path.join(imagesDir, f));
}

function buildPageImageMap(pages) {
  const imagePages = pages.filter(p => p.number !== 2); // title page is text-only
  const images = listInputImages(INPUT_IMG_DIR);
  const map = new Map();
  imagePages.forEach((p, idx) => {
    if (idx < images.length) map.set(p.number, images[idx]);
  });
  return map;
}

function ffmpeg(...args) {
  return execFileAsync('ffmpeg', ['-y', ...args], { maxBuffer: 100 * 1024 * 1024 });
}

async function getMediaDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const dur = parseFloat(stdout.trim());
  if (!isFinite(dur)) throw new Error(`Could not read duration of "${path.basename(filePath)}" — the file may be corrupt or empty.`);
  return dur;
}

// ─── Book text parser ──────────────────────────────────────────────────────────
// Lines that signal we've left the story text area (Gemini Gem section headers).
const TEXT_STOP_RE = /^(Image\s*:|Visual\s+Description\s*:|AI\s+Image\s+Prompt\s*:|Part\s+\d+\s*:|Character\s+Sheet\s*:|Marketing\s+Copy\s*:|Back\s+Cover\s*:|---)/i;

function stripMarkdown(line) {
  return line
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g,     '$1')
    .replace(/_{2}([^_\n]+)_{2}/g, '$1')
    .replace(/^#{1,6}\s+/,          '');
}

function parseBookTxt(content) {
  const pages = [];
  const lines = content.split(/\r?\n/);
  let currentPage = null;
  let collectingText = false;
  let textLines = [];

  const flushText = () => {
    if (currentPage && textLines.length) {
      currentPage.text = textLines.join('\n').trim();
      textLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = stripMarkdown(rawLine).trim();
    const pageMatch = /^Page\s+(\d+)\s*:/i.exec(line);
    if (pageMatch) {
      flushText();
      if (currentPage) pages.push(currentPage);
      currentPage = { number: Number(pageMatch[1]), text: '' };
      collectingText = false;
      continue;
    }
    if (!currentPage) continue;
    const textMatch = /^Text[^:]*:\s*(.*)/i.exec(line);
    if (textMatch) {
      collectingText = true;
      const inline = textMatch[1].trim();
      if (inline) textLines.push(inline);
      continue;
    }
    // Stop collecting on Image: or any Gem section header
    if (TEXT_STOP_RE.test(line)) { collectingText = false; continue; }
    if (collectingText && line) {
      // Line 1: / Line 2: labels — strip the label, keep only the text content
      const coupletMatch = /^Line\s*\d+\s*:\s*(.*)/i.exec(line);
      textLines.push(coupletMatch ? coupletMatch[1].trim() : line);
    }
  }

  flushText();
  if (currentPage) pages.push(currentPage);
  return pages.filter(p => p.text && p.text.trim().length > 0);
}

// ─── TTS ───────────────────────────────────────────────────────────────────────
async function generateTTS(text, outPath) {
  if (fs.existsSync(outPath)) return; // use cached file
  // Use py launcher to target Python 3.12 where kokoro/misaki are installed
  const python = 'py';
  await execFileAsync(python, [
    '-3.12',
    path.join(__dirname, 'tts.py'),
    text,
    VOICE_ID,
    outPath
  ], { maxBuffer: 10 * 1024 * 1024 });
}

// ─── Word-level highlight support ─────────────────────────────────────────────

/**
 * Per-character advance widths for Arial Regular, expressed as a fraction of
 * the font size (em). Sourced from Arial's standard PostScript/TrueType metrics.
 * Unknown characters fall back to the average width (0.556).
 */
const ARIAL_WIDTHS = {
  ' ':0.278,
  '!':0.278,'"':0.355,'#':0.556,'$':0.556,'%':0.889,
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
  'Z':0.611,
  '[':0.278,'\\':0.278,']':0.278,'^':0.469,'_':0.556,
  '`':0.333,
  'a':0.556,'b':0.556,'c':0.500,'d':0.556,'e':0.556,
  'f':0.278,'g':0.556,'h':0.556,'i':0.222,'j':0.222,
  'k':0.500,'l':0.222,'m':0.833,'n':0.556,'o':0.556,
  'p':0.556,'q':0.556,'r':0.333,'s':0.500,'t':0.278,
  'u':0.556,'v':0.500,'w':0.722,'x':0.500,'y':0.500,
  'z':0.500,
  '{':0.334,'|':0.260,'}':0.334,'~':0.584,
};

/**
 * Per-character advance widths for Arial Bold (fraction of font size).
 * Bold glyphs are measurably wider than Regular — using Regular metrics for
 * bold text would shift every word box to the left.
 */
const ARIAL_BOLD_WIDTHS = {
  ' ':0.278,
  '!':0.333,'"':0.474,'#':0.556,'$':0.556,'%':0.889,
  '&':0.722,"'":0.278,'(':0.333,')':0.333,'*':0.389,
  '+':0.584,',':0.333,'-':0.333,'.':0.278,'/':0.278,
  '0':0.556,'1':0.556,'2':0.556,'3':0.556,'4':0.556,
  '5':0.556,'6':0.556,'7':0.556,'8':0.556,'9':0.556,
  ':':0.333,';':0.333,'<':0.584,'=':0.584,'>':0.584,
  '?':0.611,'@':0.975,
  'A':0.722,'B':0.722,'C':0.722,'D':0.778,'E':0.667,
  'F':0.611,'G':0.778,'H':0.778,'I':0.278,'J':0.556,
  'K':0.722,'L':0.611,'M':0.833,'N':0.778,'O':0.833,
  'P':0.667,'Q':0.833,'R':0.722,'S':0.667,'T':0.611,
  'U':0.778,'V':0.667,'W':0.944,'X':0.667,'Y':0.667,
  'Z':0.611,
  '[':0.333,'\\':0.278,']':0.333,'^':0.584,'_':0.556,
  '`':0.278,
  'a':0.556,'b':0.611,'c':0.556,'d':0.611,'e':0.556,
  'f':0.333,'g':0.611,'h':0.611,'i':0.278,'j':0.278,
  'k':0.556,'l':0.278,'m':0.889,'n':0.611,'o':0.611,
  'p':0.611,'q':0.611,'r':0.389,'s':0.556,'t':0.333,
  'u':0.611,'v':0.556,'w':0.778,'x':0.556,'y':0.556,
  'z':0.500,
  '{':0.389,'|':0.280,'}':0.389,'~':0.584,
};

/** Returns the rendered pixel width of a string in Arial at the given font size. */
function arialPx(str, fontSize, bold = false) {
  const table = bold ? ARIAL_BOLD_WIDTHS : ARIAL_WIDTHS;
  let w = 0;
  for (const ch of str) w += (table[ch] ?? 0.556) * fontSize;
  return w;
}

/**
 * Wraps text into lines, returning each line as an array of word strings.
 * Mirrors the wrapText logic in build-book.js but keeps words separate.
 */
function wrapWords(text, maxCharsPerLine) {
  const result = [];
  for (const para of text.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = [];
    let lineLen = 0;
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

/**
 * Replicates build-book.js svgTextBlock layout in video pixel space.
 * Returns [{x, y, w, h}] — one box per word, in video pixel coordinates.
 * Must be called after initDimensions() has set TXT_X/Y/W/H and vidW.
 */
// portLayout: optional { x, y, w, h } override for portrait mode; uses globals when omitted.
function calcWordBoxes(text, { bold = false, startFontSize, portLayout } = {}) {
  const txtX   = portLayout ? portLayout.x : TXT_X;
  const txtY   = portLayout ? portLayout.y : TXT_Y;
  const W      = portLayout ? portLayout.w : TXT_W;
  const H      = portLayout ? portLayout.h : TXT_H;
  const SCALE_V = portLayout ? (W / 2550) : (vidW / 2550);
  const mX = Math.round(W * 0.04);
  const mY = Math.round(H * 0.08);
  const availW = W - mX * 2;
  const availH = H - mY * 2;
  const GAP_RATIO = 0.4;
  const minFont   = Math.max(12, Math.round(18 * SCALE_V));
  const step      = Math.max(2,  Math.round(4  * SCALE_V));
  let fontSize    = startFontSize !== undefined ? startFontSize : Math.round(76 * SCALE_V);

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
  // Use Arial's actual space width for inter-word gaps (bold space is same as regular)
  const spaceW = ARIAL_WIDTHS[' '] * fontSize;  // 0.278 × fontSize

  const boxes = [];
  let y = startY;
  lineGroups.forEach((group, gi) => {
    group.forEach(lineWords => {
      // Measure each word with per-character Arial widths for accurate centering
      const wordPxWidths = lineWords.map(w => arialPx(w, fontSize, bold));
      const linePixW = wordPxWidths.reduce((s, w) => s + w, 0)
                     + Math.max(0, lineWords.length - 1) * spaceW;
      // SVG uses text-anchor="middle" at the centre of the text box
      const lineStartX = (W / 2) - (linePixW / 2);
      let xOff = 0;
      for (let wi = 0; wi < lineWords.length; wi++) {
        const word = lineWords[wi];
        const wPx  = wordPxWidths[wi];
        boxes.push({
          x:        Math.round(txtX + lineStartX + xOff),
          y:        Math.round(txtY + y - fontSize),
          w:        Math.round(wPx),
          h:        Math.round(fontSize * 1.2),
          word:     word,
          fontSize: fontSize,
        });
        xOff += wPx + spaceW;
      }
      y += lineHeight;
    });
    if (gi < lineGroups.length - 1) y += gapPx;
  });

  return boxes;
}

/**
 * Ensures word-level timings exist for a .wav file.
 * If the JSON sidecar is missing or uses the old Kokoro-chunk format
 * (has a 'text' property instead of 'word'), runs faster-whisper to re-align.
 * Returns [{word, start, end}] array.
 */
async function ensureWordTimings(wavPath) {
  const jsonPath = wavPath.replace('.wav', '.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // New format has entries with a 'word' property; old Kokoro format has 'text'
      if (Array.isArray(data) && (data.length === 0 || data[0].word !== undefined)) {
        return data;
      }
    } catch {}
  }
  // Generate or upgrade with faster-whisper
  process.stdout.write('aligning... ');
  await execFileAsync('py', ['-3.12', path.join(__dirname, 'whisper_align.py'), wavPath, jsonPath],
    { maxBuffer: 10 * 1024 * 1024 });
  try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch { return []; }
}

/**
 * Builds word-highlight effects for a page clip.
 * - 'box' / 'underline': returns a drawbox FFmpeg filter string
 * - 'color': renders each word as a transparent PNG overlay (Sharp + SVG),
 *   returned in `overlays` for chaining via FFmpeg's overlay filter
 * Returns { filter, wordFiles, overlays }.
 */
async function buildKaraokeFilter(text, wordTimings, timeOffset, { bold = false, startFontSize, portLayout, canvasW, canvasH } = {}) {
  if (!wordTimings || !wordTimings.length) return { filter: '', wordFiles: [], overlays: [] };

  const wordBoxes = calcWordBoxes(text, { bold, startFontSize, portLayout });
  if (!wordBoxes.length) return { filter: '', wordFiles: [], overlays: [] };

  const rawColorHex = process.env.KARAOKE_COLOR || '#FF8800';
  const rawColor    = rawColorHex.replace('#', '0x');
  const style       = HIGHLIGHT_STYLE;

  const segments  = [];
  const wordFiles = [];
  const overlays  = [];
  const n = Math.min(wordBoxes.length, wordTimings.length);

  for (let i = 0; i < n; i++) {
    const box = wordBoxes[i];
    const tim = wordTimings[i];
    const t0  = timeOffset + tim.start;
    const t1  = timeOffset + tim.end;
    if (t1 <= t0) continue;
    const enable = `enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'`;

    if (style === 'underline') {
      const lineH = Math.max(2, Math.round(box.fontSize * 0.07));
      const lineY = box.y + box.h - lineH;
      segments.push(
        `drawbox=x=${box.x}:y=${lineY}:w=${box.w}:h=${lineH}` +
        `:color=${rawColor}@1.0:t=fill:${enable}`
      );

    } else if (style === 'color') {
      // Render each word as a transparent PNG overlay using Sharp + SVG.
      // This completely avoids FFmpeg drawtext and all its Windows path/escaping issues.
      // The overlay: white rect (erases original text) + word in highlight color.
      const xmlWord = box.word
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const svgFrameW = canvasW || (portLayout ? PORT_W : vidW);
      const svgFrameH = canvasH || (portLayout ? PORT_H : vidH);
      const svgBuf = Buffer.from(
        `<svg width="${svgFrameW}" height="${svgFrameH}" xmlns="http://www.w3.org/2000/svg">` +
        `<text x="${box.x}" y="${box.y + box.fontSize}" ` +
        `text-anchor="start" ` +
        `font-family="Arial, Helvetica, sans-serif" ` +
        `font-size="${box.fontSize}" ` +
        `font-weight="${bold ? 'bold' : 'normal'}" ` +
        `fill="${rawColorHex}" ` +
        `stroke="${rawColorHex}" stroke-width="1" paint-order="stroke fill">${xmlWord}</text>` +
        `</svg>`
      );
      const pngBuf  = await sharp(svgBuf).png().toBuffer();
      const pngPath = path.join(os.tmpdir(), `sb_overlay_${Date.now()}_${i}.png`);
      fs.writeFileSync(pngPath, pngBuf);
      wordFiles.push(pngPath);
      overlays.push({ pngPath, t0, t1 });

    } else {
      // Box (default / fallback)
      segments.push(
        `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}` +
        `:color=${rawColor}@0.4:t=fill:${enable}`
      );
    }
  }
  return { filter: segments.join(','), wordFiles, overlays };
}

// ─── Portrait frame builder ────────────────────────────────────────────────────

function safeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Looks up the original source image for a page number in input/images/.
function findSourceImage(pageNumber, pageImageMap) {
  return pageImageMap.get(pageNumber) || null;
}

// Generates an SVG text block for the portrait text area using the same layout
// algorithm as calcWordBoxes, so karaoke boxes align with the rendered text.
function buildPortraitSvgText(text, { bold = false, startFontSize = 80, textColor = '#000000' } = {}) {
  const W = PORT_TXT_W;
  const H = PORT_TXT_H;
  const mX = Math.round(W * 0.04);
  const mY = Math.round(H * 0.08);
  const availW = W - mX * 2;
  const availH = H - mY * 2;
  const GAP_RATIO = 0.4;
  const SCALE_V = PORT_W / 2550;
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
    `font-size="${fontSize}" font-weight="${bold ? 'bold' : 'normal'}" ` +
    `fill="${textColor}">${tspans.join('')}</text>` +
    `</svg>`
  );
}

// Landscape text SVG using the same fitting logic as portrait/calcWordBoxes.
function buildLandscapeSvgText(text, { bold = false, startFontSize = 80, textColor = '#000000' } = {}) {
  const W = LAND_TXT_W;
  const H = LAND_TXT_H;
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
    `font-size="${fontSize}" font-weight="${bold ? 'bold' : 'normal'}" ` +
    `fill="${textColor}">${tspans.join('')}</text>` +
    `</svg>`
  );
}

// Builds a 1080×1920 portrait frame PNG: source image fills the top half,
// text rendered on a white background fills the bottom half.
async function buildPortraitFrame(srcImgPath, text, { isCover = false, textColor = '#000000' } = {}) {
  const tmpPath = path.join(os.tmpdir(), `sb_port_frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const startFontSize = isCover ? PORT_FONT_COVER : PORT_FONT_STORY;

  // Top half: source image, cropped/scaled to fill PORT_W × PORT_IMG_H
  const imgBuf = await sharp(srcImgPath)
    .resize(PORT_W, PORT_IMG_H, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // Bottom half: white background + text SVG
  const textSvg = buildPortraitSvgText(text, { bold: isCover, startFontSize, textColor });
  const textBuf = await sharp({
    create: { width: PORT_TXT_W, height: PORT_TXT_H, channels: 4, background: PORT_TEXT_BG },
  })
    .composite([{ input: textSvg, top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Composite: image on top, text below
  await sharp({
    create: { width: PORT_W, height: PORT_H, channels: 4, background: '#ffffff' },
  })
    .composite([
      { input: imgBuf,  top: 0,          left: 0 },
      { input: textBuf, top: PORT_IMG_H, left: 0 },
    ])
    .png()
    .toFile(tmpPath);

  return tmpPath;
}

// Builds a 1920×1080 landscape frame PNG: source image fills left 60%,
// text rendered on a white background fills right 40%.
async function buildLandscapeFrame(srcImgPath, text, { isCover = false, textColor = '#000000' } = {}) {
  const tmpPath = path.join(os.tmpdir(), `sb_land_frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const startFontSize = isCover ? LAND_FONT_COVER : LAND_FONT_STORY;

  const imgBuf = await sharp(srcImgPath)
    .resize(LAND_IMG_W, LAND_H, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const textSvg = buildLandscapeSvgText(text, { bold: isCover, startFontSize, textColor });
  const textBuf = await sharp({
    create: { width: LAND_TXT_W, height: LAND_TXT_H, channels: 4, background: LAND_TEXT_BG },
  })
    .composite([{ input: textSvg, top: 0, left: 0 }])
    .png()
    .toBuffer();

  await sharp({
    create: { width: LAND_W, height: LAND_H, channels: 4, background: '#ffffff' },
  })
    .composite([
      { input: imgBuf,  top: 0,          left: 0 },
      { input: textBuf, top: LAND_TXT_Y, left: LAND_TXT_X },
    ])
    .png()
    .toFile(tmpPath);

  return tmpPath;
}

// Builds a portrait video clip from a portrait frame PNG (no bleed, already PORT_W×PORT_H).
async function buildPortraitClip(portFramePath, duration, hasTypewriter, outPath, highlightFilter = '', wordFiles = [], overlays = []) {
  if (fs.existsSync(outPath)) return;

  let vFilter = `scale=${PORT_W}:${PORT_H}`;

  if (hasTypewriter) {
    const twStart = TRANSITION_S;
    vFilter +=
      `,drawbox=` +
      `x='${PORT_TXT_X}+${PORT_TXT_W}*min(1,max(0,t-${twStart})/${TYPEWRITER_S})':` +
      `y=${PORT_TXT_Y}:` +
      `w='max(0,${PORT_TXT_W}*(1-min(1,max(0,t-${twStart})/${TYPEWRITER_S})))':` +
      `h=${PORT_TXT_H}:` +
      `color=white@1:t=fill:` +
      `enable='lte(t,${twStart + TYPEWRITER_S})'`;
  }

  const filterScript = path.join(os.tmpdir(), `sb_portclip_${Date.now()}.txt`);
  let filterContent;

  if (overlays.length > 0) {
    const lines = [];
    lines.push(`[0:v]${vFilter}[base]`);
    let prev = 'base';
    for (let idx = 0; idx < overlays.length; idx++) {
      const ov  = overlays[idx];
      const cur = idx === overlays.length - 1 ? 'vout' : `v${idx}`;
      lines.push(
        `[${prev}][${idx + 1}:v]overlay=enable='between(t,${ov.t0.toFixed(3)},${ov.t1.toFixed(3)})'[${cur}]`
      );
      prev = cur;
    }
    filterContent = lines.join(';\n');
  } else {
    if (highlightFilter) vFilter += ',' + highlightFilter;
    filterContent = `[0:v]${vFilter}[vout]`;
  }

  fs.writeFileSync(filterScript, filterContent, 'utf8');
  try {
    const extraInputs = overlays.flatMap(ov => ['-i', ov.pngPath]);
    await ffmpeg(
      '-loop', '1', '-i', portFramePath,
      ...extraInputs,
      '-/filter_complex', filterScript,
      '-map', '[vout]',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', outPath
    );
  } finally {
    try { fs.unlinkSync(filterScript); } catch {}
    for (const wf of wordFiles) try { fs.unlinkSync(wf); } catch {}
  }
}

// Builds a landscape video clip from a 1920x1080 landscape frame PNG.
async function buildLandscapeClip(landFramePath, duration, hasTypewriter, outPath, highlightFilter = '', wordFiles = [], overlays = []) {
  if (fs.existsSync(outPath)) return;

  let vFilter = `scale=${LAND_W}:${LAND_H}`;

  if (hasTypewriter) {
    const twStart = TRANSITION_S;
    vFilter +=
      `,drawbox=` +
      `x='${LAND_TXT_X}+${LAND_TXT_W}*min(1,max(0,t-${twStart})/${TYPEWRITER_S})':` +
      `y=${LAND_TXT_Y}:` +
      `w='max(0,${LAND_TXT_W}*(1-min(1,max(0,t-${twStart})/${TYPEWRITER_S})))':` +
      `h=${LAND_TXT_H}:` +
      `color=white@1:t=fill:` +
      `enable='lte(t,${twStart + TYPEWRITER_S})'`;
  }

  const filterScript = path.join(os.tmpdir(), `sb_landclip_${Date.now()}.txt`);
  let filterContent;

  if (overlays.length > 0) {
    const lines = [];
    lines.push(`[0:v]${vFilter}[base]`);
    let prev = 'base';
    for (let idx = 0; idx < overlays.length; idx++) {
      const ov  = overlays[idx];
      const cur = idx === overlays.length - 1 ? 'vout' : `v${idx}`;
      lines.push(
        `[${prev}][${idx + 1}:v]overlay=enable='between(t,${ov.t0.toFixed(3)},${ov.t1.toFixed(3)})'[${cur}]`
      );
      prev = cur;
    }
    filterContent = lines.join(';\n');
  } else {
    if (highlightFilter) vFilter += ',' + highlightFilter;
    filterContent = `[0:v]${vFilter}[vout]`;
  }

  fs.writeFileSync(filterScript, filterContent, 'utf8');
  try {
    const extraInputs = overlays.flatMap(ov => ['-i', ov.pngPath]);
    await ffmpeg(
      '-loop', '1', '-i', landFramePath,
      ...extraInputs,
      '-/filter_complex', filterScript,
      '-map', '[vout]',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', outPath
    );
  } finally {
    try { fs.unlinkSync(filterScript); } catch {}
    for (const wf of wordFiles) try { fs.unlinkSync(wf); } catch {}
  }
}

// ─── Video-only clip builder ───────────────────────────────────────────────────
// Builds a silent video clip from a still image with optional typewriter effect.
// Audio is handled separately in the final assembly for precise sync.
async function buildClip(imgPath, duration, hasTypewriter, outPath, highlightFilter = '', wordFiles = [], overlays = []) {
  if (fs.existsSync(outPath)) return;

  // Crop bleed → scale to target video size
  let vFilter = `crop=${PAGE_W}:${PAGE_H}:${BLEED}:${BLEED},scale=${VIDEO_SIZE}`;

  if (hasTypewriter) {
    const twStart = TRANSITION_S;
    const twEnd   = TRANSITION_S + TYPEWRITER_S;
    vFilter +=
      `,drawbox=` +
      `x='${TXT_X}+${TXT_W}*min(1,max(0,t-${twStart})/${TYPEWRITER_S})':` +
      `y=${TXT_Y}:` +
      `w='max(0,${TXT_W}*(1-min(1,max(0,t-${twStart})/${TYPEWRITER_S})))':` +
      `h=${TXT_H}:` +
      `color=white@1:t=fill:` +
      `enable='lte(t,${twEnd})'`;
  }

  const filterScript = path.join(os.tmpdir(), `sb_clip_${Date.now()}.txt`);
  let filterContent;

  if (overlays.length > 0) {
    // 'color' style: each word is a transparent PNG overlay composited over the video.
    // Chain: base video → overlay word0 (time-gated) → overlay word1 → … → [vout]
    const lines = [];
    lines.push(`[0:v]${vFilter}[base]`);
    let prev = 'base';
    for (let idx = 0; idx < overlays.length; idx++) {
      const ov  = overlays[idx];
      const cur = idx === overlays.length - 1 ? 'vout' : `v${idx}`;
      lines.push(
        `[${prev}][${idx + 1}:v]overlay=enable='between(t,${ov.t0.toFixed(3)},${ov.t1.toFixed(3)})'[${cur}]`
      );
      prev = cur;
    }
    filterContent = lines.join(';\n');
  } else {
    // 'box' / 'underline' styles: pure drawbox filter chain, no extra inputs needed.
    if (highlightFilter) vFilter += ',' + highlightFilter;
    filterContent = `[0:v]${vFilter}[vout]`;
  }

  fs.writeFileSync(filterScript, filterContent, 'utf8');
  try {
    const extraInputs = overlays.flatMap(ov => ['-i', ov.pngPath]);
    await ffmpeg(
      '-loop', '1', '-i', imgPath,
      ...extraInputs,
      '-/filter_complex', filterScript,
      '-map', '[vout]',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', outPath
    );
  } finally {
    try { fs.unlinkSync(filterScript); } catch {}
    for (const wf of wordFiles) try { fs.unlinkSync(wf); } catch {}
  }
}

// ─── Music loop builder ────────────────────────────────────────────────────────
/**
 * If the music track is shorter than targetDuration, concatenates enough copies
 * with a short crossfade at each join to fill the video.
 * Returns { path, isTemp } — caller must delete path if isTemp is true.
 */
async function buildLoopedMusicTrack(musicPath, targetDuration) {
  const musicDur = await getMediaDuration(musicPath);
  if (musicDur >= targetDuration) return { path: musicPath, isTemp: false };

  // Clamp crossfade to at most 25% of the track length so it never eats the whole clip
  const xfade = Math.min(MUSIC_LOOP_XFADE, musicDur * 0.25);
  const effectiveDur = musicDur - xfade;
  const loopCount = Math.ceil((targetDuration - xfade) / effectiveDur);

  console.log(`Music (${musicDur.toFixed(1)}s) shorter than video (${targetDuration.toFixed(1)}s) — looping ×${loopCount} with ${xfade}s crossfade`);

  const outPath = path.join(os.tmpdir(), `sb_music_looped_${Date.now()}.aac`);
  const inputs = [];
  for (let i = 0; i < loopCount; i++) inputs.push('-i', musicPath);

  const filterParts = [];
  let prev = '[0:a]';
  for (let i = 1; i < loopCount; i++) {
    const label = i === loopCount - 1 ? '[cfinal]' : `[cf${i}]`;
    filterParts.push(`${prev}[${i}:a]acrossfade=d=${xfade}:c1=tri:c2=tri${label}`);
    prev = label;
  }
  filterParts.push(`[cfinal]atrim=end=${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);

  await ffmpeg(
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'aac', '-b:a', '192k',
    outPath
  );

  return { path: outPath, isTemp: true };
}

// ─── Final assembly ────────────────────────────────────────────────────────────
/**
 * Assembles all clips into a final video with:
 *  - push-left xfade transitions on the video track
 *  - narrations placed at precise absolute times on the audio track
 *  - background music mixed in
 *
 * Each clip entry: { videoPath, ttsPaths: string[], duration, narrationStart }
 *   narrationStart: absolute time in the final video when narration should begin
 */
async function buildFinalVideo(clips, musicPath, outPath) {
  const N = clips.length;

  // ── Step 1: build video track with xfade transitions ──
  const tmpVideo = outPath.replace('.mp4', '_video.mp4');

  if (N === 1) {
    await ffmpeg('-i', clips[0].videoPath, '-c:v', 'copy', tmpVideo);
  } else {
    const inputs = clips.flatMap(c => ['-i', c.videoPath]);
    const vFilters = [];
    let prevV = '[0:v]';
    let offset = 0;

    for (let i = 0; i < N - 1; i++) {
      offset += clips[i].duration - TRANSITION_S;
      const last = i === N - 2;
      const vOut = last ? '[vfinal]' : `[v${i + 1}]`;
      vFilters.push(
        `${prevV}[${i + 1}:v]xfade=transition=slideleft:duration=${TRANSITION_S}:offset=${offset.toFixed(3)}${vOut}`
      );
      prevV = vOut;
    }

    await ffmpeg(
      ...inputs,
      '-filter_complex', vFilters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an',
      tmpVideo
    );
  }

  // ── Step 2: build audio track with narrations at precise absolute times ──
  const totalDuration = clips.reduce((s, c) => s + c.duration, 0) - (N - 1) * TRANSITION_S;
  const tmpAudio = outPath.replace('.mp4', '_audio.aac');

  const narrated = clips.filter(c => c.ttsPath);

  if (narrated.length === 0) {
    // No narration — create silence
    await ffmpeg(
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', String(totalDuration),
      '-c:a', 'aac', '-b:a', '192k',
      tmpAudio
    );
  } else {
    // Each narration is delayed to its exact absolute start time
    const audioInputs  = narrated.flatMap(c => ['-i', c.ttsPath]);
    const audioFilters = narrated.map((c, idx) => {
      const delayMs = Math.round(c.narrationStart * 1000);
      return `[${idx}:a]volume=${TTS_VOLUME},adelay=${delayMs}:all=1[a${idx}]`;
    });
    const mixLabels = narrated.map((_, idx) => `[a${idx}]`).join('');
    audioFilters.push(
      `${mixLabels}amix=inputs=${narrated.length}:duration=longest:dropout_transition=0[aout]`
    );

    await ffmpeg(
      ...audioInputs,
      '-filter_complex', audioFilters.join(';'),
      '-map', '[aout]',
      '-t', String(totalDuration),
      '-c:a', 'aac', '-b:a', '192k',
      tmpAudio
    );
  }

  // ── Step 3: combine video + narration audio ──
  const tmpCombined = outPath.replace('.mp4', '_combined.mp4');
  await ffmpeg(
    '-i', tmpVideo,
    '-i', tmpAudio,
    '-c:v', 'copy', '-c:a', 'copy',
    '-t', String(totalDuration),
    tmpCombined
  );
  fs.unlinkSync(tmpVideo);
  fs.unlinkSync(tmpAudio);

  // ── Step 4: mix in background music (loops if shorter than video) ──
  const lastNarrationEnd = totalDuration - STILL_SECS - PAGE_PAUSE + TRANSITION_S;
  const fadeOutStart = Math.max(0, lastNarrationEnd);
  const fadeDur      = Math.max(1, totalDuration - fadeOutStart);
  const outPathTmp   = outPath.replace('.mp4', '_tmp.mp4');

  const { path: loopedMusicPath, isTemp: musicIsTemp } =
    await buildLoopedMusicTrack(musicPath, totalDuration);

  try {
    await ffmpeg(
      '-i', tmpCombined,
      '-i', loopedMusicPath,
      '-filter_complex',
        `[1:a]volume=${MUSIC_VOLUME},` +
        `afade=t=in:st=0:d=${MUSIC_FADE},` +
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur.toFixed(3)}[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:weights=4 1,` +
        `loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      outPathTmp
    );
  } finally {
    if (musicIsTemp) try { fs.unlinkSync(loopedMusicPath); } catch {}
  }
  fs.unlinkSync(tmpCombined);
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  fs.renameSync(outPathTmp, outPath);
}

// ─── Shorts thumbnail frame appender ──────────────────────────────────────────
/**
 * Appends a still image as a silent frame at the end of the 9:16 portrait video.
 * The image is scaled/cropped to PORT_W × PORT_H (1080×1920).
 * Only applied to the Shorts output — no other video variant is affected.
 */
async function appendThumbnailFrame(portraitPath, thumbnailImgPath) {
  const tmpPath = portraitPath.replace('.mp4', '_thumb_tmp.mp4');
  await ffmpeg(
    '-i', portraitPath,
    '-loop', '1', '-t', String(THUMBNAIL_SECS), '-i', thumbnailImgPath,
    '-f', 'lavfi', '-t', String(THUMBNAIL_SECS), '-i', `anullsrc=r=44100:cl=stereo`,
    '-filter_complex',
      `[0:v]setsar=1[v0];` +
      `[1:v]scale=${PORT_W}:${PORT_H}:force_original_aspect_ratio=increase,` +
      `crop=${PORT_W}:${PORT_H},setsar=1[thumb];` +
      `[v0][0:a][thumb][2:a]concat=n=2:v=1:a=1[vout][aout]`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    tmpPath
  );
  if (fs.existsSync(portraitPath)) fs.unlinkSync(portraitPath);
  fs.renameSync(tmpPath, portraitPath);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  ensureDir(OUTPUT_VIDEO_DIR);

  if (!fs.existsSync(INPUT_TXT)) throw new Error(`Missing: ${INPUT_TXT}`);

  // ── Book-change detection: wipe cache automatically when book.txt changes ──
  // Hash the current book.txt and compare against the last build's hash.
  // Any change (new book, edited text) triggers a full cache clear so stale
  // TTS audio from a previous book is never reused.
  const HASH_FILE  = path.join(OUTPUT_VIDEO_DIR, '.book-hash');
  const bookHash   = crypto
    .createHash('sha256')
    .update(fs.readFileSync(INPUT_TXT))
    .digest('hex');
  const storedHash = fs.existsSync(HASH_FILE) ? fs.readFileSync(HASH_FILE, 'utf8').trim() : '';
  const bookChanged = bookHash !== storedHash;

  if (bookChanged) {
    console.log('Book content has changed — clearing all cached TTS and clips.\n');
    for (const f of fs.readdirSync(OUTPUT_VIDEO_DIR)) {
      if (f.endsWith('.wav') || f.endsWith('.mp4') || f.endsWith('.json')) {
        fs.unlinkSync(path.join(OUTPUT_VIDEO_DIR, f));
      }
    }
    fs.writeFileSync(HASH_FILE, bookHash);
  } else if (process.env.CLEAR_TTS_CACHE === '1') {
    // Manual override from UI checkbox
    for (const f of fs.readdirSync(OUTPUT_VIDEO_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.json'))) {
      fs.unlinkSync(path.join(OUTPUT_VIDEO_DIR, f));
    }
    console.log('TTS cache cleared (manual).\n');
    fs.writeFileSync(HASH_FILE, bookHash);
  } else {
    const cachedWavs = fs.readdirSync(OUTPUT_VIDEO_DIR).filter(f => f.endsWith('.wav'));
    if (cachedWavs.length) {
      console.log(`Found ${cachedWavs.length} cached TTS file(s). Reusing cached TTS audio.\n`);
    }
  }

  // Always clear old video clips (rebuilt every run)
  for (const f of fs.readdirSync(OUTPUT_VIDEO_DIR)) {
    if (f.endsWith('.mp4')) fs.unlinkSync(path.join(OUTPUT_VIDEO_DIR, f));
  }

  // Remove stale final videos from previous books in output/ (top-level only)
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    const fPath = path.join(OUTPUT_DIR, f);
    if (f.endsWith('.mp4') && fs.statSync(fPath).isFile()) {
      fs.unlinkSync(fPath);
    }
  }

  if (!fs.existsSync(OUTPUT_PAGES_DIR)) throw new Error('Run "Build Book" first.');

  // ── Check 1: book content ───────────────────────────────────────────────────
  // build-book stamps pages/ with hash(book.txt) so we can detect when a
  // different book is loaded without pages being rebuilt.
  // • No stamp  → pages predate this check; warn but proceed.
  // • Stamp present but wrong → provably stale; block with a clear error.
  const pagesBookHashFile   = path.join(OUTPUT_PAGES_DIR, '.book-hash');
  if (fs.existsSync(pagesBookHashFile)) {
    const storedPagesBookHash = fs.readFileSync(pagesBookHashFile, 'utf8').trim();
    if (storedPagesBookHash !== bookHash) {
      throw new Error(
        'Pages are out of date — book content has changed since the last "Build Book" run.\n' +
        'Please run "Build Book" first, then try again.'
      );
    }
  } else {
    console.log('Warning: pages have no build stamp — run "Build Book" if you switched books.\n');
  }

  // Check 2: source images used by landscape/portrait variants
  const pagesImagesHashFile = path.join(OUTPUT_PAGES_DIR, '.images-hash');
  if (fs.existsSync(pagesImagesHashFile)) {
    const storedImagesHash = fs.readFileSync(pagesImagesHashFile, 'utf8').trim();
    const currentImagesHash = computeImagesHash(INPUT_IMG_DIR);
    if (storedImagesHash !== currentImagesHash) {
      throw new Error(
        'Images are out of date — input/images has changed since the last "Build Book" run.\n' +
        'Please run "Build Book" first, then try again.'
      );
    }
  } else {
    console.log('Warning: pages have no image stamp — run "Build Book" if you changed images.\n');
  }

  // Detect image dimensions from first available PNG before building any clips
  const allPngs = fs.readdirSync(OUTPUT_PAGES_DIR).filter(f => f.endsWith('.png')).sort();
  if (!allPngs.length) throw new Error('No PNG files found in output/pages/. Run "Build Book" first.');
  await initDimensions(path.join(OUTPUT_PAGES_DIR, allPngs[0]));


  const MUSIC_PATH = resolveMusicPath();
  if (!fs.existsSync(MUSIC_PATH))       throw new Error(`Music not found: ${MUSIC_PATH}`);

  const pages = parseBookTxt(fs.readFileSync(INPUT_TXT, 'utf8'));
  if (!pages.length) throw new Error('No pages parsed from book.txt.');
  const pageImageMap = buildPageImageMap(pages);

  const slugPage = pages.find(p => titleToSlug(p.text)) || pages[0];
  const slug = titleToSlug(slugPage.text) || 'storybook';
  const OUTPUT_MP4_BLUR     = path.join(OUTPUT_DIR, `${slug}_16x9_blur.mp4`);
  const OUTPUT_MP4_PORTRAIT = path.join(OUTPUT_DIR, `${slug}_9x16_shorts.mp4`);

  console.log(`Parsed ${pages.length} pages\n`);

  const pad = n => String(n).padStart(2, '0');

  // clips[i] = { videoPath, ttsPath, duration, narrationStart }
  // narrationStart = absolute time in final video when narration begins
  const clips         = [];
  const landscapeClips = [];
  const portraitClips = [];
  const landFramePaths = [];
  const portFramePaths = [];  // temp PNG files to clean up after

  for (let i = 0; i < pages.length; i++) {
    const p       = pages[i];
    const isLast  = i === pages.length - 1;
    const isTitle = p.number === 2;
    const isCover = p.number === 1;
    const imgPath = path.join(OUTPUT_PAGES_DIR, `${pad(p.number)}.png`);

    if (!fs.existsSync(imgPath)) {
      console.warn(`  Skipping page ${p.number}: image not found.`);
      continue;
    }

    // Absolute start of this clip in the final video
    const nPrev = clips.length;
    const clipAbsStart = nPrev === 0
      ? 0
      : clips.reduce((s, c) => s + c.duration, 0) - nPrev * TRANSITION_S;

    // ── Title and copyright pages: book-only, skip in video ──
    if (isTitle) {
      console.log(`  Page 2 (title) + copyright — skipped (book only)`);
      continue;
    }

    // ── Narrated pages (skip narration on last page) ──
    const clipFile     = path.join(OUTPUT_VIDEO_DIR, `clip_${pad(p.number)}.mp4`);
    const landClipFile = path.join(OUTPUT_VIDEO_DIR, `clip_land_${pad(p.number)}.mp4`);
    const portClipFile = path.join(OUTPUT_VIDEO_DIR, `clip_port_${pad(p.number)}.mp4`);
    const hasTypewriter = !isLast;

    // Build portrait frame from the original source image
    const srcImgPath  = findSourceImage(p.number, pageImageMap);
    const frameImgPath = srcImgPath || imgPath;
    let landFramePath = null;
    let portFramePath = null;
    if (frameImgPath) {
      const landTextColor = isCover ? LAND_TEXT_COLOR_COVER : LAND_TEXT_COLOR_STORY;
      landFramePath = await buildLandscapeFrame(frameImgPath, p.text, { isCover, textColor: landTextColor });
      landFramePaths.push(landFramePath);
      const portTextColor = isCover ? PORT_TEXT_COLOR_COVER : PORT_TEXT_COLOR_STORY;
      portFramePath = await buildPortraitFrame(frameImgPath, p.text, { isCover, textColor: portTextColor });
      portFramePaths.push(portFramePath);
    }

    const landLayout = {
      x: LAND_TXT_X, y: LAND_TXT_Y, w: LAND_TXT_W, h: LAND_TXT_H,
    };
    const portLayout = {
      x: PORT_TXT_X, y: PORT_TXT_Y, w: PORT_TXT_W, h: PORT_TXT_H,
    };

    if (isLast) {
      const clipDur = STILL_SECS;
      await buildClip(imgPath, clipDur, false, clipFile);
      clips.push({ videoPath: clipFile, ttsPath: null, duration: clipDur, narrationStart: null });
      if (landFramePath) {
        await buildLandscapeClip(landFramePath, clipDur, false, landClipFile);
        landscapeClips.push({ videoPath: landClipFile, ttsPath: null, duration: clipDur, narrationStart: null });
      }
      if (portFramePath) {
        await buildPortraitClip(portFramePath, clipDur, false, portClipFile);
        portraitClips.push({ videoPath: portClipFile, ttsPath: null, duration: clipDur, narrationStart: null });
      }
      console.log(`  Page ${String(p.number).padStart(2)} (last)  — still ${clipDur}s, no narration`);
      continue;
    }

    const ttsFile = path.join(OUTPUT_VIDEO_DIR, `tts_${pad(p.number)}.wav`);
    process.stdout.write(`  Page ${String(p.number).padStart(2)} — TTS... `);
    await generateTTS(p.text, ttsFile);
    const ttsDur  = await getMediaDuration(ttsFile);

    const clipDur = TRANSITION_S + ttsDur + PAGE_PAUSE;
    const narrationStart = clipAbsStart + TRANSITION_S;

    console.log(`narration starts at ${narrationStart.toFixed(2)}s (${ttsDur.toFixed(1)}s long)`);

    const wordTimings = await ensureWordTimings(ttsFile);
    const SCALE_V     = vidW / 2550;
    const { filter: highlightFilter, wordFiles, overlays } = await buildKaraokeFilter(p.text, wordTimings, TRANSITION_S, {
      bold:          isCover,
      startFontSize: Math.round((isCover ? FONT_COVER : FONT_STORY) * SCALE_V),
    });
    await buildClip(imgPath, clipDur, hasTypewriter, clipFile, highlightFilter, wordFiles, overlays);
    clips.push({ videoPath: clipFile, ttsPath: ttsFile, duration: clipDur, narrationStart });

    if (landFramePath) {
      const landStartFont = isCover ? LAND_FONT_COVER : LAND_FONT_STORY;
      const { filter: landHighlightFilter, wordFiles: landWordFiles, overlays: landOverlays } =
        await buildKaraokeFilter(p.text, wordTimings, TRANSITION_S, {
          bold:          isCover,
          startFontSize: landStartFont,
          portLayout:    landLayout,
          canvasW:       LAND_W,
          canvasH:       LAND_H,
        });
      await buildLandscapeClip(landFramePath, clipDur, hasTypewriter, landClipFile, landHighlightFilter, landWordFiles, landOverlays);
      landscapeClips.push({ videoPath: landClipFile, ttsPath: ttsFile, duration: clipDur, narrationStart });
    }

    if (portFramePath) {
      const portStartFont = isCover ? PORT_FONT_COVER : PORT_FONT_STORY;
      const { filter: portHighlightFilter, wordFiles: portWordFiles, overlays: portOverlays } =
        await buildKaraokeFilter(p.text, wordTimings, TRANSITION_S, {
          bold:          isCover,
          startFontSize: portStartFont,
          portLayout,
          canvasW:       PORT_W,
          canvasH:       PORT_H,
        });
      await buildPortraitClip(portFramePath, clipDur, hasTypewriter, portClipFile, portHighlightFilter, portWordFiles, portOverlays);
      portraitClips.push({ videoPath: portClipFile, ttsPath: ttsFile, duration: clipDur, narrationStart });
    }
  }

  if (!clips.length) throw new Error('No clips built.');

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0) - (clips.length - 1) * TRANSITION_S;
  console.log(`\nAssembling ${clips.length} clips (~${totalDuration.toFixed(0)}s)...`);

  console.log('Assembling 16:9 landscape variant...');
  await buildFinalVideo(landscapeClips.length ? landscapeClips : clips, MUSIC_PATH, OUTPUT_MP4_BLUR);
  console.log(`Done!  →  ${OUTPUT_MP4_BLUR}`);

  // Portrait 9:16 (1080×1920) — YouTube Shorts
  // Built from per-page portrait frames: source image top half, text bottom half.
  if (portraitClips.length) {
    console.log('\nAssembling 9:16 portrait variant for YouTube Shorts...');
    await buildFinalVideo(portraitClips, MUSIC_PATH, OUTPUT_MP4_PORTRAIT);
    console.log(`Done!  →  ${OUTPUT_MP4_PORTRAIT}`);

    if (SHORTS_THUMBNAIL_PATH && fs.existsSync(SHORTS_THUMBNAIL_PATH)) {
      console.log('\nAppending thumbnail frame to 9:16 Shorts video...');
      await appendThumbnailFrame(OUTPUT_MP4_PORTRAIT, SHORTS_THUMBNAIL_PATH);
      console.log(`Done!  →  ${OUTPUT_MP4_PORTRAIT}`);
    }
  } else {
    console.log('\nSkipping 9:16 portrait — no source images found in input/images/.');
  }

  // Clean up temporary portrait frame PNGs
  for (const f of landFramePaths) try { fs.unlinkSync(f); } catch {}
  for (const f of portFramePaths) try { fs.unlinkSync(f); } catch {}

  console.log(`\nAll done!`);
  console.log(`  16:9     →  ${OUTPUT_MP4_BLUR}`);
  console.log(`  9:16     →  ${OUTPUT_MP4_PORTRAIT}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
