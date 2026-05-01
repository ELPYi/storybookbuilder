'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// APP_ROOT: where the app's scripts/node_modules live (inside asar or dev folder)
const APP_ROOT  = path.resolve(__dirname, '..');
// ROOT: alias kept for non-packaged paths (FFmpeg, music default location)
const ROOT      = APP_ROOT;
// DATA_ROOT: where user data (input/output/music) lives — userData in production, APP_ROOT in dev
const DATA_ROOT = app.isPackaged ? app.getPath('userData') : APP_ROOT;
const SETTINGS_PATH = path.join(app.getPath('userData'), 'storybook-settings.json');

// ─── Ensure FFmpeg is on PATH ──────────────────────────────────────────────────
// In packaged mode: use bundled ffmpeg-bin from extraResources.
// In dev mode: scan WinGet packages directory as before.
(function ensureFfmpegOnPath() {
  const sep = process.platform === 'win32' ? ';' : ':';

  function addToPath(dir) {
    if (fs.existsSync(path.join(dir, 'ffmpeg.exe')) && !process.env.PATH.includes(dir)) {
      process.env.PATH = dir + sep + process.env.PATH;
    }
  }

  // Packaged app: ffmpeg bundled alongside app in resources/ffmpeg-bin/
  if (app.isPackaged) {
    addToPath(path.join(process.resourcesPath, 'ffmpeg-bin'));
    return;
  }

  // Dev: check local ffmpeg-bin folder first
  const localBin = path.join(APP_ROOT, 'ffmpeg-bin');
  if (fs.existsSync(path.join(localBin, 'ffmpeg.exe'))) {
    addToPath(localBin);
    return;
  }

  // Dev fallback: scan WinGet packages
  const wingetBase = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(wingetBase)) return;
  for (const pkg of fs.readdirSync(wingetBase)) {
    if (!pkg.startsWith('Gyan.FFmpeg')) continue;
    const binDir = path.join(wingetBase, pkg, fs.readdirSync(path.join(wingetBase, pkg))[0], 'bin');
    addToPath(binDir);
    break;
  }
})();

