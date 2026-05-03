'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────
let settings      = { voice: 'af_heart', ttsVolume: 2.0, musicVolume: 0.3 };
let imagesDirPath = null;
let orderedImages = [];         // [{ name, path, isNumbered }] in user's chosen order

// Font size maxima — not persisted, reset to defaults each session
let fontSizeCover = 90;
let fontSizeStory = 76;
let fontSizeLast  = 60;

// Text colors — not persisted, reset to defaults each session
let textColorCover = '#000000';
let textColorStory = '#000000';
let textColorLast  = '#000000';

// Bleed (inches) — persisted in settings
let bleedIn = 0.125;

// Book text area background — persisted in settings
let textBgColor = '#ffffff';

// Per-format video settings — persisted in settings
let landscapeSettings = { imgRatio: 0.6, fontCover: 90, fontStory: 48, textColorCover: '#000000', textColorStory: '#000000', textBgColor: '#ffffff' };
let shortsSettings    = { imgRatio: 0.6, fontCover: 90, fontStory: 80, textColorCover: '#000000', textColorStory: '#000000', textBgColor: '#ffffff' };

// ─── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  settings = await window.api.getSettings();
  syncSettingsUI();
  initLayoutEditor();
})();

// ─── Page Size & Layout Editor ────────────────────────────────────────────────
const CANVAS_DISPLAY_W = 380;
const SNAP_THRESHOLD   = 8;      // px distance within which a snap fires
let   snapEnabled      = true;

let pageSize = { width: 8.5, height: 8.5, unit: 'in' };
let layout   = {
  imageBox: { x: 0.03, y: 0.03, w: 0.94, h: 0.56 },
  textBox:  { x: 0.03, y: 0.61, w: 0.94, h: 0.36 },
};

// Convert current pageSize setting to output pixels (mirrors main.js logic)
function pageToPx() {
  const DPI = 300;
  const { width, height, unit } = pageSize;
  if (unit === 'cm') return { w: Math.round(width * DPI / 2.54), h: Math.round(height * DPI / 2.54) };
  if (unit === 'px') return { w: Math.round(width),              h: Math.round(height) };
  return { w: Math.round(width * DPI), h: Math.round(height * DPI) };
}

// Guide positions: canvas edges + center + the other box's edges + center
function guidePositions(otherEl, cW, cH) {
  const gx = [0, cW / 2, cW];
  const gy = [0, cH / 2, cH];
  if (otherEl) {
    const ol = parseInt(otherEl.style.left)   || 0;
    const ot = parseInt(otherEl.style.top)    || 0;
    const ow = parseInt(otherEl.style.width)  || 0;
    const oh = parseInt(otherEl.style.height) || 0;
    gx.push(ol, ol + ow / 2, ol + ow);
    gy.push(ot, ot + oh / 2, ot + oh);
  }
  return { gx, gy };
}

// Try to snap a single value to the nearest guide; returns { val, guide|null }
function trySnap(val, guides) {
  if (!snapEnabled) return { val, guide: null };
  for (const g of guides) {
    if (Math.abs(val - g) <= SNAP_THRESHOLD) return { val: g, guide: g };
  }
  return { val, guide: null };
}

// Snap a box position (drag), checking left/center/right and top/center/bottom edges
function snapDrag(left, top, w, h, cW, cH, otherEl) {
  const { gx, gy } = guidePositions(otherEl, cW, cH);
  const activeGuides = [];

  const xEdges = [{ v: left, off: 0 }, { v: left + w / 2, off: w / 2 }, { v: left + w, off: w }];
  let sl = left;
  for (const e of xEdges) {
    const r = trySnap(e.v, gx);
    if (r.guide !== null) { sl = r.val - e.off; activeGuides.push({ type: 'v', pos: r.guide }); break; }
  }

  const yEdges = [{ v: top, off: 0 }, { v: top + h / 2, off: h / 2 }, { v: top + h, off: h }];
  let st = top;
  for (const e of yEdges) {
    const r = trySnap(e.v, gy);
    if (r.guide !== null) { st = r.val - e.off; activeGuides.push({ type: 'h', pos: r.guide }); break; }
  }

  return { left: sl, top: st, guides: activeGuides };
}

// Snap a single moving edge (resize); returns { val, guide|null }
function snapEdge(val, guides) { return trySnap(val, guides); }

const pageSizeWEl   = document.getElementById('page-width');
const pageSizeHEl   = document.getElementById('page-height');
const pageSizeUEl   = document.getElementById('page-unit');
const layoutCanvas  = document.getElementById('layout-canvas');
const imgBoxEl      = document.getElementById('layout-img-box');
const txtBoxEl      = document.getElementById('layout-txt-box');

// Guide lines injected into the canvas
const hGuideLine = Object.assign(document.createElement('div'), { className: 'snap-guide snap-guide-h' });
const vGuideLine = Object.assign(document.createElement('div'), { className: 'snap-guide snap-guide-v' });
layoutCanvas.appendChild(hGuideLine);
layoutCanvas.appendChild(vGuideLine);

function showGuides(guides) {
  const h = guides.find(g => g.type === 'h');
  const v = guides.find(g => g.type === 'v');
  if (h) { hGuideLine.style.top  = h.pos + 'px'; hGuideLine.classList.add('visible'); }
  else      hGuideLine.classList.remove('visible');
  if (v) { vGuideLine.style.left = v.pos + 'px'; vGuideLine.classList.add('visible'); }
  else      vGuideLine.classList.remove('visible');
}
function hideGuides() {
  hGuideLine.classList.remove('visible');
  vGuideLine.classList.remove('visible');
}

function getCanvasDisplayH() {
  return Math.round(CANVAS_DISPLAY_W * (pageSize.height / pageSize.width));
}

function boxToPixels(box) {
  const cH = getCanvasDisplayH();
  return {
    left:   Math.round(box.x * CANVAS_DISPLAY_W),
    top:    Math.round(box.y * cH),
    width:  Math.round(box.w * CANVAS_DISPLAY_W),
    height: Math.round(box.h * cH),
  };
}

function pixelsToBox(px) {
  const cH = getCanvasDisplayH();
  return {
    x: Math.max(0, Math.min(0.95, px.left   / CANVAS_DISPLAY_W)),
    y: Math.max(0, Math.min(0.95, px.top    / cH)),
    w: Math.max(0.05, Math.min(1 - Math.max(0, px.left / CANVAS_DISPLAY_W), px.width  / CANVAS_DISPLAY_W)),
    h: Math.max(0.05, Math.min(1 - Math.max(0, px.top  / cH),               px.height / cH)),
  };
}

function applyLayoutToCanvas() {
  const cH = getCanvasDisplayH();
  layoutCanvas.style.width  = CANVAS_DISPLAY_W + 'px';
  layoutCanvas.style.height = cH + 'px';

  for (const [el, key] of [[imgBoxEl, 'imageBox'], [txtBoxEl, 'textBox']]) {
    const px = boxToPixels(layout[key]);
    el.style.left   = px.left   + 'px';
    el.style.top    = px.top    + 'px';
    el.style.width  = px.width  + 'px';
    el.style.height = px.height + 'px';
  }
}

