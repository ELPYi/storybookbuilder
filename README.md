# Storybook Builder

A Windows desktop app that turns a storybook script and images into narrated karaoke-style videos, ready for YouTube or YouTube Shorts. Also includes a standalone **Lyrics Video** builder for music tracks.

## What it does

The app has three builders, each on its own tab:

### Book Builder
Renders your storybook script into high-quality page images (300 DPI PNG, PDF, or DOCX).

### Video Builder
Takes your rendered pages and produces a narrated video with word-level karaoke highlighting:
1. Paste your `book.txt` script and arrange your images in order
2. AI text-to-speech (Kokoro) generates narration for each page
3. Faster-Whisper aligns audio to word-level timestamps
4. FFmpeg assembles pages, narration, karaoke highlights, background music, and an intro clip into a finished video

Outputs both **Landscape (16:9)** and **Shorts (9:16)** formats simultaneously.

### Lyrics Video Builder
Builds a standalone karaoke-style music video from a lyrics file and a song:
1. Paste your lyrics (section labels like `(Verse 1)` are stripped automatically)
2. Drop a folder of images — they play as an **independent slideshow** on their own timer, separate from the text
3. Reorder images by drag-and-drop before building
4. Faster-Whisper aligns lyrics to word-level timestamps
5. FFmpeg composites the image slideshow over the karaoke text track

Outputs both **Landscape (1920×1080)** and **Portrait (1080×1920)** formats simultaneously.

## Features

- AI narration via [Kokoro TTS](https://github.com/hexgrad/kokoro) (local, offline, MIT licensed)
- Word-level karaoke highlight sync — box, underline, or font color modes
- Background music mixed in automatically from your `music/` folder
- Custom intro image with optional title text overlay
- Adjustable volume for narration, intro music, and song tracks
- Image slideshow for lyrics videos with crossfade transitions and independent timing
- Configurable page size, font sizes, text colors, and layout ratios per format
- YouTube Shorts support (9:16 layout)
- 2-second pre-narration pause on title page for Shorts clips
- Tabbed UI: Book Builder, Video Builder, Lyrics Video — each with its own settings
- First-run wizard that auto-installs Python and all AI packages via `pip`
- Packaged as a standalone Windows installer (no dev environment needed)

## Requirements (dev)

- [Node.js](https://nodejs.org) 18+
- [Python](https://www.python.org) 3.11 (installed automatically on first run if missing)
- [FFmpeg](https://ffmpeg.org): place `ffmpeg.exe` in the `ffmpeg-bin/` folder or install via WinGet

## Getting started

```bash
# Install Node dependencies
npm install

# Launch the Electron app
npm start
```

On first launch the app checks for Python and installs the required packages (`kokoro`, `faster-whisper`, `numpy`, `soundfile`). This only happens once and may take a few minutes.

## Input format (`input/book.txt`)

```
Page 1:
Image: 01.jpg
Line 1: Once upon a time, a little rabbit lived in the forest.
Line 2: Every morning she hopped to the meadow to look for clover.

Page 2:
Image: 02.jpg
Line 1: One day she found a golden acorn.
```

Place matching images in `input/images/` (numbered filenames like `01.jpg` are sorted automatically). You can also drag-and-drop a folder and reorder images in the GUI.

## Build scripts

| Command | Description |
|---|---|
| `npm start` | Launch the desktop app |
| `npm run build-book` | Render pages to `output/pages/*.png` (CLI) |
| `npm run build-video` | Build the narrated video (CLI) |
| `npm run dist` | Package the app as a Windows installer |

## Project structure

```
app/
  main.js              Main process: IPC handlers, build runners, Python setup
  renderer.js          UI logic (tab switching, image sorter, build controls)
  preload.js           Context bridge (exposes safe IPC API to renderer)
  index.html           App layout and UI structure
  styles.css           Dark theme styles
  workers/
    book-worker.js     Worker thread for page rendering
    video-worker.js    Worker thread for video builds
    lyrics-video-worker.js  Worker thread for lyrics video builds
scripts/
  build-book.js        Page rendering (sharp, pdf-lib, docx)
  build-video.js       Video assembly (FFmpeg, Kokoro TTS, Whisper alignment)
  lyrics-video.js      Lyrics video builder (FFmpeg, image slideshow, karaoke)
  tts.py               Python TTS runner (Kokoro)
  whisper_align.py     Word-level timestamp alignment (faster-whisper)
input/                 Your script, images, and lyrics (not committed)
output/                Rendered pages and final videos (not committed)
music/                 Background music files (.mp3, .wav, etc.)
ffmpeg-bin/            Bundled FFmpeg binary for packaged builds
```

## Settings

Saved automatically to `%APPDATA%\storybook-builder\storybook-settings.json`. Configurable in-app per builder:

**Video Builder**
- TTS voice and narration volume
- Intro image, title text, and intro music volume
- Karaoke highlight color and style (box / underline / font color)
- Page size, image/text split ratio, font sizes, and text/background colors
- Xfade transition duration between pages

**Lyrics Video Builder**
- Highlight color and style
- Image/text split ratio, font sizes, text and background colors
- Section crossfade duration
- Song volume

## License

ISC
