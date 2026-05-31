# Desktop IPC transport map — what rides IPC, what's dormant, how to turn it on
URL: /internal/docs/agent-insights/desktop-ipc-transport-map

The desktop routes webview /api traffic over Tauri IPC to dodge WebKitGTK's ~6-conn libsoup cap. Three mechanisms, all gated behind PAPERCUSP_DESKTOP_IPC + a release-only sidecar spawn. Here's the whole map + the turn-on recipe + the gotchas.

## Why IPC exists here

The desktop is Tauri/WebKitGTK. WebKitGTK's libsoup HTTP stack caps **\~6 connections
per host**, so the operator's long-lived SSE streams (sync, log/provision streams,
agent-thinking, UI-intents, …) camp every slot and starve on-demand `fetch()`. The fix:
route the webview's same-origin `/api/*` traffic over **Tauri IPC** (a Unix domain
socket to the Node sidecar) instead of real HTTP sockets, dodging the cap entirely.

## The three IPC mechanisms

1. **`sys:http` blanket bridge** — `installDesktopIpcPolyfills()`
   (`libs/generic/desktop-ipc/src/desktop-bootstrap.ts`, installed at module-eval in
   `apps/operator/app/_components/RootSyncProvider.tsx`) patches:
   * `window.fetch` → `ipcFetch` for **same-origin `/api/*`, string/URL input, string body**.
   * `window.EventSource` → `IpcEventSource` (all EventSources).
     Any component using `fetch('/api/...')` or `new EventSource('/api/...')` rides IPC with
     **zero per-call changes**. Falls back to native when IPC is unavailable. **Gaps it does
     NOT cover:** cross-origin, non-`/api/` paths, `Request`-object input, binary/Blob/FormData
     bodies, and WebSockets.
2. **Typed `endpoint_invoke` dispatch** — `dispatchEndpointStream`
   (`libs/generic/desktop-ipc/src/index.ts`): picks IPC on Tauri for typed event-stream
   tools, gated by a host **allowlist** in `apps/operator/instrumentation-node.ts`
   (`maybeStartEndpointIpcServer`). Returns the same `EndpointStreamEvent` union on both
   transports, so a consumer migrated to it keeps a working HTTP fallback in the browser.
3. **`expose.ipc: true`** — declarative per-tool flag in `ToolExposure`
   (`packages/tooldef` `tool-projection.ts`). The intended successor to the hardcoded
   allowlist; `defineTool`'s auto-projection must thread `input.expose?.ipc` for it to reach
   the registry.

## It is OFF by default in dev — the dormancy gates

A live probe will usually find `endpoint_invoke` → **"state not managed"**. Three gates
must all be satisfied for IPC to actually run:

* **`PAPERCUSP_DESKTOP_IPC`** (desktop env, `papercusp-desktop/src-tauri/src/main.rs`):
  the desktop only sets `PAPERCUSP_IPC_ENABLE=1` on the sidecar + pipes its stdout to parse
  the handshake when this is on. **As of 2026-05-31 it defaults ON** (disable with `=0`).
* **Release vs dev build** — the sidecar is spawned **only in release** (`cfg!(debug_assertions) == false`). A `tauri dev` / `cargo build` (debug) run prints *"dev mode — skipping sidecar
  spawn"* and the operator runs separately on `:3055`/`:3070` with **no IPC server**. So a
  debug binary can never complete the handshake — you need `cargo build --release`.
* **The handshake** — the sidecar boots its IPC server only when `PAPERCUSP_IPC_ENABLE=1`
  (`instrumentation-node.ts` `maybeStartEndpointIpcServer`), prints
  `PAPERCUSP_IPC_READY socket=<path>`; Rust parses it, `IpcClient::connect` + `app.manage`.
  Until `app.manage` runs, `endpoint_invoke` errors with "state not managed", and
  `ipcFetch` falls back to native HTTP while `IpcEventSource` falls back to a native
  EventSource (commit `7ef90807`).

## Turn-on / verify recipe

```bash
cd papercusp-desktop/src-tauri && cargo build --release      # NOT debug — dev skips the sidecar
PAPERCUSP_DESKTOP_IPC=1 ./target/release/papercusp-desktop   # redundant now it defaults on
```

Release/bundled mode spawns its own sidecar on a **free port** (no `:3070`/systemd
conflict — `find_free_port`), and points the webview at `window.__papercuspBase`. Verify
on the new window via the dev bridge (`tauri-agent-tools eval --port <p> --token <t>`):
`endpoint_invoke('dev:ipc_echo')` returns a result (not "state not managed");
`window.EventSource`/`window.fetch` are the patched polyfills; `~/.papercusp/sockets/<pid>.sock`
exists.

## The audit conclusion (2026-05-31)

Because `sys:http` blankets all same-origin `/api/*` fetch + EventSource, **per-call-site
"migrate to IPC" work is tiny** — once IPC is on, \~everything rides it automatically. The
only genuine residual gaps: console-launch's old `Image().src`/absolute-`:3055` hacks (fixed
to a relative same-origin POST), and the Deepgram STT WebSocket (external `wss://`, not
reachable over the local socket). The terminal PTY — the one full-duplex webview channel —
already uses a dedicated native Tauri pty command, not a WS. The IPC framing is
**server-push-only** (Request + Cancel are the only client→server frames), so full-duplex
channels can't map onto it as-is.

## Resumability

`packages/tooldef/src/replay-buffer.ts` (Phase-4 T2.2) already buffers per
`(workspaceId, toolName, runId)` and the HTTP SSE routes already honor
`Last-Event-ID + X-Papercusp-Run-Id` (`parseLastEventId`; `agent-tools/catchall.ts` sets the
run id). The remaining work for the typed dispatch path is wiring that cursor through
`http-stream.ts` / `ipc-stream.ts` so a reconnect resumes from the buffer.

## Gotchas that cost time

* **`cargo build … | tail` masks the exit code** — the pipeline reports `tail`'s status, not
  cargo's. A failed compile looks like "exit 0". Read the actual log tail for `error[E...]`.
* **`open_devtools()` doesn't exist in release** — it's compiled out unless the tauri
  `devtools` feature is on; gate it `#[cfg(debug_assertions)]` (fixed 2026-05-31). This had
  kept the release binary \~3 weeks stale.
* **A debug binary launched directly is still "dev mode"** — the sidecar-spawn gate is the
  compile profile (`debug_assertions`), not how you launch it. Don't expect IPC from
  `target/debug/papercusp-desktop`.

See the plan `desktop-ipc-transport-completion-2026-05-20` for the broader effort.