// ── Drag & resize ──
let drag = null;
let resz = null;
const MIN_BOX_PX = 30;

function readPx(el) {
  return {
    left:   parseInt(el.style.left)   || 0,
    top:    parseInt(el.style.top)    || 0,
    width:  parseInt(el.style.width)  || 0,
    height: parseInt(el.style.height) || 0,
  };
}

imgBoxEl.addEventListener('mousedown', e => {
  if (e.target.classList.contains('resize-handle')) return;
  e.preventDefault();
  const px = readPx(imgBoxEl);
  drag = { el: imgBoxEl, key: 'imageBox', startX: e.clientX, startY: e.clientY, startLeft: px.left, startTop: px.top };
});

txtBoxEl.addEventListener('mousedown', e => {
  if (e.target.classList.contains('resize-handle')) return;
  e.preventDefault();
  const px = readPx(txtBoxEl);
  drag = { el: txtBoxEl, key: 'textBox', startX: e.clientX, startY: e.clientY, startLeft: px.left, startTop: px.top };
});

imgBoxEl.querySelectorAll('.resize-handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    const px = readPx(imgBoxEl);
    resz = { el: imgBoxEl, key: 'imageBox', corner: h.dataset.corner, startX: e.clientX, startY: e.clientY, ...px };
  });
});

txtBoxEl.querySelectorAll('.resize-handle').forEach(h => {
  h.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    const px = readPx(txtBoxEl);
    resz = { el: txtBoxEl, key: 'textBox', corner: h.dataset.corner, startX: e.clientX, startY: e.clientY, ...px };
  });
});

document.addEventListener('mousemove', e => {
  const cH      = getCanvasDisplayH();
  const otherEl = drag ? (drag.el === imgBoxEl ? txtBoxEl : imgBoxEl)
                       : resz ? (resz.el === imgBoxEl ? txtBoxEl : imgBoxEl) : null;
  const { gx, gy } = snapEnabled ? guidePositions(otherEl, CANVAS_DISPLAY_W, cH) : { gx: [], gy: [] };

  if (drag) {
    const dx  = e.clientX - drag.startX;
    const dy  = e.clientY - drag.startY;
    const w   = parseInt(drag.el.style.width);
    const h   = parseInt(drag.el.style.height);
    const rawL = Math.max(0, Math.min(CANVAS_DISPLAY_W - w, drag.startLeft + dx));
    const rawT = Math.max(0, Math.min(cH - h,               drag.startTop  + dy));
    const { left, top, guides } = snapDrag(rawL, rawT, w, h, CANVAS_DISPLAY_W, cH, otherEl);
    drag.el.style.left = left + 'px';
    drag.el.style.top  = top  + 'px';
    showGuides(guides);
  }

  if (resz) {
    const dx = e.clientX - resz.startX;
    const dy = e.clientY - resz.startY;
    let l = resz.left, t = resz.top, w = resz.width, h = resz.height;
    const c = resz.corner;
    const guides = [];

    if (c.includes('e')) {
      const r = snapEdge(Math.min(CANVAS_DISPLAY_W, resz.left + resz.width + dx), gx);
      w = Math.max(MIN_BOX_PX, r.val - l);
      if (r.guide !== null) guides.push({ type: 'v', pos: r.guide });
    }
    if (c.includes('s')) {
      const r = snapEdge(Math.min(cH, resz.top + resz.height + dy), gy);
      h = Math.max(MIN_BOX_PX, r.val - t);
      if (r.guide !== null) guides.push({ type: 'h', pos: r.guide });
    }
    if (c.includes('w')) {
      const rawL = Math.max(0, Math.min(resz.left + resz.width - MIN_BOX_PX, resz.left + dx));
      const r    = snapEdge(rawL, gx);
      w = w + (resz.left - r.val); l = r.val;
      if (r.guide !== null) guides.push({ type: 'v', pos: r.guide });
    }
    if (c.includes('n')) {
      const rawT = Math.max(0, Math.min(resz.top + resz.height - MIN_BOX_PX, resz.top + dy));
      const r    = snapEdge(rawT, gy);
      h = h + (resz.top - r.val); t = r.val;
      if (r.guide !== null) guides.push({ type: 'h', pos: r.guide });
    }

    resz.el.style.left   = l + 'px';
    resz.el.style.top    = t + 'px';
    resz.el.style.width  = w + 'px';
    resz.el.style.height = h + 'px';
    showGuides(guides);
  }
});

document.addEventListener('mouseup', () => {
  hideGuides();
  if (drag) {
    layout[drag.key] = pixelsToBox(readPx(drag.el));
    drag = null;
    saveLayoutSettings();
  }
  if (resz) {
    layout[resz.key] = pixelsToBox(readPx(resz.el));
    resz = null;
    saveLayoutSettings();
    if (parsedPages[previewPageIndex]) {
      const p = parsedPages[previewPageIndex];
      fitTextPreview(p.number === 1, previewPageIndex === parsedPages.length - 1);
    }
  }
});

// Page size inputs
function onPageSizeChange() {
  pageSize = {
    width:  parseFloat(pageSizeWEl.value)  || 8.5,
    height: parseFloat(pageSizeHEl.value)  || 8.5,
    unit:   pageSizeUEl.value,
  };
  applyLayoutToCanvas();
  saveLayoutSettings();
}
pageSizeWEl.addEventListener('change', onPageSizeChange);
pageSizeHEl.addEventListener('change', onPageSizeChange);
pageSizeUEl.addEventListener('change', onPageSizeChange);

document.getElementById('snap-toggle').addEventListener('change', e => {
  snapEnabled = e.target.checked;
});

document.getElementById('btn-reset-layout').addEventListener('click', () => {
  layout = {
    imageBox: { x: 0, y: 0, w: 1, h: 1 },
    textBox:  { x: 0.03, y: 0.61, w: 0.94, h: 0.36 },
  };
  applyLayoutToCanvas();
  saveLayoutSettings();
});

// ─── Font size sliders ────────────────────────────────────────────────────────
const fontCoverEl    = document.getElementById('font-cover');
const fontCoverValEl = document.getElementById('font-cover-val');
const fontStoryEl    = document.getElementById('font-story');
const fontStoryValEl = document.getElementById('font-story-val');
const fontLastEl     = document.getElementById('font-last');
const fontLastValEl  = document.getElementById('font-last-val');

fontCoverEl.addEventListener('input', () => {
  fontSizeCover = parseInt(fontCoverEl.value);
  fontCoverValEl.textContent = fontSizeCover;
  if (parsedPages[previewPageIndex]) {
    const p = parsedPages[previewPageIndex];
    fitTextPreview(p.number === 1, previewPageIndex === parsedPages.length - 1);
  }
});

fontStoryEl.addEventListener('input', () => {
  fontSizeStory = parseInt(fontStoryEl.value);
  fontStoryValEl.textContent = fontSizeStory;
  if (parsedPages[previewPageIndex]) {
    const p = parsedPages[previewPageIndex];
    fitTextPreview(p.number === 1, previewPageIndex === parsedPages.length - 1);
  }
});

