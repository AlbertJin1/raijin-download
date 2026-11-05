# Raijin Download Manager

**Designed & developed by Jessie Albert Regualos (aka Yotsuchi)**

Raijin — named after the Japanese god of thunder and lightning — is a Windows download manager in the spirit of Internet Download Manager, rebuilt from scratch with Electron, React and a custom download engine.

## Features

**Engine**
- **Dynamic segmentation (IDM-style):** up to 32 connections per file. The first connection discovers the file and keeps streaming; every other connection splits the segment with the most bytes left, and finished connections immediately re-split — so all connections stay busy until the last byte.
- **One pre-allocated file, positional writes:** no slow "assembling parts" step at the end; the disk-space check happens before the download starts.
- **Crash-safe resume:** segment progress is persisted, so downloads continue after pause, app restart, or a crash. ETag/size validation restarts cleanly if the file changed on the server.
- **Resilience:** per-connection retries with exponential back-off, `Retry-After` support, stall detection, automatic fallback to one stream for servers without range support, and fallback to the original link if a redirect target expires.
- **Refresh address:** paste a new link for an expired download and Raijin continues from where it stopped.
- **Request control:** cookies, referrer, Basic auth, custom headers and user agent per download.
- **Checksum verification:** MD5 / SHA-1 / SHA-256 / SHA-512, checked automatically when a download finishes, or calculated on demand.
- **Speed limits:** global and per-file, adjustable live. The number of connections can also be changed mid-download.
- **Queue & scheduler:** concurrent-download limit, priorities, move up/down/top/bottom, "Download later", daily start/stop times, and a "when done" action (quit, sleep or shut down, with a 30-second cancel window).
- **Batch downloads:** paste many links or use patterns like `img[001-120].jpg`, `part[1-9:2].rar`, `disk-[a-f].iso`.

**Desktop integration**
- **Browser extension** (Chrome, Edge, Brave, Opera): catches downloads, adds right-click menus for links, media, selections and "download all links", and passes your login cookies so signed-in downloads work.
- **Clipboard watcher:** copy a link to a file and Raijin offers to download it.
- System tray with speed-limit presets, native notifications, taskbar progress, keeping the PC awake while downloading, launch at Windows startup, single-instance handling and `Raijin.exe <url>` command-line support.

**Interface**
- Dense, sortable, virtualized list that stays fast with thousands of items.
- Details panel with a live **segment map**, per-connection table, speed graph, request info and integrity tools.
- Dark and light themes, five accent colours, comfortable or compact density.
- Keyboard-first: `Ctrl+N` add, `Ctrl+B` batch, `Ctrl+V` paste a link anywhere, `Space` pause/resume, `Del` delete, `Enter` open, `Ctrl+A` select all, `Ctrl+F` search, `Ctrl+D` details, `Ctrl+,` settings. Drag and drop links onto the window.
- Import/export of the download list.

## Run from source

Requires Node.js 22.12+.

```bash
npm install
npm run dev        # Vite + Electron with hot reload
npm test           # engine + browser-bridge test suites
```

## Build for Windows

On Windows, double-click `build_publish.bat`, or run:

```bash
npm run dist           # installer + portable
npm run dist:portable  # release/Raijin-Portable-<version>.exe
npm run dist:setup     # release/Raijin-Setup-<version>.exe
```

See `BUILD-WINDOWS.md` for details.

## Install the browser extension

1. In Raijin, go to **Settings → Browser & clipboard → Get extension**. This copies the extension to a permanent folder and opens it.
2. In Chrome/Edge, open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, and pick that folder.
3. The Raijin icon in the toolbar shows a green dot when it is connected.

Downloads stay in the browser automatically whenever Raijin is not running.

## Where things are stored

- Settings and the download list: `%APPDATA%\Raijin Download Manager\raijin-downloads.json` (with a `.bak` backup).
- Downloads: `Downloads\Raijin\<Category>` by default.
- Partial downloads use a `<name>.raijin` file next to the final file. It is renamed when the download finishes.

## Limits

Raijin downloads direct HTTP/HTTPS files. Streaming-site video extraction (YouTube and similar), HLS/DASH stream capture, FTP and BitTorrent are not included. Downloads that rely on a browser POST form can't be replayed outside the browser, so the extension leaves those to the browser.

© 2026 Jessie Albert Regualos (Yotsuchi). All rights reserved.
