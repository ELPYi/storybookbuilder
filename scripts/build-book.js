#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
} = require('docx');

const ROOT      = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.STORYBOOK_DATA_ROOT || ROOT;
const INPUT_TXT = path.join(DATA_ROOT, 'input', 'book.txt');
const INPUT_IMG_DIR = path.join(DATA_ROOT, 'input', 'images');
const OUTPUT_DIR = path.join(DATA_ROOT, 'output');
const OUTPUT_PAGES_DIR = path.join(OUTPUT_DIR, 'pages');

function titleToSlug(title) {
  return title.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ─── Font sizes ───────────────────────────────────────────────────────────────
const FONT_COVER = parseInt(process.env.FONT_COVER || '90');
const FONT_STORY = parseInt(process.env.FONT_STORY || '76');
const FONT_LAST  = parseInt(process.env.FONT_LAST  || '60');

// ─── Text colors & background ─────────────────────────────────────────────────
const TEXT_COLOR_COVER = process.env.TEXT_COLOR_COVER || '#000000';
const TEXT_COLOR_STORY = process.env.TEXT_COLOR_STORY || '#000000';
const TEXT_COLOR_LAST  = process.env.TEXT_COLOR_LAST  || '#000000';
const TEXT_BG_COLOR    = process.env.TEXT_BG_COLOR    || '#ffffff';

// ─── Page dimensions ──────────────────────────────────────────────────────────
const DPI    = 300;
const PAGE_W = process.env.STORYBOOK_PAGE_W_PX ? parseInt(process.env.STORYBOOK_PAGE_W_PX) : 2550;
const PAGE_H = process.env.STORYBOOK_PAGE_H_PX ? parseInt(process.env.STORYBOOK_PAGE_H_PX) : 2550;
// Bleed in inches — configurable via env, default 0.125" per side @ 300 DPI
const BLEED    = Math.round(parseFloat(process.env.BLEED_IN || '0.125') * DPI);
// Full canvas including bleed
const CANVAS_W = PAGE_W + BLEED * 2;
const CANVAS_H = PAGE_H + BLEED * 2;
// Scale typography relative to default 8.5"×8.5" @ 300 DPI (2550px)
const SCALE  = PAGE_W / 2550;
const MARGIN = Math.round(90 * SCALE);

// ─── Layout ───────────────────────────────────────────────────────────────────
// Boxes are fractions of the trim area (0–1). Applied to all image+text pages.
const DEFAULT_LAYOUT = {
  imageBox: { x: 0.03, y: 0.03, w: 0.94, h: 0.56 },
  textBox:  { x: 0.03, y: 0.61, w: 0.94, h: 0.36 },
};

const layout = (() => {
  try {
    return process.env.STORYBOOK_LAYOUT
      ? JSON.parse(process.env.STORYBOOK_LAYOUT)
      : DEFAULT_LAYOUT;
  } catch { return DEFAULT_LAYOUT; }
})();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

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
  if (images.length < imagePages.length) {
    throw new Error(
      `Not enough images in input/images. Need ${imagePages.length} for pages excluding title page 2, found ${images.length}.`
    );
  }
  const map = new Map();
  imagePages.forEach((p, idx) => map.set(p.number, images[idx]));
  return map;
}

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

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = stripMarkdown(raw).trim();

    const pageMatch = /^Page\s+(\d+)\s*:/i.exec(line);

    if (pageMatch) {
      flushText();
      if (currentPage) pages.push(currentPage);
      currentPage = {
        number: Number(pageMatch[1]),
        title: line.replace(/^Page\s+\d+\s*:\s*/i, '').trim(),
        text: ''
      };
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

    if (TEXT_STOP_RE.test(line)) {
      collectingText = false;
      continue;
    }

    if (collectingText) {
      const coupletMatch = /^Line\s*\d+\s*:\s*(.*)/i.exec(line);
      if (coupletMatch) {
        const content = coupletMatch[1].trim();
        if (content) textLines.push(content);
        continue;
      }
      if (line === '') {
        textLines.push('');
      } else {
        textLines.push(line);
      }
    }
  }

  flushText();
  if (currentPage) pages.push(currentPage);

  return pages.filter(p => p.text && p.text.trim().length > 0);
}