fontLastEl.addEventListener('input', () => {
  fontSizeLast = parseInt(fontLastEl.value);
  fontLastValEl.textContent = fontSizeLast;
  if (parsedPages[previewPageIndex]) {
    const p = parsedPages[previewPageIndex];
    fitTextPreview(p.number === 1, previewPageIndex === parsedPages.length - 1);
  }
});

// ─── Text color pickers ───────────────────────────────────────────────────────
const textColorCoverEl    = document.getElementById('text-color-cover');
const textColorCoverValEl = document.getElementById('text-color-cover-val');
const textColorStoryEl    = document.getElementById('text-color-story');
const textColorStoryValEl = document.getElementById('text-color-story-val');
const textColorLastEl     = document.getElementById('text-color-last');
const textColorLastValEl  = document.getElementById('text-color-last-val');

function updateTextColorPreview() {
  if (!parsedPages[previewPageIndex]) return;
  const p = parsedPages[previewPageIndex];
  const isCover = p.number === 1;
  const isLast  = previewPageIndex === parsedPages.length - 1;
  const color   = isCover ? textColorCover : isLast ? textColorLast : textColorStory;
  previewTxtEl.style.color = color;
}

textColorCoverEl.addEventListener('input', () => {
  textColorCover = textColorCoverEl.value;
  textColorCoverValEl.textContent = textColorCover.toUpperCase();
  updateTextColorPreview();
});

textColorStoryEl.addEventListener('input', () => {
  textColorStory = textColorStoryEl.value;
  textColorStoryValEl.textContent = textColorStory.toUpperCase();
  updateTextColorPreview();
});

textColorLastEl.addEventListener('input', () => {
  textColorLast = textColorLastEl.value;
  textColorLastValEl.textContent = textColorLast.toUpperCase();
  updateTextColorPreview();
});

async function saveLayoutSettings() {
  settings.pageSize    = pageSize;
  settings.layout      = layout;
  settings.bleedIn     = bleedIn;
  settings.textBgColor = textBgColor;
  settings.landscape   = landscapeSettings;
  settings.shorts      = shortsSettings;
  await window.api.saveSettings(settings);
}

function initLayoutEditor() {
  if (settings.pageSize) {
    pageSize = settings.pageSize;
    pageSizeWEl.value = pageSize.width;
    pageSizeHEl.value = pageSize.height;
    pageSizeUEl.value = pageSize.unit;
  }
  if (settings.bleedIn != null) {
    bleedIn = settings.bleedIn;
    document.getElementById('page-bleed').value = bleedIn;
  }
  if (settings.textBgColor != null) {
    textBgColor = settings.textBgColor;
    document.getElementById('text-bg-color').value = textBgColor;
    document.getElementById('text-bg-color-val').textContent = textBgColor.toUpperCase();
  }
  if (settings.layout) layout = settings.layout;
  if (settings.landscape) {
    landscapeSettings = { textBgColor: '#ffffff', ...settings.landscape };
    syncLandscapeUI();
  }
  if (settings.shorts) {
    shortsSettings = { textBgColor: '#ffffff', ...settings.shorts };
    syncShortsUI();
  }
  applyLayoutToCanvas();
}

// ─── Layout tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.layout-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layout-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-panel-landscape').classList.toggle('visible', tab === 'landscape');
    document.getElementById('tab-panel-shorts').classList.toggle('visible',    tab === 'shorts');
  });
});

// Bleed input
document.getElementById('page-bleed').addEventListener('change', () => {
  bleedIn = parseFloat(document.getElementById('page-bleed').value) || 0.125;
  saveLayoutSettings();
});

// Book text area background
document.getElementById('text-bg-color').addEventListener('input', () => {
  textBgColor = document.getElementById('text-bg-color').value;
  document.getElementById('text-bg-color-val').textContent = textBgColor.toUpperCase();
  txtBoxEl.style.backgroundColor = textBgColor;
});
document.getElementById('text-bg-color').addEventListener('change', saveLayoutSettings);

// ─── Landscape video settings ─────────────────────────────────────────────────
function syncLandscapeUI() {
  updateLandscapePreview();
  const pct = Math.round(landscapeSettings.imgRatio * 100);
  document.getElementById('land-img-ratio').value       = pct;
  document.getElementById('land-img-ratio-val').textContent = pct;
  document.getElementById('land-txt-ratio-val').textContent = 100 - pct;
  document.getElementById('land-font-cover').value          = landscapeSettings.fontCover;
  document.getElementById('land-font-cover-val').textContent = landscapeSettings.fontCover;
  document.getElementById('land-font-story').value          = landscapeSettings.fontStory;
  document.getElementById('land-font-story-val').textContent = landscapeSettings.fontStory;
  document.getElementById('land-text-color-cover').value    = landscapeSettings.textColorCover;
  document.getElementById('land-text-color-cover-val').textContent = landscapeSettings.textColorCover.toUpperCase();
  document.getElementById('land-text-color-story').value    = landscapeSettings.textColorStory;
  document.getElementById('land-text-color-story-val').textContent = landscapeSettings.textColorStory.toUpperCase();
  document.getElementById('land-text-bg').value              = landscapeSettings.textBgColor;
  document.getElementById('land-text-bg-val').textContent    = landscapeSettings.textBgColor.toUpperCase();
}

document.getElementById('land-img-ratio').addEventListener('input', () => {
  const pct = parseInt(document.getElementById('land-img-ratio').value);
  document.getElementById('land-img-ratio-val').textContent = pct;
  document.getElementById('land-txt-ratio-val').textContent = 100 - pct;
  landscapeSettings.imgRatio = pct / 100;
  updateLandscapePreview();
});
document.getElementById('land-img-ratio').addEventListener('change', saveLayoutSettings);
document.getElementById('land-font-cover').addEventListener('input', () => {
  landscapeSettings.fontCover = parseInt(document.getElementById('land-font-cover').value);
  document.getElementById('land-font-cover-val').textContent = landscapeSettings.fontCover;
});
document.getElementById('land-font-cover').addEventListener('change', saveLayoutSettings);
document.getElementById('land-font-story').addEventListener('input', () => {
  landscapeSettings.fontStory = parseInt(document.getElementById('land-font-story').value);
  document.getElementById('land-font-story-val').textContent = landscapeSettings.fontStory;
});
document.getElementById('land-font-story').addEventListener('change', saveLayoutSettings);
document.getElementById('land-text-color-cover').addEventListener('input', () => {
  landscapeSettings.textColorCover = document.getElementById('land-text-color-cover').value;
  document.getElementById('land-text-color-cover-val').textContent = landscapeSettings.textColorCover.toUpperCase();
  updateLandscapePreview();
});
document.getElementById('land-text-color-cover').addEventListener('change', saveLayoutSettings);
document.getElementById('land-text-color-story').addEventListener('input', () => {
  landscapeSettings.textColorStory = document.getElementById('land-text-color-story').value;
  document.getElementById('land-text-color-story-val').textContent = landscapeSettings.textColorStory.toUpperCase();
  updateLandscapePreview();
});
document.getElementById('land-text-color-story').addEventListener('change', saveLayoutSettings);
document.getElementById('land-text-bg').addEventListener('input', () => {
  landscapeSettings.textBgColor = document.getElementById('land-text-bg').value;
  document.getElementById('land-text-bg-val').textContent = landscapeSettings.textBgColor.toUpperCase();
  updateLandscapePreview();
});
document.getElementById('land-text-bg').addEventListener('change', saveLayoutSettings);

