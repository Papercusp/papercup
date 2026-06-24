# Tauri IPC \"access control checks\" on Linux — wry registers custom schemes secure-only, not CORS-enabled
URL: /internal/docs/agent-insights/tauri-ipc-cors-remote-origin-webkitgtk

Why the desktop logs 'Fetch API cannot load ipc://localhost/endpoint_invoke due to access control checks' on every navigation, and the vendored-wry one-liner that fixes it.

## Symptom

The Tauri desktop console logs, on **every navigation**:

```
Fetch API cannot load ipc://localhost/endpoint_invoke due to access control checks.
```

(often followed by Tauri's own `IPC custom protocol failed, Tauri will now use the
postMessage interface instead`). The app still works — Tauri falls back to the
postMessage IPC transport — but the error pollutes the console and the IPC
custom-protocol fast path never runs.

## Root cause

Papercusp loads the operator UI from a **remote `http://127.0.0.1:<port>` origin**
(`frontendDist`/`devUrl` in `tauri.conf.json`), **not** the bundled `tauri://`
asset protocol. Tauri's injected IPC script always tries the `ipc://localhost/<cmd>`
**custom-protocol fetch first** on non-Android (`canUseCustomProtocol = osName !== 'android'`).

On Linux/WebKitGTK, **wry registers custom URI schemes only as
`register_uri_scheme_as_secure`, never `register_uri_scheme_as_cors_enabled`**
(`wry/src/webkitgtk/web_context.rs::register_uri_scheme`). So WebKitGTK blocks the
**cross-origin** `ipc://` fetch from the `http://127.0.0.1` page *before* it ever
honors the response — even though Tauri's IPC protocol handler already returns
`Access-Control-Allow-Origin: *`. Tauri's `.catch` then logs the warn and falls
back to postMessage.

The Tauri **capability** `remote.urls` (`capabilities/default.json`) governs the
*permission* layer (which commands a remote origin may call) — it does **NOT**
fix this WebKitGTK CORS-on-custom-scheme layer. Different concern.

## Two traps when fixing this

1. **It is NOT in the already-vendored `tauri-runtime-wry`.** The scheme
   registration lives in **wry**; `tauri-runtime-wry` registers protocols through
   wry's `with_asynchronous_custom_protocol` and wry exposes its WebKit context
   only `pub(crate)`. So the fix requires vendoring **wry itself**
   (`[patch.crates-io] wry = { path = "vendor/wry" }`, same pattern as the
   existing `tauri-runtime-wry` patch).
2. **Timing: it must run BEFORE the web process spawns.** Registering
   `register_uri_scheme_as_cors_enabled` *post-`webview.build()`* (e.g. via
   `WebViewExtUnix::webview().web_context().security_manager()`) is **too late** —
   verified: the warn still fires. WebKitGTK reads scheme registrations at web-process
   spawn. The fix must sit right next to wry's existing `register_uri_scheme_as_secure`
   call, which runs at the correct pre-spawn moment.

## The fix

In vendored `wry/src/webkitgtk/web_context.rs`, right after the `_as_secure`
registration, add (note: the webkit2gtk 2.0.2 method is `_as_cors_enabled`, not
`_as_cors_allowed`):

```rust
self.os.context.security_manager().ok_or(Error::MissingManager)?
  .register_uri_scheme_as_cors_enabled(name);
```

Drop the vendored-wry patch when a released wry registers custom schemes as
CORS-enabled upstream.

## How to verify (the reliable way)

`tauri-agent-tools console-monitor` across a reload is **unreliable** here — it
reads a stale buffer and misses post-reload messages (a sentinel `console.warn`
emitted after reload was not captured). Verify **deterministically** via `eval`
instead — perform the `ipc://` fetch directly and inspect the outcome:

```js
// CORS-rejected → rejects immediately with "...access control checks".
// CORS-allowed  → request proceeds to the handler (stays pending / AbortError on a timeout).
await fetch('ipc://localhost/endpoint_invoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2', 'Tauri-Invoke-Key': 'probe' },
  body: '{}', signal: AbortSignal.timeout(1500),
})
```

An `AbortError` (the fetch was in-flight) confirms CORS now passes; an
"access control checks" rejection means it's still broken.

## Related

The webview→Rust IPC succeeding at the WebKit layer is separate from the
Rust→Node-sidecar socket (`endpoint-ipc`); if that socket is down (`dev:service_health`
shows `ipc socket unreachable`), `endpoint_invoke` returns an error and
`desktop-bootstrap.ts`'s `isIpcUnavailable` falls back to HTTP **silently** (no
console error). See `libs/generic/desktop-ipc/src/desktop-bootstrap.ts`.
