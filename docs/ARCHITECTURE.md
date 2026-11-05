# Raijin architecture

## Processes

| File | Role |
| --- | --- |
| `electron/main.cjs` | Window, tray, notifications, taskbar progress, clipboard watcher, power-save blocker, "when done" actions, single-instance and command-line handling, and IPC routing. Every IPC handler checks the sender and returns `{ ok, data }` or `{ ok:false, error, code }`. |
| `electron/preload.cjs` | Exposes a frozen `window.raijin` API. The renderer is sandboxed with `contextIsolation`, has no Node access and runs under a strict CSP. |
| `electron/bridge.cjs` | Localhost-only HTTP bridge for the browser extension. |
| `electron/engine/manager.cjs` | Queue, scheduling, persistence, scheduler, batch add, import/export, finalize and checksum verification. Emits `state`, `tick`, `completed`, `failed`, `idle` and `scheduler` events. |
| `electron/engine/transfer.cjs` | One running download: probe, dynamic segmentation, workers, retries, stall detection, positional writes and speed sampling. |
| `electron/engine/throttle.cjs` | Deficit-based token bucket, shared globally and created per job. |
| `electron/engine/util.cjs` | File-name sanitizing, Content-Disposition parsing (RFC 5987), categories, batch-pattern expansion and header sanitizing. |
| `src/` | React interface. `lib/store.js` merges full snapshots with 2 Hz progress ticks. |
| `extension/` | Manifest V3 browser extension. |

## Download lifecycle

`queued` / `scheduled` → `connecting` → `downloading` → `finishing` → `completed`
At any point a download can move to `paused` or `failed`. Resume continues from the persisted segments.

## Dynamic segmentation

1. A fresh download sends `GET` with `Range: bytes=0-`.
   - A `206` response gives the size, confirms range support and is kept open as segment #0.
   - A `200` response means no range support, so the download uses a single stream.
2. A temp file `<name>.raijin` is pre-allocated to the full size.
3. Each extra worker calls `claim()`. It takes an idle unfinished segment, or splits the busy segment with the most bytes remaining at its midpoint. The minimum segment size is 384 KiB. Splitting is synchronous, so it can never race.
4. Workers write each chunk at its absolute offset. Bytes are reserved before the `await write` so a concurrent split can't overlap in-flight data. In-flight bytes are subtracted when state is persisted, so a crash never records bytes that were not written.
5. When a worker finishes, it compacts adjacent finished segments and claims more work.
6. When all segments are done, the file is fsynced and closed, then renamed to the final name (with retries for Windows AV locks). If a checksum is set, it is verified.

## Resume validation

On resume the engine sends `Range: bytes=0-0`.
- Same size and ETag → continue the remaining segments.
- Changed → reset and restart.
- No range support any more → restart.

Segment requests use `If-Range` with a strong ETag or Last-Modified, so a changed file is detected mid-download as well.

## Browser bridge security

- Binds to `127.0.0.1` only. The `Host` header must match, which blocks DNS rebinding.
- Requires the `X-Raijin-Client` header. Web pages can't send it cross-origin without a CORS pre-flight, and every pre-flight is refused.
- If an `Origin` header is present, it must be an extension origin.
- JSON only, 2 MB body limit, and only `http(s)` URLs are accepted.

## Tests

`npm test` runs two suites against real local HTTP servers.
- `tests/engine.test.cjs`: segmentation, no-range fallback, unknown size, dropped connections, 503 + Retry-After, redirects, zero-byte files, auth, cookies, pause/resume, changed-file restart, restart persistence, checksums, duplicates, batch/queue/category folders, live connection changes and speed limits, remove/restart, probe and scheduler.
- `tests/bridge.test.cjs`: bridge acceptance and rejection rules.