// ─── Shorts video settings ────────────────────────────────────────────────────
function syncShortsUI() {
  updateShortsPreview();
  const pct = Math.round(shortsSettings.imgRatio * 100);
  document.getElementById('port-img-ratio').value       = pct;
  document.getElementById('port-img-ratio-val').textContent = pct;
  document.getElementById('port-txt-ratio-val').textContent = 100 - pct;
  document.getElementById('port-font-cover').value          = shortsSettings.fontCover;
  document.getElementById('port-font-cover-val').textContent = shortsSettings.fontCover;
  document.getElementById('port-font-story').value          = shortsSettings.fontStory;
  document.getElementById('port-font-story-val').textContent = shortsSettings.fontStory;
  document.getElementById('port-text-color-cover').value    = shortsSettings.textColorCover;
  document.getElementById('port-text-color-cover-val').textContent = shortsSettings.textColorCover.toUpperCase();
  document.getElementById('port-text-color-story').value    = shortsSettings.textColorStory;
  document.getElementById('port-text-color-story-val').textContent = shortsSettings.textColorStory.toUpperCase();
  document.getElementById('port-text-bg').value              = shortsSettings.textBgColor;
  document.getElementById('port-text-bg-val').textContent    = shortsSettings.textBgColor.toUpperCase();
}

document.getElementById('port-img-ratio').addEventListener('input', () => {
  const pct = parseInt(document.getElementById('port-img-ratio').value);
  document.getElementById('port-img-ratio-val').textContent = pct;
  document.getElementById('port-txt-ratio-val').textContent = 100 - pct;
  shortsSettings.imgRatio = pct / 100;
  updateShortsPreview();
});
document.getElementById('port-img-ratio').addEventListener('change', saveLayoutSettings);
document.getElementById('port-font-cover').addEventListener('input', () => {
  shortsSettings.fontCover = parseInt(document.getElementById('port-font-cover').value);
  document.getElementById('port-font-cover-val').textContent = shortsSettings.fontCover;
});
document.getElementById('port-font-cover').addEventListener('change', saveLayoutSettings);
document.getElementById('port-font-story').addEventListener('input', () => {
  shortsSettings.fontStory = parseInt(document.getElementById('port-font-story').value);
  document.getElementById('port-font-story-val').textContent = shortsSettings.fontStory;
});
document.getElementById('port-font-story').addEventListener('change', saveLayoutSettings);
document.getElementById('port-text-color-cover').addEventListener('input', () => {
  shortsSettings.textColorCover = document.getElementById('port-text-color-cover').value;
  document.getElementById('port-text-color-cover-val').textContent = shortsSettings.textColorCover.toUpperCase();
  updateShortsPreview();
});
document.getElementById('port-text-color-cover').addEventListener('change', saveLayoutSettings);
document.getElementById('port-text-color-story').addEventListener('input', () => {
  shortsSettings.textColorStory = document.getElementById('port-text-color-story').value;
  document.getElementById('port-text-color-story-val').textContent = shortsSettings.textColorStory.toUpperCase();
  updateShortsPreview();
});
document.getElementById('port-text-color-story').addEventListener('change', saveLayoutSettings);
document.getElementById('port-text-bg').addEventListener('input', () => {
  shortsSettings.textBgColor = document.getElementById('port-text-bg').value;
  document.getElementById('port-text-bg-val').textContent = shortsSettings.textBgColor.toUpperCase();
  updateShortsPreview();
});
document.getElementById('port-text-bg').addEventListener('change', saveLayoutSettings);

// ─── Video format previews ────────────────────────────────────────────────────
const LAND_PREVIEW_W = 380;
const LAND_PREVIEW_H = 214;
const PORT_PREVIEW_W = 180;
const PORT_PREVIEW_H = 320;

function fitVideoPreviewText(txtEl, containerW, containerH, text, fontSizePx) {
  if (!text) return;
  let fs = fontSizePx;
  const minFs = 8;
  txtEl.style.fontSize = fs + 'px';
  while (fs > minFs && (txtEl.scrollHeight > containerH || txtEl.scrollWidth > containerW)) {
    fs--;
    txtEl.style.fontSize = fs + 'px';
  }
}

function updateLandscapePreview() {
  const imgPct = landscapeSettings.imgRatio * 100;
  document.getElementById('land-preview-img-area').style.width = imgPct + '%';
  document.getElementById('land-preview-txt-area').style.backgroundColor = landscapeSettings.textBgColor;

  const page = parsedPages[previewPageIndex];
  const isCover = page && page.number === 1;
  const isLast  = page && previewPageIndex === parsedPages.length - 1;

  // Image
  const img      = document.getElementById('land-preview-img');
  const imgLabel = document.getElementById('land-preview-img-label');
  const imgIdx   = page ? page.number - 1 : 0;
  const src      = orderedImages[imgIdx] || orderedImages[0];
  if (src) {
    img.src = 'file://' + src.path.replace(/\\/g, '/');
    img.style.display = 'block';
    imgLabel.style.display = 'none';
  } else {
    img.style.display = 'none';
    imgLabel.style.display = '';
  }

  // Text
  const txt      = document.getElementById('land-preview-txt');
  const txtLabel = document.getElementById('land-preview-txt-label');
  if (page && page.text) {
    const color = isCover ? landscapeSettings.textColorCover : isLast ? landscapeSettings.textColorLast : landscapeSettings.textColorStory;
    txt.textContent    = page.text;
    txt.style.color    = color;
    txt.style.fontWeight = isCover ? 'bold' : 'normal';
    txt.style.display  = 'flex';
    txtLabel.style.display = 'none';
    const txtW      = LAND_PREVIEW_W * (1 - landscapeSettings.imgRatio);
    const startFont = isCover ? landscapeSettings.fontCover : landscapeSettings.fontStory;
    fitVideoPreviewText(txt, txtW, LAND_PREVIEW_H, page.text, Math.round(startFont * LAND_PREVIEW_W / 1920));
  } else {
    txt.style.display = 'none';
    txtLabel.style.display = '';
  }

  // Nav
  const nav = document.getElementById('land-preview-nav');
  if (parsedPages.length > 1) {
    nav.style.display = 'flex';
    document.getElementById('land-preview-page-label').textContent =
      page ? `Page ${page.number}  (${previewPageIndex + 1} / ${parsedPages.length})` : '';
    document.getElementById('land-preview-prev').disabled = previewPageIndex === 0;
    document.getElementById('land-preview-next').disabled = previewPageIndex === parsedPages.length - 1;
  } else {
    nav.style.display = parsedPages.length === 1 ? 'flex' : 'none';
    if (parsedPages.length === 1 && page) document.getElementById('land-preview-page-label').textContent = `Page ${page.number}`;
  }
}

