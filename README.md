# Storybook Builder

A Windows desktop app that turns a storybook script and images into a narrated, karaoke-style video, ready for YouTube or YouTube Shorts.

## What it does

1. **Write a script**: paste or import a structured `book.txt` with pages, image references, and narration lines
2. **Arrange images**: drag-and-drop your illustrations into order
3. **Build pages**: renders each page as a 300 DPI PNG (with optional PDF/DOCX export)
4. **Build video**: runs AI text-to-speech (Kokoro), aligns audio with Whisper, and assembles everything with FFmpeg into a narrated video with word-level karaoke highlighting

## Features

- AI narration via [Kokoro TTS](https://github.com/hexgrad/kokoro) (local, offline, MIT licensed)
- Word-level karaoke highlight sync (box, underline, or color modes)
- Background music mixed in automatically from your `music/` folder
- Configurable page size, layout, font sizes, and text colors
- YouTube Shorts support (custom thumbnail)
- First-run wizard that auto-installs Python and all AI packages via `pip`
- Packaged as a standalone Windows installer (no dev environment needed)

## Requirements (dev)

- [Node.js](https://nodejs.org) 18+
- [Python](https://www.python.org) 3.12 (installed automatically on first run if missing)
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

Place matching images in `input/images/` (numbered filenames like `01.jpg` are sorted automatically).

## Build scripts

| Command | Description |
|---|---|
| `npm start` | Launch the desktop app |
| `npm run build-book` | Render pages to `output/pages/*.png` (CLI) |
| `npm run build-video` | Build the narrated video (CLI) |
| `npm run dist` | Package the app as a Windows installer |

## Project structure

```
app/             Electron main + renderer process
  main.js        Main process: IPC handlers, build runners, Python setup
  renderer.js    UI logic
  workers/       Worker threads for book and video builds
scripts/
  build-book.js  Page rendering (sharp, pdf-lib, docx)
  build-video.js Video assembly (FFmpeg, Kokoro TTS, Whisper alignment)
  tts.py         Python TTS runner (Kokoro)
  whisper_align.py  Word-level timestamp alignment
input/           Your script and images (not committed)
output/          Rendered pages and final video (not committed)
music/           Background music files (.mp3, .wav, etc.)
ffmpeg-bin/      Bundled FFmpeg binary for packaged builds
```

## Settings

Saved automatically to `%APPDATA%\storybook-builder\storybook-settings.json`. Configurable in-app:

- TTS voice and volume
- Background music volume
- Karaoke highlight color and style
- Page size and image/text box layout

## License

ISC
