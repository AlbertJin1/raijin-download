# Building Raijin Download Manager for Windows

## Quick build

1. Install **Node.js 22.12 or newer (x64)** from nodejs.org.
2. Extract the project to a normal writable folder (not inside `Program Files`).
3. Double-click **`build_publish.bat`**. You don't need administrator rights.

The script checks Node.js, installs dependencies, runs the test suites, builds the interface and packages two files into `release\`:

| File | What it is |
| --- | --- |
| `Raijin-Setup-2.0.0.exe` | Installer with Start-menu and desktop shortcuts, a chosen install folder and an uninstaller (per-user, no admin). |
| `Raijin-Portable-2.0.0.exe` | Single-file portable app. Runs without installation. |

## Manual commands

```bat
npm ci
npm test
npm run dist            :: both
npm run dist:portable   :: portable only
npm run dist:setup      :: installer only
```

## Notes

- **SmartScreen:** builds are unsigned unless you add a code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD` environment variables). Windows may show "Windows protected your PC" → *More info* → *Run anyway*.
- **Launch at startup** with the portable build registers the path of the portable `.exe`, so keep it in a fixed folder.
- **Building on Linux/macOS** works too. The portable target builds directly; the installer target needs Wine, including its 32-bit runtime (`wine32`).

## Troubleshooting

- `node` not found → install Node.js 22.12+ and open a new terminal.
- `npm ci` fails → check your internet connection or proxy, then retry.
- "file is locked" → close Raijin (also from the tray icon) and build again.
- Browser extension shows a red dot → make sure Raijin is running and the port in the extension popup matches *Settings → Browser & clipboard → Integration port*.