function updateShortsPreview() {
  document.getElementById('port-preview-img-area').style.height = (shortsSettings.imgRatio * 100) + '%';
  document.getElementById('port-preview-txt-area').style.backgroundColor = shortsSettings.textBgColor;

  const page = parsedPages[previewPageIndex];
  const isCover = page && page.number === 1;

  // Image
  const img      = document.getElementById('port-preview-img');
  const imgLabel = document.getElementById('port-preview-img-label');
  const imgIdx   = page ? page.number - 1 : 0;
  const src      = orderedImages[imgIdx] || orderedImages[0];
  if (src) {
    img.src = 'file://' + src.path.replace(/\\/g, '/');
    img.style.display = 'block';
    imgLabel.style.display = 'none';
  } else {
    img.style.display = 'none';
    imgLabel.style.display = '';
  }

  // Text
  const txt      = document.getElementById('port-preview-txt');
  const txtLabel = document.getElementById('port-preview-txt-label');
  if (page && page.text) {
    txt.textContent    = page.text;
    txt.style.color    = isCover ? shortsSettings.textColorCover : shortsSettings.textColorStory;
    txt.style.fontWeight = isCover ? 'bold' : 'normal';
    txt.style.display  = 'flex';
    txtLabel.style.display = 'none';
    const txtH      = PORT_PREVIEW_H * (1 - shortsSettings.imgRatio);
    const startFont = isCover ? shortsSettings.fontCover : shortsSettings.fontStory;
    fitVideoPreviewText(txt, PORT_PREVIEW_W, txtH, page.text, Math.round(startFont * PORT_PREVIEW_W / 1080));
  } else {
    txt.style.display = 'none';
    txtLabel.style.display = '';
  }

  // Nav
  const nav = document.getElementById('port-preview-nav');
  if (parsedPages.length > 1) {
    nav.style.display = 'flex';
    document.getElementById('port-preview-page-label').textContent =
      page ? `Page ${page.number}  (${previewPageIndex + 1} / ${parsedPages.length})` : '';
    document.getElementById('port-preview-prev').disabled = previewPageIndex === 0;
    document.getElementById('port-preview-next').disabled = previewPageIndex === parsedPages.length - 1;
  } else {
    nav.style.display = parsedPages.length === 1 ? 'flex' : 'none';
    if (parsedPages.length === 1 && page) document.getElementById('port-preview-page-label').textContent = `Page ${page.number}`;
  }
}

// ─── Layout Preview ───────────────────────────────────────────────────────────
const previewImgEl = document.getElementById('layout-preview-img');
const previewTxtEl = document.getElementById('layout-preview-txt');
const imgLabelEl   = document.getElementById('layout-img-label');
const txtLabelEl   = document.getElementById('layout-txt-label');
const previewNav   = document.getElementById('preview-nav');
const prevPageBtn  = document.getElementById('preview-prev');
const nextPageBtn  = document.getElementById('preview-next');
const pageLabelEl  = document.getElementById('preview-page-label');

let parsedPages      = [];   // [{number, text}]
let previewPageIndex = 0;

// Parse all pages from paste content — must match parseBookTxt in build-book.js exactly.
const TEXT_STOP_RE = /^(Image\s*:|Visual\s+Description\s*:|AI\s+Image\s+Prompt\s*:|Part\s+\d+\s*:|Character\s+Sheet\s*:|Marketing\s+Copy\s*:|Back\s+Cover\s*:|---)/i;

function stripMarkdownLine(raw) {
  return raw
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g,     '$1')
    .replace(/_{2}([^_\n]+)_{2}/g, '$1')
    .replace(/^#{1,6}\s+/,          '');
}

function parseAllPages(content) {
  const pages = [];
  let cur = null, collecting = false, textLines = [];
  const flush = () => { if (cur && textLines.length) { cur.text = textLines.join('\n').trim(); textLines = []; } };
  for (const raw of content.split(/\r?\n/)) {
    const line = stripMarkdownLine(raw).trim();
    const pm = /^Page\s+(\d+)\s*:/i.exec(line);
    if (pm) {
      flush(); if (cur) pages.push(cur);
      cur = { number: parseInt(pm[1]), text: '' }; collecting = false; continue;
    }
    if (!cur) continue;
    const textMatch = /^Text[^:]*:\s*(.*)/i.exec(line);
    if (textMatch) {
      collecting = true;
      const inline = textMatch[1].trim();
      if (inline) textLines.push(inline); continue;
    }
    if (TEXT_STOP_RE.test(line)) { collecting = false; continue; }
    if (collecting) {
      const cm = /^Line\s*\d+\s*:\s*(.*)/i.exec(line);
      if (cm) { if (cm[1].trim()) textLines.push(cm[1].trim()); continue; }
      if (line === '') { textLines.push(''); } else { textLines.push(line); }
    }
  }
  flush(); if (cur) pages.push(cur);
  return pages.filter(p => p.text && p.text.trim());
}

function fitTextPreview(isCover = false, isLast = false) {
  if (previewTxtEl.style.display === 'none') return;
  const boxH = parseInt(txtBoxEl.style.height) || 60;
  const boxW = parseInt(txtBoxEl.style.width)  || 100;

  // Scale the output starting font proportionally to the preview canvas size.
  const { w: pagePxW } = pageToPx();
  const previewScale   = CANVAS_DISPLAY_W / pagePxW;
  const outputStart    = isCover ? fontSizeCover : isLast ? fontSizeLast : fontSizeStory;

  let fs      = Math.max(10, Math.round(outputStart * previewScale));
  const minFs = Math.max(8,  Math.round(18 * previewScale));

  previewTxtEl.style.fontSize = fs + 'px';
  while (fs > minFs && previewTxtEl.scrollHeight > previewTxtEl.clientHeight) {
    fs--;
    previewTxtEl.style.fontSize = fs + 'px';
  }
}

function showPreviewPage(idx) {
  previewPageIndex = Math.max(0, Math.min(parsedPages.length - 1, idx));
  updateLandscapePreview();
  updateShortsPreview();
  const page = parsedPages[previewPageIndex];
  if (!page) return;

  // Image: match by page number (page N uses orderedImages[N-1])
  const imgIdx = page.number - 1;
  const img    = orderedImages[imgIdx] || orderedImages[0];
  if (img) {
    previewImgEl.src          = 'file://' + img.path.replace(/\\/g, '/');
    previewImgEl.style.display = 'block';
    imgLabelEl.style.display   = 'none';
  } else {
    previewImgEl.style.display = 'none';
    imgLabelEl.style.display   = '';
  }

  // Text: match output — bold on page 1 (cover), per-category color
  const isCover = page.number === 1;
  const isLast  = previewPageIndex === parsedPages.length - 1;
  txtBoxEl.style.backgroundColor = textBgColor;
  if (page.text) {
    previewTxtEl.textContent       = page.text;
    previewTxtEl.style.display     = 'flex';
    previewTxtEl.style.fontWeight  = isCover ? 'bold' : 'normal';
    previewTxtEl.style.color       = isCover ? textColorCover : isLast ? textColorLast : textColorStory;
    txtLabelEl.style.display       = 'none';
    txtBoxEl.classList.add('has-preview');
    fitTextPreview(isCover, isLast);
  } else {
    previewTxtEl.style.display = 'none';
    txtLabelEl.style.display   = '';
    txtBoxEl.classList.remove('has-preview');
  }

  // Nav controls
  if (parsedPages.length > 1) {
    previewNav.style.display  = 'flex';
    pageLabelEl.textContent   = `Page ${page.number}  (${previewPageIndex + 1} / ${parsedPages.length})`;
    prevPageBtn.disabled      = previewPageIndex === 0;
    nextPageBtn.disabled      = previewPageIndex === parsedPages.length - 1;
  } else {
    previewNav.style.display  = parsedPages.length === 1 ? 'flex' : 'none';
    if (parsedPages.length === 1) pageLabelEl.textContent = `Page ${page.number}`;
  }
}

