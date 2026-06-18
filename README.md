# <img src="assets/icon.png" width="32" alt="" valign="middle"> LibreRythmo

Free, open-source rythmo band editor for dubbing — sync dialogue to picture frame by frame, then export a composited video or a DETX.

[![Latest release](https://img.shields.io/github/v/release/fusorf/LibreRythmo?label=download)](https://github.com/fusorf/LibreRythmo/releases/latest)
[![License: GPLv3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

**[Download for Windows](https://github.com/fusorf/LibreRythmo/releases/latest)** — portable build, unzip and run `LibreRythmo.exe`.

![Main window](docs/screenshot-main.png)

## Features

- **Rythmo band** — 1 to 4 tracks, words stretched to their real duration, frame-accurate sync. Drag lines, snap each word boundary to the lips, multi-select, proportional stretch, magnet.
- **Characters & reactions** — one color per actor, French reac lexicon (`ah`, `oh`, `fff`, `(rire)`…) by palette or key, voice-over (underlined).
- **Scenes** — open/close markers, prev/next navigation, length warnings, OUT segments.
- **Audio & video tracks** — NLE-style tab: every audio track of the container plus imported files, per-track offset by drag, active track shown as a waveform on the band.
- **Fullscreen playback (F5)** — video + composited band with auto-hiding controls: play, scene jump, loop a scene, band zoom.
- **Import / export** — DETX (Joker / Cappella), SRT (with corrected-subtitle re-import), PDF script, MP4 composite with GPU encoding (NVENC / QuickSync / AMF, x264 fallback) and a choice of tracks, scenes and audio track.
- **Projects** — single-file `.rythmo` (JSON), autosave, recent projects, undo/redo, dark/light themes, English/French UI, optional Discord Rich Presence.

| Fullscreen playback (F5) | Audio & video tracks | MP4 export |
|---|---|---|
| ![Playback](docs/screenshot-player.png) | ![Tracks](docs/screenshot-tracks.png) | ![Export](docs/screenshot-export.png) |

## Usage

1. Drop a video into the window (or `Ctrl+O`).
2. Create your characters in the right panel. The selected one is assigned to new lines.
3. Add lines: import an SRT (`File > Subtitles`), double-click the band, or press `Enter` at the playhead.
4. Select a line and drag the word-boundary handles onto the lips. Type `_` for an adjustable silence.
5. `Ctrl+E` to export a composited MP4, or PDF / DETX / SRT from the File menu.

Press `F1` in the app for the full shortcut list.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Space` | Play / pause |
| `Left` / `Right`, `Shift+Left/Right` | Previous / next frame, ±1 s |
| `Enter` | New line at the playhead |
| `Page Up` / `Page Down` | Previous / next scene |
| `F5` | Fullscreen playback |
| `Ctrl+F` | Search lines |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste lines (timing kept) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| wheel, `Ctrl+wheel` | Scrub, zoom the band |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Ctrl+E` | Export video |

## Project format

A `.rythmo` file is plain JSON. Every word carries its own timecodes (seconds), which produces the elongation:

```json
{
  "version": 2,
  "videoPath": "C:\\...\\film.mp4",
  "fps": 25,
  "tracks": 1,
  "characters": [{ "id": "...", "name": "Emma", "color": "#c0392b" }],
  "loops": [{ "id": "...", "start": 0, "end": 48, "name": "Scene 1", "type": "normal" }],
  "audioTracks": [{ "id": "...", "type": "embedded", "index": 0, "offset": 0 }],
  "lines": [
    {
      "id": "...",
      "characterId": "...",
      "track": 0,
      "entry": "closed",
      "exit": "open",
      "voiceOff": false,
      "words": [{ "text": "Hello", "start": 1.24, "end": 1.81 }]
    }
  ]
}
```

Projects from older versions still open. DETX keeps characters, tracks, texts and entry/exit marks
through the round-trip; it stores plain text without per-word timing, so elongation is redistributed
evenly on import. Scenes and audio tracks stay internal to the `.rythmo` file.

## Build from source

```bash
npm install
npm start            # run in development
npm run package      # build dist/LibreRythmo-win32-x64/LibreRythmo.exe
```

Releases are built by [GitHub Actions](.github/workflows/release.yml) when a `v*` tag is pushed.

## Code structure

- `main.js` — Electron main process (window, menus, file dialogs, ffmpeg, PDF, Discord presence)
- `preload.js` — IPC bridge
- `renderer/` — vanilla JS UI: `app.js` (logic + canvas rendering), `i18n.js` (EN/FR), `reacs.js` (reac lexicon)
- `assets/` — icon (SVG source, PNG, ICO)
- `scripts/` — dev tools (drive the app through Chrome DevTools Protocol)

## Credits

| Project | Role | License |
|---|---|---|
| [Electron](https://www.electronjs.org/) | Desktop shell (Chromium + Node.js) | MIT |
| [FFmpeg](https://ffmpeg.org/) | Video compositing and encoding | GPL v3 (bundled binary) |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | FFmpeg binary distribution | GPL v3 (binary) |
| [@electron/packager](https://github.com/electron/packager) | Executable packaging (dev) | BSD-2-Clause |
| [ws](https://github.com/websockets/ws) | CDP driving in dev scripts | MIT |

The DETX format is documented by the [Joker](https://github.com/MartinDelille/Joker) project.

## License

GPL-3.0-or-later, (c) 2026 fusorf. See [LICENSE](LICENSE).

The bundled FFmpeg binary keeps its own license (GPL v3, it includes x264): it is invoked as an
external program and its source is available at [ffmpeg.org](https://ffmpeg.org/).
