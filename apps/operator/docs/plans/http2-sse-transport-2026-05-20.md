# Serve the operator over HTTP/2 — fix SSE connection-pool exhaustion

**Date:** 2026-05-20
**Status:** SUPERSEDED by `desktop-ipc-transport-completion-2026-05-20.md`.
HTTP/2's distinguishing advantage was fixing the browser webapp surface
too; with the webapp retired (desktop-only product) that no longer
matters, and the desktop IPC transport — already built and merged — is
the better fit. Kept for the record / as a fallback if IPC stalls.
**Supersedes the fix section of:** `webkit-sse-connection-pool-2026-05-20.md`
(that doc's Option A / Option B). This is a third option the prior doc
did not evaluate, and the recommended one.

---

## Goal

Serve the operator (`apps/operator`, `@papercusp/web`) over **HTTP/2** so
that all of its long-lived SSE streams multiplex over **one** TCP
connection instead of camping the browser's 6-connections-per-host
HTTP/1.1 budget.

## Non-goals

- No change to any SSE *route* or to `@restart/sse`. SSE is just HTTP;
  over h2 it is an h2 stream. This is a transport/serving change, not an
  application-code change.
- No client-side SSE multiplexer (the prior doc's Option A). h2 does the
  multiplexing at the protocol layer — an app-layer multiplexer would
  re-implement it.
- Not migrating to WebSockets or Tauri IPC.

## Background

The `/harness` page holds ~6 permanent SSE streams (Zero sync, operator
panel, background scanner, ui-intents, state-snapshots, harness log).
Under HTTP/1.1 a browser allows only 6 sockets per origin, so those
streams camp the entire budget; every other request — on-demand
`fetch()`, the live agent-thinking popover's `EventSource` — queues for a
socket that never frees. Full diagnosis: `webkit-sse-connection-pool-2026-05-20.md`.

This affects the **shipped Tauri desktop app** (WebKitGTK → libsoup,
`max-conns-per-host = 6`), not just the test webapp.

## Why HTTP/2 fixes it

h2 multiplexes many concurrent *streams* over one TCP connection
(`SETTINGS_MAX_CONCURRENT_STREAMS`, which we control). The 6-socket
limit is an HTTP/1.1-era constraint; under h2 it does not exist. Every
existing SSE stream + every `fetch()` shares one connection. **Zero
per-stream migration.** This is the same thing every production deploy
gets for free when a CDN/LB terminates h2.

## Decision: reverse proxy, not a Next.js custom server

Next.js 16 does not serve HTTP/2 natively; `next dev` and `next start`
are both HTTP/1.1. Two ways to get h2:

1. **Custom server** — replace the standalone `server.js` with a
   `node:http2` server feeding Next's `getRequestHandler()`. Rejected:
   Next's request handler targets the http1 `req`/`res` shape; the http2
   compatibility layer mostly works but has sharp edges (connection-
   specific headers, trailers), and it forfeits Next's standalone-bundle
   guarantees. Couples our serving to Next internals.

2. **Reverse proxy (chosen)** — keep Next 100% stock on an internal
   loopback h1 port; put a small **h2 + TLS terminating reverse proxy**
   in front on the port the webview/browser uses. The proxy speaks h2 to
   the client and h1 to Next.

The reverse proxy is what nginx/Caddy do in production. It also
*insulates the SSE code*: Next keeps emitting ordinary h1 responses
(including the `Connection:` header h2 forbids); the proxy strips
hop-by-hop headers and re-frames as h2. Nothing in `sseResponse` or any
route changes.

## Architecture

```
            ┌─────────────────────── h2 + TLS ──────────────────────┐
  webview / browser ──────────────▶  h2 reverse proxy  ──── h1 ────▶ Next (operator)
                                     :PUB                  :INT      next start / next dev
```

- **One Node proxy implementation** (`scripts/h2-proxy.mjs`), used by
  both desktop and dev — avoids maintaining two proxies.
- `node:http2.createSecureServer({ allowHTTP1: true, settings: {
  maxConcurrentStreams: 256 } })`. `allowHTTP1: true` is load-bearing:
  WebSocket upgrades (PTY, dev HMR) arrive as h1 and must still work on
  the same port; it is also graceful degradation if anything h2-specific
  misbehaves.
- Upstream: plain `node:http` requests to Next on `:INT` (loopback).
- The proxy **streams** responses (pipe upstream → h2 stream, no
  buffering) so SSE flushes immediately.
- The proxy strips hop-by-hop headers (`connection`, `keep-alive`,
  `transfer-encoding`, `upgrade` except on the WS path) — h2 rejects
  them.
- The proxy sets `X-Forwarded-For` / preserves `Host` so the operator's
  loopback auth gating and the SSE stream-key (`remoteIP`) keep working.

### Desktop (production — what ships)

`libs/papercusp/apps/desktop/src-tauri/main.rs` today: pick a free port,
spawn the Next standalone sidecar, point the webview at
`http://localhost:<port>`. New flow:

1. Rust generates (first run) or loads a self-signed cert for
   `localhost` + `127.0.0.1`, stored in app data.
2. Rust spawns Next on an internal free port `:INT`.
3. Rust spawns `h2-proxy.mjs` on the public free port `:PUB` with the
   cert + `:INT`.
4. Rust **pins the cert in the webview** (see TLS section) and points
   the window at `https://localhost:<PUB>/`.
5. On exit, Rust kills both children.

### Dev / webapp (testing)

- `npm run dev` orchestrates: `next dev` on an internal port +
  `h2-proxy.mjs` on `:3055`, concurrently.
- Cert for dev: `mkcert` (one-time `mkcert -install` adds a local CA to
  the dev machine's trust store — the standard local-HTTPS workflow).
  Document it in the dev README.
- `tauri.conf.json` `devUrl` → `https://localhost:3055`.

## The TLS requirement — the hard part

Browsers and WebKitGTK negotiate h2 **only over TLS** (ALPN). Cleartext
h2c is not supported by any browser fetch stack. So h2-on-localhost
means a TLS cert. For dev that is `mkcert`. For the **shipped desktop
app** the app generates its own self-signed cert and must make its
webview trust it — *without* touching the OS trust store (invasive,
needs elevation, alarming for a consumer app).

The app controls both the cert and the webview, so per-host cert
**pinning in the webview** is correct and safe (the app trusting
itself). Each platform exposes this differently:

- **Linux / WebKitGTK** — `webkit_web_context_allow_tls_certificate_for_host(ctx, cert, "localhost")`. Reachable from Tauri via the `webkit2gtk` crate on the platform webview.
- **Windows / WebView2** — the `ServerCertificateErrorDetected` event; override for our cert + host.
- **macOS / WKWebView** — the `didReceive challenge` navigation-delegate hook.

**This per-platform webview-cert glue is the primary risk and the P0
spike.** If a platform cannot pin in-webview, the fallback for that
platform is the OS trust store, or it stays HTTP/1.1 until resolved.

## Application-code changes (minimal)

Serving over h2 needs almost no app code. The changes are *cleanups* of
workarounds that h2 makes obsolete:

- **Revert `lib/cross-origin-url.ts`** — the `localhost`↔`127.0.0.1`
  sibling-host shard (commit `c718d501`) that doubles the pool to 12 by
  using two origins. Under h2 it is unnecessary and its cross-origin
  CORS surface is a liability. Remove it and its call sites.
- **Audit SSE responses for `Connection:` headers** — the agent stream
  currently sends `Connection: close`. Harmless (the proxy strips
  hop-by-hop headers upstream→downstream), but worth removing so the
  intent is clear.
- Drop the speculative `next.config.js` `Connection: close` header and
  the `instrumentation-node.ts` prewarmer noted as loose ends in the
  prior doc.
- If Option B (lazy streams) was shipped as a stopgap, it can be reverted
  once h2 lands (or kept — it is harmless, just no longer necessary).

The three fixes already shipped (`21e5c1b3`, `1b2ee83` — kill the
polling storm, dedup the provider, batch rest-query) stay; they reduce
request *volume*, which is good under any transport.

## Implementation phases

- **P0 — TLS-pinning spike (gates everything).** On Linux: generate a
  self-signed cert, get one h2 request from the Tauri webview to a
  trivial h2 server accepted via in-webview pinning. Confirms the
  approach is viable before building the proxy. Repeat the spike for
  Windows/macOS or defer those platforms.
- **P1 — the proxy.** `scripts/h2-proxy.mjs`: h2+TLS front, h1 upstream,
  streaming, hop-by-hop stripping, WS-upgrade passthrough,
  `X-Forwarded-For`. Standalone-testable against `next dev`.
- **P2 — desktop wiring.** `main.rs`: cert gen/load, spawn proxy +
  sidecar, pin cert, point webview at `https://`. Two-child lifecycle.
- **P3 — dev wiring.** `npm run dev` runs proxy + `next dev`; `mkcert`
  documented; `tauri.conf.json` `devUrl` → `https`.
- **P4 — cleanup.** Revert `cross-origin-url.ts`, the `Connection`
  headers, the prewarmer; update docs.

## Risks

- **Per-platform webview cert trust** — the real unknown. Mitigated by
  the P0 spike; Linux first (primary dev + the reproduced bug).
- **WebSocket coexistence** — `allowHTTP1: true` handles WS as h1 on the
  same port; verify PTY + dev HMR both still connect.
- **`maxConcurrentStreams`** — set generously (256). At the ceiling, new
  streams queue (the same bug, far higher). ~6 SSE + normal fetch traffic
  is nowhere near 256.
- **Extra process in the desktop bundle** — one more Node process
  (proxy). Acceptable; the sidecar is already Node. Rust-side lifecycle
  must kill both.
- **Loopback auth** — the proxy adds a hop; `Host` + `X-Forwarded-For`
  must be forwarded so `/desktop/*` Host-gating and stream `remoteIP`
  keep working. Covered in P1.

## Verification protocol

A warm reload does not prove this — see the prior doc. A fix is verified
only when, after a **full quit + relaunch** of the desktop app (or a
fresh dev browser window):

1. First paint of `/harness` — console shows zero
   `Fetch API cannot load … access control checks` lines.
2. `ss -tnp | grep WebKit | grep :<PUB>` shows **1** ESTAB connection
   (the single h2 connection), not 6–7.
3. The request `:protocol` is `h2` (DevTools Protocol column, or
   `curl --http2 -k https://localhost:<PUB>/...` shows `HTTP/2`).
4. Hover an active-agent pill — the live-thinking popover connects in
   well under a second, repeatably.

## Rollback

`allowHTTP1: true` already means h1 clients work. Full rollback: point
the webview / `devUrl` back at the Next port directly and skip the
proxy. No data migration, no schema change — purely a serving topology
swap.

## Open questions

- `main.rs` references the sidecar entry as `apps/papercusp/server.js`
  but the app dir is `apps/operator` — confirm the standalone path
  during P2.
- Proxy as a Node child process (chosen) vs. an in-process Rust proxy
  (`hyper`) — Node keeps one implementation shared with dev; revisit
  only if the extra process proves a problem.
- Windows/macOS cert-pinning — spike now, or ship Linux-first and
  fast-follow?