function updateImagePreview() {
  updateLandscapePreview();
  updateShortsPreview();
  if (parsedPages.length > 0) {
    showPreviewPage(previewPageIndex);
  } else if (orderedImages.length > 0) {
    previewImgEl.src          = 'file://' + orderedImages[0].path.replace(/\\/g, '/');
    previewImgEl.style.display = 'block';
    imgLabelEl.style.display   = 'none';
  } else {
    previewImgEl.style.display = 'none';
    imgLabelEl.style.display   = '';
  }
}

function updateTextPreview() {
  const content = bookTextarea.value;
  parsedPages = content.trim() ? parseAllPages(content) : [];
  previewPageIndex = Math.min(previewPageIndex, Math.max(0, parsedPages.length - 1));
  updateLandscapePreview();
  updateShortsPreview();

  if (parsedPages.length > 0) {
    showPreviewPage(previewPageIndex);
  } else {
    previewTxtEl.style.display = 'none';
    txtLabelEl.style.display   = '';
    txtBoxEl.classList.remove('has-preview');
    previewNav.style.display   = 'none';
    updateImagePreview();
  }
}

prevPageBtn.addEventListener('click', () => showPreviewPage(previewPageIndex - 1));
nextPageBtn.addEventListener('click', () => showPreviewPage(previewPageIndex + 1));

document.getElementById('land-preview-prev').addEventListener('click', () => showPreviewPage(previewPageIndex - 1));
document.getElementById('land-preview-next').addEventListener('click', () => showPreviewPage(previewPageIndex + 1));
document.getElementById('port-preview-prev').addEventListener('click', () => showPreviewPage(previewPageIndex - 1));
document.getElementById('port-preview-next').addEventListener('click', () => showPreviewPage(previewPageIndex + 1));

// ─── Drop zones ────────────────────────────────────────────────────────────────
function setupDropZone(el, accept, onDrop) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const item = e.dataTransfer.files[0];
    if (item) onDrop(item.path, item.name);
  });
  el.addEventListener('click', async () => {
    if (accept === 'directory') {
      const result = await window.api.openDirectory();
      if (result) onDrop(result, result.split(/[\\/]/).pop());
    } else {
      const result = await window.api.openFile([{ name: 'Text File', extensions: ['txt'] }]);
      if (result) onDrop(result, result.split(/[\\/]/).pop());
    }
  });
}

const dzImg       = document.getElementById('dz-img');
const dzImgStatus = document.getElementById('dz-img-status');

setupDropZone(dzImg, 'directory', async (dirPath, name) => {
  imagesDirPath = dirPath;
  dzImgStatus.textContent = '✓ ' + name;
  dzImg.classList.add('ready');
  await loadImageSorter(dirPath);
});

// ─── Image sorter ──────────────────────────────────────────────────────────────
const imageSorterWrap = document.getElementById('image-sorter-wrap');
const imageSorterEl   = document.getElementById('image-sorter');
const sorterCount     = document.getElementById('sorter-count');

async function loadImageSorter(dirPath) {
  const images = await window.api.getImageList(dirPath);
  orderedImages = images;
  renderSorter();
  imageSorterWrap.style.display = '';
  updateImagePreview();
}

function renderSorter() {
  imageSorterEl.innerHTML = '';
  sorterCount.textContent = `${orderedImages.length} image${orderedImages.length !== 1 ? 's' : ''}`;
  updateImagePreview();

  orderedImages.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'img-item';
    item.draggable = true;
    item.dataset.path = img.path;
    item.dataset.name = img.name;

    item.innerHTML = `
      <img class="img-thumb" src="file://${img.path.replace(/\\/g, '/')}" alt="${img.name}"/>
      <div class="img-item-footer">
        <span class="img-name" title="${img.name}">${img.name}</span>
        <span class="page-badge">P${idx + 1}</span>
      </div>
    `;

    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragend',   onDragEnd);
    imageSorterEl.appendChild(item);
  });

  imageSorterEl.addEventListener('dragover', onContainerDragOver);
  imageSorterEl.addEventListener('drop',     onContainerDrop);
}

let dragSrcEl   = null;
let placeholder = null;

function onDragStart(e) {
  dragSrcEl = e.currentTarget;
  dragSrcEl.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';

  placeholder = document.createElement('div');
  placeholder.className = 'img-placeholder';
  const r = dragSrcEl.getBoundingClientRect();
  placeholder.style.height = r.height + 'px';
}

function getInsertionPoint(mouseX, mouseY) {
  const items = [...imageSorterEl.querySelectorAll('.img-item:not(.dragging)')];
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const onSameRowLeftOfCenter = mouseY >= r.top && mouseY <= r.bottom && mouseX < r.left + r.width / 2;
    const aboveRow = mouseY < r.top;
    if (onSameRowLeftOfCenter || aboveRow) return item;
  }
  return null;
}

function onContainerDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!placeholder) return;

  const insertBefore = getInsertionPoint(e.clientX, e.clientY);

  // Skip if placeholder is already in the right spot
  const targetNext = insertBefore || null;
  if (placeholder.nextSibling === targetNext) return;

  // FLIP: snapshot positions before the DOM change
  const items = [...imageSorterEl.querySelectorAll('.img-item:not(.dragging)')];
  const before = new Map(items.map(el => [el, el.getBoundingClientRect()]));

  // Move placeholder
  if (insertBefore) imageSorterEl.insertBefore(placeholder, insertBefore);
  else              imageSorterEl.appendChild(placeholder);

  // FLIP: animate each item from its old position to its new position
  items.forEach(el => {
    const first = before.get(el);
    const last  = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top  - last.top;
    if (dx === 0 && dy === 0) return;

    // Snap back to old position instantly, then transition to new
    el.style.transition = 'none';
    el.style.transform  = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = 'transform 200ms cubic-bezier(0.25, 1, 0.5, 1)';
      el.style.transform  = '';
    }));
  });
}

