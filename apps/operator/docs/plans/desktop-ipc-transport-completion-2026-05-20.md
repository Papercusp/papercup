---
title: Desktop IPC transport — completion + extension to all webview traffic
slug: desktop-ipc-transport-completion-2026-05-20
status: active
created: 2026-05-20
updated: 2026-06-01
owner: pandawamble@gmail.com
---

## Now

**State:** Connection-pool bug fixed (Phases 0–3 + IPC allowlist E shipped/wired; ipcFetch streams — desktop-ipc acd651c → papercup 5a4bb9cf9). Direct-dispatch migration DROPPED as regressive (decision A). Resumability DEFERRED (user's call). PHASE 4 IMPLEMENTED, gated + default-off (papercusp-desktop aa3d774): a `papercusp://` async URI-scheme handler (custom_protocol.rs) forwards page/asset GETs to the operator loopback base; when PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=1 the main window loads papercusp://localhost/ (via web/index.html __papercuspAppBase navigate) so the webview opens ZERO HTTP connections. The SPA's /api/* fetch+EventSource stay on IPC (same-origin under the new origin → polyfill still intercepts); the handler only serves document+JS/CSS/img. reqwest 0.12 (default-features off, blocking). Verified: cargo check clean (no new warnings). NOT YET live-verified — an origin change can't be load-tested without a bootable shell; dev uses the HTTP devUrl, packaged is gated on the embedded-PG adaptive_telemetry drift. Live spike (does custom-scheme devUrl load? CORS/CSP under papercusp://? do polyfills fire?) needs a GUI-window boot on display :0 (the box HAS :0 + :3070 up, so it's doable with the agent-e2e workflow). Flag off = boot byte-identical; rollback = unset flag. STILL OUTSTANDING: (a) live Phase-4 verify; (b) desktop-ipc acd651c + this need org-remote sync by the lib owner; (c) oracle:chat/agent_chats:chat carry expose.ipc from E8 but aren't safe to direct-dispatch (latent footgun, left as-is).

**Next:** Live-verify Phase 4 over papercusp:// via a GUI-window dev-shell boot (PAPERCUSP_DESKTOP_CUSTOM_PROTOCOL=1, devUrl→papercusp://localhost forwarding to :3070), then flip the default on if green; lib owner: sync desktop-ipc + desktop commits to org remotes.

## Goal

Get the **Tauri webview off localhost HTTP**. The webview hits the
browser's 6-connections-per-host HTTP/1.1 cap (libsoup on WebKitGTK):
~6 permanent SSE streams camp every slot, so on-demand `fetch()` and the
live agent-thinking popover's `EventSource` starve. IPC (`invoke` +
Tauri `Channel`) is **not HTTP** — it has no per-host connection pool.
Moving the webview's traffic onto the existing UDS IPC transport
eliminates the limit entirely.

Three deliverables, escalating:

1. **Finish** the unshipped parts of the 2026-05-12 IPC plan.
2. **Extend** IPC from "endpoint-system tool dispatch" to the SSE
   streams and `fetch()` calls that actually cause the bug.
3. **Go further** — what it takes to take the *whole webview* off HTTP
   (page loads + assets included).

## Context — what already exists (don't rebuild)

The 2026-05-12 IPC plan shipped and merged on both repos:

- **Wire protocol** — `endpoint-ipc/PROTOCOL.md`: length-prefixed
  frames (`REQUEST` / `EVENT_JSON` / `EVENT_BIN` / `DONE` / `ERROR` /
  `CANCEL`), `u64`-id multiplexing, 16 MiB cap.
- **Node side** — `endpoint-ipc/server.ts` (UDS/named-pipe listener),
  `framing.ts`. Boots from `instrumentation-node.ts` on
  `PAPERCUSP_IPC_ENABLE=1`.
- **Rust side** (`papercusp-desktop`) — `endpoint_ipc.rs` (`IpcClient`,
  `endpoint_invoke` / `endpoint_cancel` Tauri commands, bounded mpsc),
  `endpoint_ipc_framing.rs`, `main.rs` handshake wiring.
- **Client picker** — `transport-adapters/index.ts`: `dispatchEndpointStream`
  picks IPC on Tauri, HTTP elsewhere, with `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT`
  kill-switch.
- **Carries today:** 6 allowlisted endpoint-system tools
  (`dev:ipc_echo`, `operator:scan`, `architect:chat`, `brainstorm:chat`,
  `operator:delegate`, `operator:converse`).

**What it does NOT carry:** the Zero sync SSE, harness log stream,
agent popover stream, `ui/intents`, `state-snapshot`, the operator
panel/background-scanner streams, and every plain `fetch('/api/...')`.
Those are the connection-pool hogs. They are bespoke routes, not
`defineTool` tools, so the tool-only transport never touched them.

## Key architectural insight

The Rust `IpcClient` and the frame protocol are **tool-agnostic** —
`endpoint_invoke` carries an opaque `{ toolName, input }` and streams
back opaque events. So a new privileged pseudo-tool — call it
`sys:http` — that carries *HTTP request semantics* needs **zero Rust
changes**. Phases 1–3 below are pure TypeScript (Node server + a client
shim). Only Phase 4 (custom protocol for page loads) touches Rust.

Second seam already in place: `createResilientEventSource` accepts an
injectable `eventSourceCtor`. Swap in an IPC-backed `EventSource` and
every existing SSE consumer moves transport with no per-call-site edit.

---

## Phase 0 — Finish: verify the shipped tool-IPC path live

The 2026-05-12 work is unit-tested (115 + 88 + 22 tests) but the
**Day-0 benchmark was waived** and it is unconfirmed whether the IPC
path has ever run green against a real desktop build.

- Run `papercusp-desktop/bin/verify-desktop-ipc.sh` against a fresh
  desktop build. Confirm the `/dev → IPC` tab round-trips `dev:ipc_echo`
  over the socket, and that `operator:scan` streams over IPC end to end.
- Confirm `tool_invocations.transport` rows show `'ipc'`.
- This is the trust anchor for everything below. ~half a day.

Deliberately **not** doing: the Day-0 latency benchmark (moot — we are
committing to IPC regardless), Rust-side typed event codegen (no Rust
consumer), shared-memory Ladder-3 (no driver).

---

## Phase 1 — `sys:http`: a generic HTTP-over-IPC bridge (Node + client)

One pseudo-tool reused through the existing `endpoint_invoke` command.

**Request** (`REQUEST` frame, `toolName: 'sys:http'`):
```
input = { method, path, headers, body? }   // path is same-origin, e.g. "/api/..."
```

**Server side** (`endpoint-ipc/server.ts`) — handle `sys:http` *before*
the `lookupByMcpName` tool path:
- Dispatch the request into the operator's own router. Two options:
  - **(1a) Loopback fetch** — `fetch('http://127.0.0.1:<intPort>' + path)`.
    Node→Node on loopback; **not** subject to any browser pool. Simplest,
    covers every route (Hono catch-all *and* standalone Next routes)
    with zero routing knowledge. Recommended for v1.
  - **(1b) In-process dispatch** — import the Hono `app` and call
    `app.fetch(req)`. No TCP at all, but must also dispatch standalone
    Next `route.ts` handlers — more plumbing. A Phase-4 cleanup, not now.
- If the response `content-type` is `text/event-stream`: stream it —
  one `EVENT_JSON {name:'sse-chunk', data:<rawBytes>}` per read, no
  `DONE` until the upstream stream ends or a `CANCEL` arrives.
- Otherwise: emit `EVENT_JSON {name:'head', data:{status,headers}}`,
  then the body as `EVENT_BIN` chunks (respect the 16 MiB frame cap),
  then `DONE`.
- `CANCEL` aborts the upstream request/stream (`AbortController`).

**Client side** — `transport-adapters/http-over-ipc.ts`:
- `ipcFetch(path, init): Promise<Response>` — drives a `sys:http` call,
  reassembles `head` + body chunks into a real `Response`.
- `IpcEventSource` — a class implementing the `EventSource` interface
  (`addEventListener`, `readyState`, `close`, `onmessage/onerror`)
  backed by a `sys:http` subscription whose `sse-chunk` events are fed
  through the standard SSE line parser.

**No Rust change.** `sys:http` rides `endpoint_invoke` as-is; add
`'sys:http'` to the IPC allowlist (it is privileged by design — the
webview is in-boundary per the existing trust model, and could already
call any route over HTTP).

Risk note: indefinite SSE subscriptions hold an `id` open forever — fine
for the protocol (no `DONE` requirement), but watch the Rust per-call
bounded mpsc (10 k events). SSE events are small; telemeter the depth.

---

## Phase 2 — SSE off HTTP (fixes the connection-pool bug)

Install `IpcEventSource` so every SSE consumer uses it on desktop.

- A desktop-only client bootstrap (`'use client'`, runs before the
  harness providers mount): if `isTauri()` and not force-HTTP, set
  `window.EventSource = IpcEventSource`. Every `new EventSource(...)`
  and every `createResilientEventSource` (which reads
  `globalThis.EventSource`) transparently moves to IPC.
- Net effect: the Zero sync SSE, harness log stream, agent popover
  stream, `ui/intents`, `state-snapshot`, operator-panel and
  background-scanner streams **all** leave the HTTP connection pool at
  once — no per-route migration.
- The 6-connection cap stops applying to the webview. **The popover
  connects instantly; the diff-loading-forever and access-control-checks
  bugs are gone.**
- Resume semantics: `IpcEventSource` carries `Last-Event-ID` in the
  `sys:http` request headers on reconnect, so `sync-sse.ts`'s ring-buffer
  replay keeps working.

Kill-switch: the same `forceHttp()` check skips the global install →
instant rollback to native `EventSource`.

This phase is what the user originally asked to fix. It is reachable
**without any Rust work** and without touching the ~6 stream routes.

---

## Phase 3 — `fetch()` off HTTP

Same idea for non-streaming calls.

- In the desktop bootstrap, wrap `window.fetch`: same-origin `/api/*`
  requests route through `ipcFetch`; everything else (cross-origin —
  PostHog, LLM APIs, asset URLs) falls through to native `fetch`
  untouched.
- Now every operator API call the webview makes — status polls,
  rest-query / rest-query-batch, mutations, the lot — goes over the
  UDS. The webview's HTTP connection count for `/api/*` drops to zero.

Risk: a global `fetch` patch must be surgical — only intercept
same-origin API paths; never intercept cross-origin or asset requests.
Cookie-derived inputs (e.g. `operator:converse`'s `sessionUser`) have no
cookies over IPC — the bridge forwards the webview's `document.cookie`
in the `sys:http` headers, or the route reads the synthesized operator
principal. Audit per route.

After Phase 3 the webview speaks HTTP only for: page navigation, the
`_next/static/*` asset chunks, and the PTY WebSocket.

---

## Phase 4 — "one step further": take the *whole webview* off HTTP

What remains after Phase 3:

| Webview→server traffic | Phase 3 state | Phase 4 |
|---|---|---|
| `/api/*` fetch + SSE | IPC ✅ | IPC |
| Page navigation (SSR HTML) | HTTP | custom protocol |
| `/_next/static/*` assets | HTTP | custom protocol |
| PTY | WebSocket (HTTP upgrade) | already has a Tauri-command IPC path (`pty-tauri.ts`) — wire it on |
| Dev HMR WebSocket | HTTP | dev-only — unchanged |

**The honest definition of "off HTTP": the *webview* never opens an HTTP
connection.** Whether the Node sidecar keeps an internal loopback port
that only Node itself talks to is irrelevant — an internal
Node→Node loopback hop is not subject to any browser pool and is
invisible to the bug. So Phase 4 does **not** require ripping the TCP
port out of Next; it requires routing the last webview-originated
traffic (navigations + assets) off HTTP.

**Mechanism — Tauri custom protocol.** Register an async URI scheme
(`papercusp://`) in `main.rs` via `register_asynchronous_uri_scheme_protocol`.
The webview's main window loads `papercusp://localhost/` instead of
`http://localhost:<port>/`.

- **Static assets** (`/_next/static/*`, images, fonts): the Rust handler
  serves them straight from the bundled `sidecar/.../static/` directory
  — fast, no Node hop.
- **SSR navigations** (`/harness`, etc.): the Rust handler forwards the
  request — over the existing UDS, or a direct loopback fetch — to the
  Node sidecar, which renders and returns HTML. Buffered (HTML is small;
  Tauri custom-protocol streaming is limited — acceptable for
  navigations since all *streaming* responses already went to IPC in
  Phase 2).
- The webview is now a `papercusp://` origin. Tauri marks custom
  protocols as secure contexts, so `crypto.subtle` etc. keep working.
- `fetch`/`EventSource` from Phases 2–3 already bypass the network, so
  they are unaffected by the origin change (they call `invoke`, not the
  network stack).

**This is the only phase that touches Rust** (the protocol handler) and
needs a cross-repo (`papercusp-desktop`) change.

Hard parts / unknowns for Phase 4 (spike before committing):
- Custom-protocol + SSR cookie/redirect/`Set-Cookie` semantics.
- WebView2 / WKWebView custom-protocol parity (Linux WebKitGTK first).
- CSP under a custom origin (`dangerousDisableAssetCspModification` is
  already set; revisit).

If Phase 4 proves fiddly, **Phases 0–3 already fix the reported bug and
every connection-pool symptom** — Phase 4 is the "purity" finish, not a
prerequisite for the fix.

---

## What stays on HTTP — and why that's correct

- **MCP-spawned agents** (`claude-code` / `omp` subprocesses) hit
  `/api/mcp` + `/api/sse` over loopback HTTP. They are *out of process* —
  not in the Tauri process tree — so they cannot use the webview's IPC
  and the signed-URL trust model genuinely applies to them. Unchanged.
- **`next dev` in a debugging browser.** Dev is HTTP; the polyfills are
  desktop-only feature-detected. The three fixes already shipped
  (`21e5c1b3`, `1b2ee83`) keep dev tolerable.
- **External calls** (PostHog, LLM APIs) — genuinely remote HTTPS.
  "Off HTTP" means off *localhost loopback HTTP for the webview*, never
  off the internet.

The Node sidecar keeping an internal loopback port (used by the
`sys:http` bridge and by MCP agents) is fine and expected.

---

## Prior art — how Tauri apps handle backend routing + webapp sharing

Researched because the user asked. The honest summary:

**Most Tauri apps have no local HTTP backend at all.** The mainstream
pattern is a static SPA (Vite build) served over Tauri's `tauri://`
asset protocol, with "backend" = Rust `#[tauri::command]` functions
called via `invoke` and `emit`/`listen` events. No HTTP, no routing.
papercusp running a full Next.js HTTP sidecar is *unusual for Tauri* —
it exists because Next.js is an SSR framework that wants to be an HTTP
server. (There is even a `tauri-plugin-localhost` for exactly this
"my framework needs an HTTP origin" case — papercusp is effectively in
that bucket.)

**How the ones that share a frontend with a webapp do it:** they put a
**transport abstraction** between the UI and the wire. UI code calls
`client.doThing()`; `client` has two implementations — `fetch` for web,
`invoke`/IPC for desktop — selected at runtime by feature-detect. The UI
and business logic are shared; only the thin transport differs. Typed
variants: `tauri-specta` (Rust→TS binding codegen — papercusp already
uses it) and community typed-IPC routers (`taurpc`-style) give
`invoke` the same typed-client ergonomics as an HTTP client.

**papercusp already has this seam — for tools.** `transport-adapters/`
+ `dispatchEndpointStream` is exactly the abstraction: same call, IPC on
desktop, HTTP on web. The defect is that the *rest* of the app
(`fetch`, `EventSource`) bypasses the seam and hard-codes HTTP. Phases
2–3 widen the existing seam to cover `fetch`/`EventSource` via the
polyfill — which, as a bonus, keeps the codebase *web-capable for free*
(the polyfill is desktop-only; on web, native `fetch`/`EventSource`).
So even though the webapp is retired, this design doesn't burn the
bridge back to it.

Cross-toolkit sanity check: Electron apps do the same — VS Code routes
renderer↔host over IPC and uses `protocol.handle()` for custom
protocols; "webapp in a shell" Electron apps just keep talking HTTPS to
their real remote backend. The pattern — *abstract the transport, use
the native channel on desktop, custom-protocol the assets* — is
consistent across both toolkits.

---

## Future webapp compatibility — the IPC work must not burn the bridge

The webapp is retired, but this plan is deliberately structured so a
future webapp is a *deployment* decision, not an architecture rewrite.
Five disciplines keep that true:

1. **HTTP routes are never removed.** IPC is a transport that
   *dispatches into* the existing routes (`sys:http` → loopback-fetch or
   `app.fetch()`), never a replacement. As long as the route handlers
   exist and answer a `Request`, the webapp's backend exists.
2. **The transport seam stays feature-detected, never build-time.**
   Polyfills install only under `isTauri()`. On web, native
   `fetch`/`EventSource` hit the HTTP server. The *same frontend code*
   (`fetch('/api/...')`, `new EventSource(...)`) runs on both — the
   transport swap is invisible to app code.
3. **New endpoints go in the Hono app, not bespoke Next routes.** A Hono
   app is a portable `Request → Response` handler — it runs as a Node
   server, a Bun/Deno server, a Cloudflare Worker, *and* in-process.
   The more of the API that is Hono, the more trivially the backend
   re-hosts as a webapp (or anything else).
4. **Auth enforcement lives in the routes / shared middleware — not in
   the transport.** IPC's trust model (webview = in-boundary → synthesize
   operator principal, skip signature check) is an *additional fast
   path*, not a removal of checks. Route handlers must still enforce
   auth so the HTTP path stays safe. Then a future webapp's real auth
   is added in one place and both transports respect it.
5. **Phase 4 (custom protocol) is desktop-only and additive.** A web
   deploy just serves Next normally; the `papercusp://` scheme is a
   desktop page-loading detail with no web-side effect.

**What re-launching a webapp is NOT free of** — and these are unrelated
to transport, so name them honestly:

- **Auth.** The operator today is loopback-only (no real auth — see
  `project_operator_auth_loopback`). A public webapp needs real
  sessions / OAuth. Genuine new work.
- **Multi-tenancy.** The desktop app is single-user, one workspace on
  local disk, embedded Postgres. A public webapp is multi-user — the
  data model (per-workspace embedded PG, files on disk) assumes
  local single-user. A real multi-tenant cloud webapp is a far bigger
  lift than transport.

So: a **testing** webapp (the operator redeployed network-reachable) is
near-free and this plan keeps it that way. A **public multi-tenant**
webapp is a major separate effort in auth + data model — this plan
neither helps nor blocks it, it just keeps the door open.

## Risks

- **Global `fetch`/`EventSource` patching.** Must intercept only
  same-origin `/api/*`; cross-origin and asset requests fall through.
  A too-broad patch breaks PostHog/telemetry/LLM calls. Surgical
  predicate + tests.
- **Indefinite SSE over the per-call mpsc cap (10 k).** SSE events are
  small; should be fine. Telemeter queue depth; tune if needed.
- **Cookie-derived route inputs.** No cookies over IPC. Forward
  `document.cookie` in `sys:http` headers, or rely on the synthesized
  operator principal. Per-route audit.
- **Phase 4 custom-protocol + SSR** — cookies, redirects, secure-context,
  cross-platform webview parity. Spike Linux first.
- **MCP agents must keep working** — they are out-of-process; verify the
  loopback HTTP path is untouched.

## Verification protocol

Warm reloads do not prove connection-pool fixes (see
`webkit-sse-connection-pool-2026-05-20.md`). After a **full quit +
relaunch** of the desktop app:

1. First paint of `/harness` — console shows zero
   `Fetch API cannot load … access control checks`.
2. `ss -tnp | grep WebKit | grep :<port>` shows **0** ESTAB HTTP
   connections from the webview to the operator after Phase 3 (only the
   UDS remains); **≤1** after Phase 2 if `fetch` is still HTTP.
3. Hover an active-agent pill — the live-thinking popover connects
   instantly, repeatably.
4. `tool_invocations.transport` and stream telemetry show `'ipc'`.

## Rollback

`NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1` already exists and now
also skips the Phase 2–3 global polyfill install → the webview falls
straight back to native HTTP `fetch`/`EventSource`. No rebuild. Phase 4
rollback: point the window back at `http://localhost:<port>`.

## Effort

| Phase | Scope | Rust? | Estimate |
|---|---|---|---|
| 0 — verify shipped tool-IPC | runbook + checks | no | ~0.5 day |
| 1 — `sys:http` bridge | Node server + client shim | no | ~2–3 days |
| 2 — IPC `EventSource` | polyfill + bootstrap | no | ~2 days |
| 3 — IPC `fetch` | polyfill + per-route cookie audit | no | ~2 days |
| 4 — custom protocol (off HTTP) | Rust handler + cross-repo | **yes** | ~3–5 days |

**Phases 0–2 (~1 week) fix the reported bug.** Phases 3–4 complete the
"fully off HTTP" goal (~2 weeks more).

## Open questions

- Phase 1: loopback-fetch (1a) vs in-process Hono dispatch (1b) — 1a
  recommended for v1; revisit 1b only if the internal loopback port is
  later deemed worth removing.
- Phase 4: spike Windows/macOS custom-protocol parity now, or ship
  Linux-first?
- Should the PTY WebSocket move onto its existing `pty-tauri.ts`
  command-IPC path as part of Phase 4, or stay WS (one WS connection is
  harmless once everything else is off the pool)?
