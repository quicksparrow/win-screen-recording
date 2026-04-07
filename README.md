# Screen Recorder Studio

Record your screen and export polished videos without timeline editing.

## What it is

Screen Recorder Studio is a Windows desktop app for capturing screen content with a built-in live composition workflow. You can preview your scene, adjust webcam/background settings, then record and export.

## Features

- Record entire screen, windows, or tabs
- Live preview before recording
- Output layouts: 16:9, 9:16, and 1:1
- Audio capture: system audio and microphone
- Webcam overlay: mode, position, and size controls
- Webcam enhancement: smoothing and exposure controls
- Background customization and theming
- Fast export pipeline with status feedback
- Light and dark mode support

## Platform

- Windows desktop application (Electron)
- Distributed as a `.exe` installer

## Tech stack

- Electron
- React + TypeScript
- Tailwind CSS
- FFmpeg
- Web APIs (`MediaDevices`, `Canvas`, `MediaRecorder`, `Web Audio`)

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Windows package

```bash
npm run dist:win
```

## Download

Download the latest `.exe` from the repository Releases page.