let PAGE_IMAGE_MAP = null;

function findImageForPage(pageNumber) {
  if (PAGE_IMAGE_MAP && PAGE_IMAGE_MAP.has(pageNumber)) {
    return PAGE_IMAGE_MAP.get(pageNumber);
  }
  const padded = String(pageNumber).padStart(2, '0');
  const plain = String(pageNumber);
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  const candidates = [
    ...exts.map(e => `${padded}.${e}`),
    ...exts.map(e => `${plain}.${e}`),
  ];
  for (const f of candidates) {
    const full = path.join(INPUT_IMG_DIR, f);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function wrapText(text, maxCharsPerLine) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length > maxCharsPerLine && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// Mirrors svgTextBlock's auto-shrink loop.
// Returns { fontSize (px), topPad (px) } where topPad vertically centers the
// text block within the box, matching how svgTextBlock positions it.
function computeTextLayout(text, startFontSize, boxW, boxH) {
  const mX      = Math.round(boxW * 0.04);
  const mY      = Math.round(boxH * 0.08);
  const availW  = boxW - mX * 2;
  const availH  = boxH - mY * 2;
  const minFont = Math.max(12, Math.round(18 * SCALE));
  const step    = Math.max(2, Math.round(4 * SCALE));
  const cLines  = text.split('\n').map(l => l.trim()).filter(Boolean);
  const hasCouplet = cLines.length >= 2;
  let fontSize  = startFontSize;
  let settledH  = availH;

  while (fontSize >= minFont) {
    const lineH  = Math.round(fontSize * 1.35);
    const maxCh  = Math.floor(availW / (fontSize * 0.55));
    const groups = cLines.map(cl => wrapText(cl, maxCh));
    const nLines = groups.reduce((s, g) => s + g.length, 0);
    const gapPx  = hasCouplet ? (groups.length - 1) * Math.round(lineH * 0.4) : 0;
    settledH = nLines * lineH + gapPx;
    if (settledH <= availH) break;
    fontSize -= step;
  }

  fontSize = Math.max(fontSize, minFont);
  const topPad = Math.max(0, mY + Math.round((availH - settledH) / 2));
  return { fontSize, topPad };
}

function safeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Renders text into a box of size boxW×boxH with auto-scaling font.
function svgTextBlock(text, opts = {}) {
  const { bold = false, startFontSize, boxW, boxH, textColor = '#000000', bgColor = null } = opts;
  const W = boxW;
  const H = boxH;
  const mX     = Math.round(W * 0.04);
  const mY     = Math.round(H * 0.08);
  const availW = W - mX * 2;
  const availH = H - mY * 2;
  const GAP_RATIO = 0.4;
  const minFont   = Math.max(12, Math.round(18 * SCALE));
  const step      = Math.max(2, Math.round(4 * SCALE));

  let fontSize = startFontSize !== undefined ? startFontSize : Math.round(76 * SCALE);

  const coupletLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const hasCouplet   = coupletLines.length >= 2;

  let lineHeight, groups, totalH;

  while (fontSize >= minFont) {
    lineHeight = Math.round(fontSize * 1.35);
    const maxChars = Math.floor(availW / (fontSize * 0.55));
    groups     = coupletLines.map(cl => wrapText(cl, maxChars));
    const totalLines = groups.reduce((s, g) => s + g.length, 0);
    const gapTotal   = hasCouplet ? (groups.length - 1) * Math.round(lineHeight * GAP_RATIO) : 0;
    totalH = totalLines * lineHeight + gapTotal;
    if (totalH <= availH) break;
    fontSize -= step;
  }

  const gapPx  = hasCouplet ? Math.round(lineHeight * GAP_RATIO) : 0;
  const startY = mY + Math.round((availH - totalH) / 2) + fontSize;

  const tspans = [];
  let y = startY;
  groups.forEach((group, gi) => {
    group.forEach(line => {
      tspans.push(`<tspan x="${W / 2}" y="${y}">${safeXml(line)}</tspan>`);
      y += lineHeight;
    });
    if (gi < groups.length - 1) y += gapPx;
  });

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${bgColor ? `<rect width="${W}" height="${H}" fill="${bgColor}"/>` : ''}
      <text
        x="${W / 2}"
        y="${startY}"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}"
        font-weight="${bold ? 'bold' : 'normal'}"
        fill="${textColor}"
      >${tspans.join('')}</text>
    </svg>
  `);
}

// Title page (page 2) — white background, no image
async function buildTitlePage(page) {
  const textLines = page.text.split('\n').map(s => s.trim()).filter(Boolean);
  const title  = textLines[0] || '';
  const byLine = textLines.slice(1).join(' ').trim();
  const publisher = byLine.startsWith('by ')
    ? 'Published by ' + byLine.slice(3)
    : byLine || 'Published by GMX Creations';

  const titleFontSize = Math.round(110 * SCALE);
  const pubFontSize   = Math.round(60  * SCALE);
  const titleLineH    = Math.round(titleFontSize * 1.3);
  const titleMaxChars = Math.floor((PAGE_W - MARGIN * 4) / (titleFontSize * 0.55));
  const wrappedTitle  = wrapText(title, titleMaxChars);

  const titleStartY = BLEED + Math.round(PAGE_H * 0.32);
  const titleTspans = wrappedTitle
    .map((line, i) => `<tspan x="${CANVAS_W / 2}" y="${titleStartY + i * titleLineH}">${safeXml(line)}</tspan>`)
    .join('');

  const pubY = titleStartY + wrappedTitle.length * titleLineH + Math.round(160 * SCALE);

  const svg = Buffer.from(`
    <svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text
        x="${CANVAS_W / 2}"
        y="${titleStartY}"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${titleFontSize}"
        font-weight="bold"
        fill="#000000"
      >${titleTspans}</text>
      <text
        x="${CANVAS_W / 2}"
        y="${pubY}"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${pubFontSize}"
        fill="#000000"
      >${safeXml(publisher)}</text>
    </svg>
  `);

  const outFile = path.join(OUTPUT_PAGES_DIR, '02.png');
  await sharp(svg).png().toFile(outFile);
  return outFile;
}

// Copyright page
async function buildCopyrightPage() {
  const year      = new Date().getFullYear();
  const bodySize  = Math.round(44 * SCALE);
  const headSize  = Math.round(52 * SCALE);
  const bodyLineH = Math.round(bodySize * 1.6);
  const headLineH = Math.round(headSize * 1.6);
  const leftX     = BLEED + MARGIN * 3;
  const maxChars  = Math.floor((PAGE_W - MARGIN * 5) / (bodySize * 0.52));

  const rightsText =
    `All rights reserved. No part of this publication may be reproduced, distributed, or transmitted ` +
    `in any form or by any means, including photocopying, recording, or other electronic or mechanical ` +
    `methods, without the prior written permission of the publisher, except in the case of brief ` +
    `quotations embodied in critical reviews and certain other noncommercial uses permitted by copyright law.`;
  const creditsText =
    `Written & Illustrated by: GMX Creations and Generative Art Assistance & Technology provided by: ` +
    `Google Gemini & Alphabet Inc. Compiled & Designed using: Canva`;

  const rightsLines  = wrapText(rightsText,  maxChars);
  const creditsLines = wrapText(creditsText, maxChars);

  let y = BLEED + Math.round(PAGE_H * 0.35);
  const elements = [];

  elements.push(`<text x="${leftX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${headSize}" font-weight="bold" fill="#000000">${safeXml(`\u00A9 ${year} GMX Creations.`)}</text>`);
  y += headLineH;

  for (const line of rightsLines) {
    elements.push(`<text x="${leftX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${bodySize}" fill="#000000">${safeXml(line)}</text>`);
    y += bodyLineH;
  }
  y += bodyLineH;

  elements.push(`<text x="${leftX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${headSize}" font-weight="bold" fill="#000000">Credits</text>`);
  y += headLineH;

  for (const line of creditsLines) {
    elements.push(`<text x="${leftX}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${bodySize}" fill="#000000">${safeXml(line)}</text>`);
    y += bodyLineH;
  }

  const svg = Buffer.from(`
    <svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      ${elements.join('\n      ')}
    </svg>
  `);

  const outFile = path.join(OUTPUT_PAGES_DIR, '02b_copyright.png');
  await sharp(svg).png().toFile(outFile);
  return outFile;
}

async function buildBlankPage() {
  const svg = Buffer.from(`<svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/></svg>`);
  const outFile = path.join(OUTPUT_PAGES_DIR, 'blank.png');
  await sharp(svg).png().toFile(outFile);
  return outFile;
}

// All image+text pages (cover, story pages, last page) use the layout template.
async function buildPage(page, opts = {}) {
  if (page.number === 2) return buildTitlePage(page);

  const imagePath = findImageForPage(page.number);
  if (!imagePath) {
    throw new Error(`Missing image for page ${page.number}. Expected ${String(page.number).padStart(2, '0')}.png/jpg in input/images`);
  }

  const isCover = page.number === 1;

  // Resolve layout boxes to pixels within the trim area
  const { imageBox, textBox } = layout;

  // Image: extend into bleed on any side that is flush with the trim boundary so
  // content actually reaches the canvas edge (required for print bleed to work).
  const rawImgX = Math.round(imageBox.x * PAGE_W);
  const rawImgY = Math.round(imageBox.y * PAGE_H);
  const rawImgW = Math.max(1, Math.round(imageBox.w * PAGE_W));
  const rawImgH = Math.max(1, Math.round(imageBox.h * PAGE_H));
  const imgBleedL = rawImgX <= 0          ? BLEED : 0;
  const imgBleedT = rawImgY <= 0          ? BLEED : 0;
  const imgBleedR = rawImgX + rawImgW >= PAGE_W ? BLEED : 0;
  const imgBleedB = rawImgY + rawImgH >= PAGE_H ? BLEED : 0;
  const imgL = BLEED + rawImgX - imgBleedL;
  const imgT = BLEED + rawImgY - imgBleedT;
  const imgW = Math.max(1, rawImgW + imgBleedL + imgBleedR);
  const imgH = Math.max(1, rawImgH + imgBleedT + imgBleedB);

  const rawTxtX = Math.round(textBox.x * PAGE_W);
  const rawTxtY = Math.round(textBox.y * PAGE_H);
  const rawTxtW = Math.max(1, Math.round(textBox.w * PAGE_W));
  const rawTxtH = Math.max(1, Math.round(textBox.h * PAGE_H));
  const txtBleedL = rawTxtX <= 0                ? BLEED : 0;
  const txtBleedT = rawTxtY <= 0                ? BLEED : 0;
  const txtBleedR = rawTxtX + rawTxtW >= PAGE_W ? BLEED : 0;
  const txtBleedB = rawTxtY + rawTxtH >= PAGE_H ? BLEED : 0;
  const txtL = BLEED + rawTxtX - txtBleedL;
  const txtT = BLEED + rawTxtY - txtBleedT;
  const txtW = Math.max(1, rawTxtW + txtBleedL + txtBleedR);
  const txtH = Math.max(1, rawTxtH + txtBleedT + txtBleedB);

  // White canvas
  const canvas = await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).png().toBuffer();

  // Image resized to fill imageBox (cover crop)
  const resizedImg = await sharp(imagePath)
    .resize(imgW, imgH, { fit: 'cover', position: 'center' })
    .toBuffer();

  // Starting font size — user-configurable max; auto-shrinks if text overflows the box
  const startFontSize = isCover
    ? Math.round(FONT_COVER * SCALE)
    : opts.isLast
      ? Math.round(FONT_LAST * SCALE)
      : Math.round(FONT_STORY * SCALE);

  const textColor = isCover ? TEXT_COLOR_COVER : opts.isLast ? TEXT_COLOR_LAST : TEXT_COLOR_STORY;
  const textSvg = svgTextBlock(page.text, { bold: isCover, startFontSize, boxW: txtW, boxH: txtH, textColor, bgColor: TEXT_BG_COLOR });
  const textImg = await sharp(textSvg).png().toBuffer();

  const outFile = path.join(OUTPUT_PAGES_DIR, `${String(page.number).padStart(2, '0')}.png`);

  await sharp(canvas)
    .composite([
      { input: resizedImg, top: imgT, left: imgL },
      { input: textImg,   top: txtT, left: txtL },
    ])
    .png()
    .toFile(outFile);

  return outFile;
}


async function buildDocx(pages, slug) {
  // ── Unit helpers ─────────────────────────────────────────────────────────
  // ImageRun.transformation is in CSS pixels (96 DPI); docx v9 multiplies by 9525 EMU/px internally.
  const pxToImgUnit = px => Math.round(px * 96 / DPI);
  // floating image offsets in EMU
  const pxToEMU     = px => Math.round(px / DPI * 914400);
  // frame / page dimensions in twips (1 twip = 1/1440 inch)
  const pxToTwips   = px => Math.round(px / DPI * 1440);
  // font size: pixels at DPI → Word half-points
  const pxToHalfPt  = px => Math.round(px * 72 / DPI * 2);

  const PAGE_W_TWIPS = pxToTwips(PAGE_W);
  const PAGE_H_TWIPS = pxToTwips(PAGE_H);

  const { imageBox, textBox } = layout;

  const imgL = Math.round(imageBox.x * PAGE_W);
  const imgT = Math.round(imageBox.y * PAGE_H);
  const imgW = Math.max(1, Math.round(imageBox.w * PAGE_W));
  const imgH = Math.max(1, Math.round(imageBox.h * PAGE_H));

  const txtL = Math.round(textBox.x * PAGE_W);
  const txtT = Math.round(textBox.y * PAGE_H);
  const txtW = Math.max(1, Math.round(textBox.w * PAGE_W));
  const txtH = Math.max(1, Math.round(textBox.h * PAGE_H));

  const pageProps = {
    size:   { width: PAGE_W_TWIPS, height: PAGE_H_TWIPS },
    margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 },
  };

  // Content pages constrain left/right margins to match the text box so Word
  // doesn't let paragraphs flow beyond the text box's horizontal bounds.
  const contentPageProps = {
    size:   { width: PAGE_W_TWIPS, height: PAGE_H_TWIPS },
    margin: {
      top: 0,
      left:   pxToTwips(txtL),
      right:  pxToTwips(PAGE_W - txtL - txtW),
      bottom: 0,
      header: 0, footer: 0, gutter: 0,
    },
  };

  // ── Section builders ──────────────────────────────────────────────────────

  async function imageTextSection(page, opts = {}) {
    const { isCover = false, isLast = false } = opts;
    const children = [];

    const imagePath = findImageForPage(page.number);
    if (imagePath) {
      const imgBuf = await sharp(imagePath)
        .resize(imgW, imgH, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
      children.push(new Paragraph({
        children: [new ImageRun({
          type: 'png',
          data: imgBuf,
          transformation: { width: pxToImgUnit(imgW), height: pxToImgUnit(imgH) },
          floating: {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.PAGE,
              offset: pxToEMU(imgL),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PAGE,
              offset: pxToEMU(imgT),
            },
            allowOverlap: true,
          },
        })],
      }));
    }

    const startFontSize = isCover
      ? Math.round(FONT_COVER * SCALE)
      : isLast
        ? Math.round(FONT_LAST * SCALE)
        : Math.round(FONT_STORY * SCALE);
    const rawColor  = isCover ? TEXT_COLOR_COVER : isLast ? TEXT_COLOR_LAST : TEXT_COLOR_STORY;
    const textColor = rawColor.replace('#', '');
    const { fontSize, topPad } = computeTextLayout(page.text, startFontSize, txtW, txtH);
    const halfPts   = pxToHalfPt(fontSize);

    const textLines = page.text.split('\n').map(l => l.trim()).filter(Boolean);
    const runs = textLines.map((line, i) => new TextRun({
      text:  line,
      font:  'Arial',
      size:  halfPts,
      bold:  isCover,
      color: textColor,
      break: i > 0 ? 1 : undefined,
    }));

    // spacing.before positions text at approximately the same vertical location
    // as the PDF's text box (txtT = top of text area, topPad = centering offset).
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { before: pxToTwips(txtT + topPad) },
      children:  runs,
    }));

    return { properties: { page: contentPageProps }, children };
  }

  function titleSection(page) {
    const lines     = page.text.split('\n').map(s => s.trim()).filter(Boolean);
    const title     = lines[0] || '';
    const byLine    = lines.slice(1).join(' ').trim();
    const publisher = byLine.startsWith('by ')
      ? 'Published by ' + byLine.slice(3)
      : byLine || 'Published by GMX Creations';

    return {
      properties: { page: pageProps },
      children: [
        new Paragraph({
          spacing: { before: Math.round(PAGE_H_TWIPS * 0.30) },
          children: [],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            text: title, font: 'Arial',
            size: pxToHalfPt(Math.round(110 * SCALE)),
            bold: true, color: '000000',
          })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: Math.round(PAGE_H_TWIPS * 0.06) },
          children: [new TextRun({
            text: publisher, font: 'Arial',
            size: pxToHalfPt(Math.round(60 * SCALE)),
            color: '000000',
          })],
        }),
      ],
    };
  }

  function copyrightSection() {
    const year     = new Date().getFullYear();
    const bodySize = Math.round(44 * SCALE);
    const headSize = Math.round(52 * SCALE);
    const rights   =
      `All rights reserved. No part of this publication may be reproduced, distributed, or ` +
      `transmitted in any form or by any means, including photocopying, recording, or other ` +
      `electronic or mechanical methods, without the prior written permission of the publisher, ` +
      `except in the case of brief quotations embodied in critical reviews and certain other ` +
      `noncommercial uses permitted by copyright law.`;
    const credits  =
      `Written & Illustrated by: GMX Creations and Generative Art Assistance & Technology ` +
      `provided by: Google Gemini & Alphabet Inc. Compiled & Designed using: Canva`;

    // 1-inch left/right margins keep text off the edges; header/footer 0 to match zero top/bottom.
    const copyrightPageProps = {
      size:   { width: PAGE_W_TWIPS, height: PAGE_H_TWIPS },
      margin: { top: 0, right: pxToTwips(DPI), bottom: 0, left: pxToTwips(DPI), header: 0, footer: 0, gutter: 0 },
    };

    return {
      properties: { page: copyrightPageProps },
      children: [
        new Paragraph({
          spacing: { before: Math.round(PAGE_H_TWIPS * 0.32) },
          children: [new TextRun({ text: `© ${year} GMX Creations.`, font: 'Arial', size: pxToHalfPt(headSize), bold: true, color: '000000' })],
        }),
        new Paragraph({
          children: [new TextRun({ text: rights,   font: 'Arial', size: pxToHalfPt(bodySize), color: '000000' })],
        }),
        new Paragraph({ children: [] }),
        new Paragraph({
          children: [new TextRun({ text: 'Credits', font: 'Arial', size: pxToHalfPt(headSize), bold: true, color: '000000' })],
        }),
        new Paragraph({
          children: [new TextRun({ text: credits,  font: 'Arial', size: pxToHalfPt(bodySize), color: '000000' })],
        }),
      ],
    };
  }

  // ── Assemble sections (one per book page, mirrors main()'s render order) ──
  const sections = [];

  for (let i = 0; i < pages.length; i++) {
    const p      = pages[i];
    const isLast = i === pages.length - 1;

    if (isLast && sections.length % 2 === 0) {
      sections.push({
        properties: { page: pageProps },
        children: [new Paragraph({ children: [] })],
      });
    }

    if (p.number === 1) {
      sections.push(await imageTextSection(p, { isCover: true }));
    } else if (p.number === 2) {
      sections.push(titleSection(p));
      sections.push(copyrightSection());
    } else if (isLast) {
      sections.push(await imageTextSection(p, { isLast: true }));
    } else {
      sections.push(await imageTextSection(p));
    }
  }

  const doc    = new Document({ sections });
  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(OUTPUT_DIR, `${slug}.docx`);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

async function main() {
  ensureDir(OUTPUT_DIR);

  if (!fs.existsSync(INPUT_TXT)) {
    throw new Error(`Missing input file: ${INPUT_TXT}`);
  }

  // ── Clear stale output before every build ─────────────────────────────────
  // Wipe pages dir so pages from a previous (longer) book don't carry over.
  fs.rmSync(OUTPUT_PAGES_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_PAGES_DIR, { recursive: true });

  // Remove old DOCXs so previous books don't accumulate in output/.
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    const fPath = path.join(OUTPUT_DIR, f);
    if (f.endsWith('.docx') && fs.statSync(fPath).isFile()) {
      fs.unlinkSync(fPath);
    }
  }

  const raw   = fs.readFileSync(INPUT_TXT, 'utf8');
  const pages = parseBookTxt(raw);
  PAGE_IMAGE_MAP = buildPageImageMap(pages);

  if (!pages.length) {
    throw new Error('No pages parsed from input/book.txt. Check format: "Page X:" and "Text (...) :" lines.');
  }

  const slugPage    = pages.find(p => titleToSlug(p.text)) || pages[0];
  const slug        = titleToSlug(slugPage.text) || 'storybook';
  const OUTPUT_DOCX = path.join(OUTPUT_DIR, `${slug}.docx`);

  console.log(`Parsed ${pages.length} pages from book.txt`);
  console.log(`Canvas: ${CANVAS_W}x${CANVAS_H}px (trim: ${PAGE_W}x${PAGE_H}px, bleed: ${BLEED}px each side)`);

  const rendered = [];
  for (let i = 0; i < pages.length; i++) {
    const p      = pages[i];
    const isLast = i === pages.length - 1;

    if (isLast && rendered.length % 2 === 0) {
      rendered.push(await buildBlankPage());
      console.log('Inserted blank page for even-page alignment');
    }

    const out = await buildPage(p, { isLast });
    rendered.push(out);
    console.log(`Built page ${String(p.number).padStart(2, '0')}${isLast ? ' (last)' : ''}`);

    if (p.number === 2) {
      const copyrightOut = await buildCopyrightPage();
      rendered.push(copyrightOut);
      console.log('Built copyright page');
    }
  }

  console.log('Building DOCX…');
  await buildDocx(pages, slug);

  // Stamp the pages dir with a hash of the book text so build-video.js can
  // detect when a different book is loaded without pages being rebuilt.
  const bookHash = crypto.createHash('sha256').update(raw).digest('hex');
  fs.writeFileSync(path.join(OUTPUT_PAGES_DIR, '.book-hash'), bookHash);
  fs.writeFileSync(path.join(OUTPUT_PAGES_DIR, '.images-hash'), computeImagesHash(INPUT_IMG_DIR));

  // Save the layout used for this build so build-video.js can position
  // highlights and the typewriter effect to match the actual page layout.
  fs.writeFileSync(path.join(OUTPUT_PAGES_DIR, '.build-layout.json'), JSON.stringify(layout));

  console.log(`\nDone!\nPages: ${OUTPUT_PAGES_DIR}\nDOCX:  ${OUTPUT_DOCX}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