// ─── Settings ──────────────────────────────────────────────────────────────────
function defaultSettings() {
  return {
    voice: 'af_heart', ttsVolume: 1.0, musicVolume: 0.05,
    highlightColor: '#FF8800', highlightStyle: 'box',
    pageSize: { width: 8.5, height: 8.5, unit: 'in' },
    bleedIn: 0.125,
    layout: {
      imageBox: { x: 0, y: 0, w: 1, h: 1 },
      textBox:  { x: 0.03, y: 0.61, w: 0.94, h: 0.36 },
    },
    landscape: {
      imgRatio: 0.6,
      fontCover: 90, fontStory: 48,
      textColorCover: '#000000', textColorStory: '#000000',
    },
    shorts: {
      imgRatio: 0.6,
      fontCover: 90, fontStory: 80,
      textColorCover: '#000000', textColorStory: '#000000',
    },
  };
}
function loadSettings() {
  try { return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return defaultSettings(); }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// ─── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 780,
    minWidth: 720,
    minHeight: 600,
    title: 'Storybook Builder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// ─── Python first-run setup ────────────────────────────────────────────────────
// On first launch, checks Python + required packages are installed.
// If not, shows a setup window, installs them, then opens the main window.
// On all subsequent launches the flag file is found and setup is skipped.

const SETUP_FLAG = path.join(app.getPath('userData'), '.python-setup-v1');

function runCmd(cmd, args, onData) {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { shell: true });
    if (onData) {
      proc.stdout.on('data', d => onData(d.toString()));
      proc.stderr.on('data', d => onData(d.toString()));
    }
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function setupPythonEnv(setupWin) {
  function log(msg)    { if (!setupWin.isDestroyed()) setupWin.webContents.send('setup:log',    msg); }
  function status(msg) { if (!setupWin.isDestroyed()) setupWin.webContents.send('setup:status', msg); }
  function error(msg)  { if (!setupWin.isDestroyed()) setupWin.webContents.send('setup:error',  msg); }

  // Step 1: Check for Python launcher
  status('Checking for Python...');
  log('Checking for Python (py launcher)...\n');
  const pyOk = await runCmd('py', ['--version'], d => log(d));

  if (!pyOk) {
    status('Installing Python 3.12...\nThis may take a few minutes, please wait.');
    log('\nPython not found. Installing via Windows package manager...\n');
    const installed = await runCmd('winget', [
      'install', 'Python.Python.3.12',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ], d => log(d));

    if (!installed) {
      error(
        'Could not install Python automatically.<br><br>' +
        'Please install Python 3.12 from <b>python.org</b>, then relaunch Storybook Builder.'
      );
      return false;
    }
    log('\nPython installed.\n');
  }

  // Step 2: Check required packages individually — only install what's missing.
  // Use "pip show" (not "import") so a package with broken transitive deps doesn't
  // falsely appear missing. Install one at a time to avoid pip's "resolution too
  // deep" error that occurs when the combined dependency graph is too complex.
  status('Checking for AI packages...');
  log('\nChecking Python packages...\n');

  const pipPkgs = ['kokoro', 'faster-whisper', 'numpy', 'soundfile'];
  const missing = [];
  for (const pkg of pipPkgs) {
    const ok = await runCmd('py', ['-m', 'pip', 'show', pkg], null);
    if (!ok) missing.push(pkg);
  }

  if (missing.length > 0) {
    status('Installing AI packages...\nThis may take several minutes — please keep the window open.');
    log(`\nInstalling: ${missing.join(', ')}\n`);
    log('(Downloading AI models — this only happens once)\n\n');

    for (const pkg of missing) {
      log(`\n▶ Installing ${pkg}...\n`);
      // --only-binary :all: prevents source builds (fail on Python 3.14+ without a C compiler).
      const ok = await runCmd(
        'py', ['-m', 'pip', 'install', '--only-binary', ':all:', pkg],
        d => log(d)
      );
      if (!ok) {
        error(
          'Could not install required packages.<br><br>' +
          'Please check your internet connection and relaunch Storybook Builder.'
        );
        return false;
      }
    }
    log('\nAll packages installed successfully!\n');
  }

  fs.writeFileSync(SETUP_FLAG, new Date().toISOString());
  status('Setup complete! Launching...');
  return true;
}

// ─── First-run data dirs ────────────────────────────────────────────────────────
// Ensures user data directories exist. In packaged mode, copies default music
// from app resources to userData if the music folder doesn't exist yet.
function ensureUserDataDirs() {
  ['input', 'input/images', 'output', 'output/pages', 'output/video', 'music'].forEach(d =>
    fs.mkdirSync(path.join(DATA_ROOT, d), { recursive: true })
  );

  if (app.isPackaged) {
    const userMusicDir  = path.join(DATA_ROOT, 'music');
    const bundledMusic  = path.join(process.resourcesPath, 'music');
    if (fs.existsSync(bundledMusic) && fs.readdirSync(userMusicDir).length === 0) {
      for (const f of fs.readdirSync(bundledMusic)) {
        fs.copyFileSync(path.join(bundledMusic, f), path.join(userMusicDir, f));
      }
    }
  }
}

app.whenReady().then(async () => {
  ensureUserDataDirs();

  if (fs.existsSync(SETUP_FLAG)) {
    // Already set up — open main window immediately
    createWindow();
    return;
  }

  // First launch: show setup window, then open main window on success
  const setupWin = new BrowserWindow({
    width: 580,
    height: 440,
    resizable: false,
    title: 'Storybook Builder — Setting up',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.setMenu(null);
  setupWin.loadFile(path.join(__dirname, 'setup.html'));

  // Wait for the setup window to fully load before sending IPC messages
  await new Promise(resolve => setupWin.webContents.once('did-finish-load', resolve));

  const ok = await setupPythonEnv(setupWin);
  if (ok && !setupWin.isDestroyed()) {
    setupWin.close();
    createWindow();
  }
  // If not ok, the error is shown in setupWin — leave it open for the user to read
});
app.on('window-all-closed', () => app.quit());

// ─── Helpers ───────────────────────────────────────────────────────────────────
function pageSizeToPx(pageSize) {
  const DPI = 300;
  const { width, height, unit } = pageSize;
  if (unit === 'cm') return { w: Math.round(width * DPI / 2.54), h: Math.round(height * DPI / 2.54) };
  if (unit === 'px') return { w: Math.round(width),              h: Math.round(height) };
  return { w: Math.round(width * DPI), h: Math.round(height * DPI) }; // inches (default)
}

// ─── IPC: Settings ─────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_, s) => saveSettings(s));

// ─── IPC: Dialogs ──────────────────────────────────────────────────────────────
ipcMain.handle('dialog:open-file', async (_, filters) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('dialog:open-directory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

// ─── IPC: File helpers ─────────────────────────────────────────────────────────

// Save pasted text content directly as book.txt.
// Handles raw Gemini Gem output: strips markdown, extracts STORYBOOK SCRIPT block if present,
// and auto-normalizes keywords onto their own lines.
ipcMain.handle('files:save-book-txt-content', (_, content) => {
  fs.mkdirSync(path.join(DATA_ROOT, 'input'), { recursive: true });

  // Step 1: Extract the clean script block if the Gem included delimiters.
  // Matches both "--- STORYBOOK SCRIPT ---" and "---STORYBOOK SCRIPT---" variants.
  const blockMatch = content.match(
    /---+\s*STORYBOOK SCRIPT\s*---+\r?\n([\s\S]*?)\r?\n---+\s*END(?: SCRIPT)?\s*---+/i
  );
  let working = blockMatch ? blockMatch[1] : content;

  // Step 2: Strip Markdown formatting that Gemini adds to its output.
  working = working
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')   // **bold**
    .replace(/\*([^*\n]+)\*/g,     '$1')   // *italic*
    .replace(/_{2}([^_\n]+)_{2}/g, '$1')   // __underline__
    .replace(/^#{1,6}\s+/gm,        '');   // ## headings

  // Step 3: Detect if structured keywords are already on their own lines.
  const lines = working.split(/\r?\n/);
  const structuredLines = lines.filter(l =>
    /^(Page\s+\d+\s*:|Text[^:]*:|Image\s*:|Line\s*\d+\s*:)/i.test(l.trim())
  );

  let normalized = working;
  if (structuredLines.length < 2) {
    // Keywords are missing newlines — insert them before each keyword.
    normalized = working
      .replace(/(Page\s+\d+\s*:)/gi,     '\n$1')
      .replace(/(Image\s*:)/gi,           '\n$1')
      .replace(/(Text[^:\n]{0,80}:)/gi,  '\n$1')
      .replace(/(Line\s*\d+\s*:)/gi,     '\n$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  fs.writeFileSync(path.join(DATA_ROOT, 'input', 'book.txt'), normalized, 'utf8');
  return true;
});

// Scan a directory and return image metadata for sorting/display in the UI
ipcMain.handle('files:get-image-list', (_, srcDir) => {
  const imgRe = /\.(png|jpg|jpeg|webp)$/i;
  const numRe  = /^(\d+)/;
  const files  = fs.readdirSync(srcDir)
    .filter(f => imgRe.test(f) && !f.includes('Zone.Identifier'));

  const entries = files.map(f => {
    const fullPath = path.join(srcDir, f);
    const stat     = fs.statSync(fullPath);
    const numMatch = numRe.exec(path.parse(f).name);
    return {
      name:      f,
      path:      fullPath,
      isNumbered: !!numMatch,
      num:       numMatch ? parseInt(numMatch[1], 10) : null,
      birthtime: stat.birthtimeMs || stat.ctimeMs,
      mtime:     stat.mtimeMs,
    };
  });

  // Auto-sort: numbered files by their number; unnamed by birthtime (download order)
  entries.sort((a, b) => {
    if (a.isNumbered && b.isNumbered) return a.num - b.num;
    if (a.isNumbered) return -1;
    if (b.isNumbered) return 1;
    return a.birthtime - b.birthtime;
  });

  return entries;
});

// Copy images to input/images in the exact order provided (paths array)
ipcMain.handle('files:copy-images-ordered', (_, orderedPaths) => {
  const inputDir = path.join(DATA_ROOT, 'input');
  const destDir  = path.join(inputDir, 'images');
  const tmpNew   = path.join(inputDir, 'images_new');
  const tmpOld   = path.join(inputDir, 'images_old');

  // 1. Copy sources into a fresh staging dir (safe even if sources are inside destDir)
  fs.rmSync(tmpNew, { recursive: true, force: true });
  fs.mkdirSync(tmpNew, { recursive: true });
  orderedPaths.forEach((srcPath, idx) => {
    const ext = path.extname(srcPath).toLowerCase();
    fs.copyFileSync(srcPath, path.join(tmpNew, String(idx + 1).padStart(2, '0') + ext));
  });

  // 2. Rename old dir out of the way — renaming doesn't require files to be unlocked on Windows
  fs.rmSync(tmpOld, { recursive: true, force: true });
  if (fs.existsSync(destDir)) fs.renameSync(destDir, tmpOld);

  // 3. Promote staging dir to the real images dir
  fs.renameSync(tmpNew, destDir);

  // 4. Best-effort cleanup of the old dir (non-critical if it fails)
  try { fs.rmSync(tmpOld, { recursive: true, force: true }); } catch {}

  return orderedPaths.length;
});

ipcMain.handle('files:book-txt-exists',  () => fs.existsSync(path.join(DATA_ROOT, 'input', 'book.txt')));
ipcMain.handle('files:pages-exist',      () => fs.existsSync(path.join(DATA_ROOT, 'output', 'pages')));
ipcMain.handle('shell:open-output',      () => shell.openPath(path.join(DATA_ROOT, 'output')));
ipcMain.handle('shell:open-music-folder',() => shell.openPath(path.join(DATA_ROOT, 'music')));

// ─── IPC: Build runners ────────────────────────────────────────────────────────
let activeWorker   = null;
let buildCancelled = false;

function runBuild(event, workerFile, env) {
  buildCancelled = false;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'workers', workerFile), {
      workerData: {
        env: {
          STORYBOOK_DATA_ROOT: DATA_ROOT,
          ...env,
        },
      },
    });
    activeWorker = worker;

    worker.on('message', msg => {
      if (msg.type === 'log')   event.sender.send('build:log', msg.text);
      if (msg.type === 'done')  { activeWorker = null; resolve(); }
      if (msg.type === 'error') { activeWorker = null; reject(new Error(msg.message)); }
    });
    worker.on('error', err => { activeWorker = null; reject(err); });
    worker.on('exit', code => {
      activeWorker = null;
      if (code !== 0) {
        reject(new Error(buildCancelled ? 'BUILD_CANCELLED' : `Worker exited with code ${code}`));
      }
    });
  });
}

ipcMain.handle('build:cancel', async () => {
  if (activeWorker) {
    buildCancelled = true;
    await activeWorker.terminate();
  }
});

ipcMain.handle('build:book', async (event, opts = {}) => {
  const s = loadSettings();
  const def = defaultSettings();
  const pageSize     = opts.pageSize     || s.pageSize || def.pageSize;
  const layout       = opts.layout       || s.layout   || def.layout;
  const fontSizeCover  = opts.fontSizeCover  || 90;
  const fontSizeStory  = opts.fontSizeStory  || 76;
  const fontSizeLast   = opts.fontSizeLast   || 60;
  const textColorCover = opts.textColorCover || '#000000';
  const textColorStory = opts.textColorStory || '#000000';
  const textColorLast  = opts.textColorLast  || '#000000';
  const bleedIn        = opts.bleedIn != null ? opts.bleedIn : (s.bleedIn != null ? s.bleedIn : def.bleedIn);

  const { w: pagePxW, h: pagePxH } = pageSizeToPx(pageSize);

  await runBuild(event, 'book-worker.js', {
    STORYBOOK_PAGE_W_PX: String(pagePxW),
    STORYBOOK_PAGE_H_PX: String(pagePxH),
    STORYBOOK_LAYOUT:    JSON.stringify(layout),
    FONT_COVER:          String(fontSizeCover),
    FONT_STORY:          String(fontSizeStory),
    FONT_LAST:           String(fontSizeLast),
    TEXT_COLOR_COVER:    textColorCover,
    TEXT_COLOR_STORY:    textColorStory,
    TEXT_COLOR_LAST:     textColorLast,
    BLEED_IN:            String(bleedIn),
  });
});

ipcMain.handle('build:video', async (event, opts) => {
  const { voice, ttsVolume, musicVolume, clearCache, musicPath,
          highlightColor, highlightStyle, fontSizeCover, fontSizeStory,
          shortsThumbnailPath, landscape, shorts } = opts;

  // Read page size + layout from saved settings so video matches the built pages
  const s   = loadSettings();
  const def = defaultSettings();
  const pageSize = s.pageSize || def.pageSize;
  const layout   = s.layout   || def.layout;
  const land     = landscape || s.landscape || def.landscape;
  const port     = shorts    || s.shorts    || def.shorts;

  const { w: pagePxW, h: pagePxH } = pageSizeToPx(pageSize);

  await runBuild(event, 'video-worker.js', {
    VOICE_ID:           voice,
    TTS_VOLUME:         String(ttsVolume),
    MUSIC_VOLUME:       String(musicVolume),
    CLEAR_TTS_CACHE:    clearCache ? '1' : '0',
    STORYBOOK_PAGE_W_PX: String(pagePxW),
    STORYBOOK_PAGE_H_PX: String(pagePxH),
    STORYBOOK_LAYOUT:    JSON.stringify(layout),
    ...(musicPath             ? { MUSIC_PATH:            musicPath             } : {}),
    ...(highlightColor        ? { KARAOKE_COLOR:         highlightColor        } : {}),
    ...(shortsThumbnailPath   ? { SHORTS_THUMBNAIL_PATH: shortsThumbnailPath   } : {}),
    HIGHLIGHT_STYLE:     highlightStyle || 'box',
    FONT_COVER:          String(fontSizeCover || 90),
    FONT_STORY:          String(fontSizeStory || 76),
    LAND_IMG_RATIO:      String(land.imgRatio),
    LAND_FONT_COVER:     String(land.fontCover),
    LAND_FONT_STORY:     String(land.fontStory),
    LAND_TEXT_COLOR_COVER: land.textColorCover,
    LAND_TEXT_COLOR_STORY: land.textColorStory,
    PORT_IMG_RATIO:      String(port.imgRatio),
    PORT_FONT_COVER:     String(port.fontCover),
    PORT_FONT_STORY:     String(port.fontStory),
    PORT_TEXT_COLOR_COVER: port.textColorCover,
    PORT_TEXT_COLOR_STORY: port.textColorStory,
  });
});

