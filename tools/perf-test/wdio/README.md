# perf-test-wdio

WebdriverIO + `tauri-driver` runner for the **packaged** Papercusp desktop binary.

This is the only path that exercises the real Tauri build — Playwright doesn't speak the WebDriver protocol Tauri exposes. Most perf bugs reproduce identically in the dev webapp (`next dev` at :3055), so this runner is for the smaller set of issues that only show up in the shipped binary: native-bridge IPC latency, window-creation cost, asset-protocol load times.

## One-time setup

1. **tauri-driver** — `cargo install tauri-driver` (already installed).
2. **WebKitGTK WebDriver** (Linux only):
   ```bash
   sudo apt install webkit2gtk-driver
   ```
3. **Install Node deps** — run from this directory:
   ```bash
   cd tools/perf-test/wdio
   npm install
   ```
   (kept out of the pnpm workspace on purpose — wdio's `@wdio/cli` postinstall picks tooling that doesn't play well with pnpm hoisting).

## Running

```bash
# 1. Build the packaged desktop binary
pnpm --filter @papercusp/desktop build

# 2. Run wdio against the binary
cd tools/perf-test/wdio
npm test
```

`wdio.conf.ts` spawns `tauri-driver` on port 4445, drives the binary via WebDriver, and runs `specs/*.spec.ts`. The included `smoke.spec.ts` boots the app, waits for the operator UI to mount, injects `web-vitals`, and reports INP/LCP/CLS after 10s.

## Architecture vs the in-process `/tests` page

| | Where it runs | Speed | Catches |
|---|---|---|---|
| `/tests` page (Gremlins + react-scan + web-vitals) | Inside the running app | Live, every iteration | 95% of UI perf bugs |
| `perf-test-wdio` (this) | Outside, drives packaged binary | Slow (minutes), CI-shaped | The 5% that need the real binary — IPC latency, window creation, asset protocol |

Run the in-process tooling daily; run this before each release.