function onContainerDrop(e) {
  e.preventDefault();
  if (!dragSrcEl || !placeholder) return;

  const allNodes   = [...imageSorterEl.children];
  const dropIdx    = allNodes.indexOf(placeholder);
  const srcIdx     = orderedImages.findIndex(i => i.path === dragSrcEl.dataset.path);

  placeholder.remove();
  placeholder = null;

  const moved    = orderedImages.splice(srcIdx, 1)[0];
  const insertAt = Math.min(srcIdx < dropIdx ? dropIdx - 1 : dropIdx, orderedImages.length);
  orderedImages.splice(insertAt, 0, moved);

  renderSorter();
}

function onDragEnd() {
  if (placeholder) { placeholder.remove(); placeholder = null; }
  imageSorterEl.querySelectorAll('.img-item').forEach(el => {
    el.classList.remove('dragging');
    el.style.transform  = '';
    el.style.transition = '';
  });
  dragSrcEl = null;
}

// ─── Progress helpers ──────────────────────────────────────────────────────────
function setProgress(bar, pctEl, labelEl, pct, label) {
  bar.style.width = pct + '%';
  pctEl.textContent = Math.round(pct) + '%';
  if (label) labelEl.textContent = label;
}

function appendLog(logEl, text, type) {
  const span = document.createElement('span');
  if (type) span.className = 'log-' + type;
  span.textContent = text;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

function resetBuild(progressEl, bar, pctEl, labelEl, logEl, doneEl) {
  progressEl.classList.add('visible');
  bar.classList.remove('success');
  bar.style.width = '0%';
  pctEl.textContent = '0%';
  labelEl.textContent = 'Building…';
  logEl.textContent = '';
  doneEl.classList.remove('visible');
}

// ─── Book progress parser ──────────────────────────────────────────────────────
function makeBookTracker() {
  let total = 0, built = 0;
  return line => {
    const m = line.match(/Parsed (\d+) pages/);
    if (m) { total = parseInt(m[1]); return 5; }
    if (/Built page \d+/.test(line) || /Built copyright/.test(line) || /Inserted blank/.test(line)) {
      built++;
      return total > 0 ? 5 + (built / (total + 2)) * 90 : null;
    }
    if (/^Done!/.test(line.trim())) return 100;
    return null;
  };
}

// ─── Video progress parser ─────────────────────────────────────────────────────
// Processes one line at a time. Returns a new % only if it would move forward.
function makeVideoTracker() {
  let total = 0, pagesDone = 0, current = 0;

  return line => {
    const parsedMatch = line.match(/Parsed (\d+) pages/);
    if (parsedMatch) { total = parseInt(parsedMatch[1]); return forward(2); }

    // Each narrated page logs "TTS..." and "narration starts at" on the same line.
    // Count it as one page completing when we see "narration starts at".
    if (/narration starts at/.test(line)) {
      pagesDone++;
      return forward(total > 0 ? 5 + (pagesDone / total) * 65 : null);
    }
    if (/Assembling \d+ clips/.test(line))   return forward(72);
    if (/Generating 16:9/.test(line))        return forward(85);
    if (/Generating 9:16/.test(line))        return forward(93);
    if (/All done!/.test(line))              return forward(100);
    return null;
  };

  function forward(pct) {
    if (pct === null || pct === undefined) return null;
    if (pct <= current) return null;   // never go backwards
    current = pct;
    return pct;
  }
}

// ─── Build Book ────────────────────────────────────────────────────────────────
const btnBook       = document.getElementById('btn-book');
const bookProgress  = document.getElementById('book-progress');
const bookProgressLabel = document.getElementById('book-progress-label');
const bookProgressPct   = document.getElementById('book-progress-pct');
const bookBar       = document.getElementById('book-bar');
const bookLog       = document.getElementById('book-log');
const bookDone      = document.getElementById('book-done');
const bookTextarea  = document.getElementById('book-textarea');
bookTextarea.addEventListener('input', updateTextPreview);

btnBook.addEventListener('click', async () => {
  if (!bookTextarea.value.trim()) return alert('Please paste your book.txt content first.');
  if (orderedImages.length === 0) return alert('Please select your images folder first.');

  btnBook.disabled = true;
  resetBuild(bookProgress, bookBar, bookProgressPct, bookProgressLabel, bookLog, bookDone);
  setProgress(bookBar, bookProgressPct, bookProgressLabel, 2, 'Copying input files…');

  try {
    await window.api.saveBookTxtContent(bookTextarea.value);

    // Copy images in the user's chosen order
    const count = await window.api.copyImagesOrdered(orderedImages.map(i => i.path));
    appendLog(bookLog, `Copied book text and ${count} images (in display order).\n`, 'success');
    setProgress(bookBar, bookProgressPct, bookProgressLabel, 5, 'Building…');

    const track = makeBookTracker();
    window.api.offBuildLog();
    window.api.onBuildLog(line => {
      appendLog(bookLog, line, /error|fail/i.test(line) ? 'error' : null);
      const pct = track(line);
      if (pct !== null) setProgress(bookBar, bookProgressPct, bookProgressLabel, pct, pct === 100 ? 'Done!' : 'Building…');
    });

    await window.api.buildBook({
      pageSize, layout, bleedIn, textBgColor,
      fontSizeCover, fontSizeStory, fontSizeLast,
      textColorCover, textColorStory, textColorLast,
    });
    bookBar.classList.add('success');
    setProgress(bookBar, bookProgressPct, bookProgressLabel, 100, 'Done!');
    bookDone.classList.add('visible');
  } catch (err) {
    appendLog(bookLog, '\n' + (err.message || String(err)), 'error');
    setProgress(bookBar, bookProgressPct, bookProgressLabel, 0, 'Failed');
  } finally {
    window.api.offBuildLog();
    btnBook.disabled = false;
  }
});

document.getElementById('book-open-output').addEventListener('click', () => window.api.openOutput());

// ─── Build Video ───────────────────────────────────────────────────────────────
const btnVideo            = document.getElementById('btn-video');
const btnCancelVideo      = document.getElementById('btn-cancel-video');
const btnSelectMusic      = document.getElementById('btn-select-music');
const musicFileName       = document.getElementById('music-file-name');
const btnSelectThumbnail  = document.getElementById('btn-select-thumbnail');
const thumbnailFileName   = document.getElementById('thumbnail-file-name');
const videoProgress   = document.getElementById('video-progress');
const videoProgressLabel = document.getElementById('video-progress-label');
const videoProgressPct   = document.getElementById('video-progress-pct');
const videoBar        = document.getElementById('video-bar');
const videoLog        = document.getElementById('video-log');
const videoDone       = document.getElementById('video-done');
const clearCacheChk   = document.getElementById('clear-cache');

let selectedMusicPath      = null;
let selectedThumbnailPath  = null;
let selectedIntroMusicPath = null;
let selectedIntroImagePath = null;

// Music file picker
btnSelectMusic.addEventListener('click', async () => {
  const result = await window.api.openFile([
    { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'] },
  ]);
  if (result) {
    selectedMusicPath = result;
    musicFileName.textContent = result.split(/[\\/]/).pop();
  }
});

// Shorts thumbnail picker
btnSelectThumbnail.addEventListener('click', async () => {
  const result = await window.api.openFile([
    { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
  ]);
  if (result) {
    selectedThumbnailPath = result;
    thumbnailFileName.textContent = result.split(/[\\/]/).pop();
  }
});

// Intro volume slider
const introMusicVolEl    = document.getElementById('intro-music-vol');
const introMusicVolValEl = document.getElementById('intro-music-vol-val');
introMusicVolEl.addEventListener('input', () => {
  introMusicVolValEl.textContent = Number(introMusicVolEl.value).toFixed(2);
});

// Intro song picker
document.getElementById('btn-select-intro-music').addEventListener('click', async () => {
  const result = await window.api.openFile([
    { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'] },
  ]);
  if (result) {
    selectedIntroMusicPath = result;
    document.getElementById('intro-music-file-name').textContent = result.split(/[\\/]/).pop();
  }
});

// Intro image picker
document.getElementById('btn-select-intro-image').addEventListener('click', async () => {
  const result = await window.api.openFile([
    { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
  ]);
  if (result) {
    selectedIntroImagePath = result;
    const nameEl  = document.getElementById('intro-image-file-name');
    const labelEl = document.getElementById('intro-show-text-label');
    nameEl.textContent   = result.split(/[\\/]/).pop();
    nameEl.style.color      = '';
    nameEl.style.fontStyle  = '';
    labelEl.style.display   = 'flex';
  }
});

// Cancel button
btnCancelVideo.addEventListener('click', async () => {
  btnCancelVideo.disabled = true;
  btnCancelVideo.textContent = 'Cancelling…';
  await window.api.cancelBuild();
});

function setVideoBuildingState(isBuilding) {
  btnVideo.disabled       = isBuilding;
  btnCancelVideo.style.display = isBuilding ? '' : 'none';
  btnCancelVideo.disabled = false;
  btnCancelVideo.textContent = '✕ Cancel';
}

btnVideo.addEventListener('click', async () => {
  const pagesReady = await window.api.pagesExist();
  if (!pagesReady) return alert('Please build the book first — the video builder needs the page images.');

  setVideoBuildingState(true);
  resetBuild(videoProgress, videoBar, videoProgressPct, videoProgressLabel, videoLog, videoDone);
  setProgress(videoBar, videoProgressPct, videoProgressLabel, 2, 'Starting…');

  const track = makeVideoTracker();
  window.api.offBuildLog();
  window.api.onBuildLog(chunk => {
    appendLog(videoLog, chunk, /error|fail/i.test(chunk) ? 'error' : null);
    for (const line of chunk.split(/\r?\n/)) {
      const pct = track(line);
      if (pct !== null) {
        const label = pct >= 100 ? 'Done!' : pct >= 93 ? 'Generating 9:16 Shorts…' : pct >= 85 ? 'Generating 16:9 variant…' : pct >= 72 ? 'Assembling video…' : 'Generating narration…';
        setProgress(videoBar, videoProgressPct, videoProgressLabel, pct, label);
      }
    }
  });

  try {
    await window.api.saveBookTxtContent(bookTextarea.value);
    const introDurRaw = parseFloat(document.getElementById('intro-duration-override').value);
    await window.api.buildVideo({
      voice:                settings.voice,
      ttsVolume:            settings.ttsVolume,
      musicVolume:          settings.musicVolume,
      clearCache:           clearCacheChk.checked,
      musicPath:            selectedMusicPath,
      highlightColor:       settings.highlightColor || '#FF8800',
      highlightStyle:       settings.highlightStyle || 'box',
      fontSizeCover,
      fontSizeStory,
      shortsThumbnailPath:  selectedThumbnailPath,
      landscape:            landscapeSettings,
      shorts:               shortsSettings,
      introMusicPath:        selectedIntroMusicPath,
      introDurationOverride: isFinite(introDurRaw) && introDurRaw > 0 ? introDurRaw : 0,
      introMusicVolume:      parseFloat(introMusicVolEl.value),
      introImagePath:        selectedIntroImagePath,
      introShowText:         document.getElementById('intro-show-text').checked,
    });
    videoBar.classList.add('success');
    setProgress(videoBar, videoProgressPct, videoProgressLabel, 100, 'Done!');
    videoDone.classList.add('visible');
  } catch (err) {
    const cancelled = err.message === 'BUILD_CANCELLED';
    if (cancelled) {
      appendLog(videoLog, '\nBuild cancelled.', 'error');
      setProgress(videoBar, videoProgressPct, videoProgressLabel, 0, 'Cancelled');
    } else {
      appendLog(videoLog, '\n' + (err.message || String(err)), 'error');
      setProgress(videoBar, videoProgressPct, videoProgressLabel, 0, 'Failed');
    }
  } finally {
    window.api.offBuildLog();
    setVideoBuildingState(false);
  }
});

document.getElementById('video-open-output').addEventListener('click', () => window.api.openOutput());
document.getElementById('btn-music-folder').addEventListener('click', () => window.api.openMusicFolder());

// ─── Inline settings (live, auto-save) ────────────────────────────────────────
const setVoice       = document.getElementById('set-voice');
const setTtsVol           = document.getElementById('set-tts-vol');
const setTtsVolVal        = document.getElementById('set-tts-vol-val');
const setMusicVol         = document.getElementById('set-music-vol');
const setMusicVolVal      = document.getElementById('set-music-vol-val');
const setHighlightColor    = document.getElementById('set-highlight-color');
const setHighlightColorVal = document.getElementById('set-highlight-color-val');
const setHighlightStyle    = document.getElementById('set-highlight-style');

function syncSettingsUI() {
  setVoice.value                   = settings.voice;
  setTtsVol.value                  = settings.ttsVolume;
  setTtsVolVal.textContent         = Number(settings.ttsVolume).toFixed(1);
  setMusicVol.value                = settings.musicVolume;
  setMusicVolVal.textContent       = Number(settings.musicVolume).toFixed(2);
  setHighlightColor.value          = settings.highlightColor || '#FF8800';
  setHighlightColorVal.textContent = settings.highlightColor || '#FF8800';
  setHighlightStyle.value          = settings.highlightStyle || 'box';
}

async function saveInlineSettings() {
  settings.voice          = setVoice.value;
  settings.ttsVolume      = parseFloat(setTtsVol.value);
  settings.musicVolume    = parseFloat(setMusicVol.value);
  settings.highlightColor = setHighlightColor.value;
  settings.highlightStyle = setHighlightStyle.value;
  await window.api.saveSettings(settings);
}

setVoice.addEventListener('change', saveInlineSettings);

setTtsVol.addEventListener('input', () => {
  setTtsVolVal.textContent = Number(setTtsVol.value).toFixed(1);
});
setTtsVol.addEventListener('change', saveInlineSettings);

setMusicVol.addEventListener('input', () => {
  setMusicVolVal.textContent = Number(setMusicVol.value).toFixed(2);
});
setMusicVol.addEventListener('change', saveInlineSettings);

setHighlightColor.addEventListener('input', () => {
  setHighlightColorVal.textContent = setHighlightColor.value.toUpperCase();
});
setHighlightColor.addEventListener('change', saveInlineSettings);
setHighlightStyle.addEventListener('change', saveInlineSettings);
