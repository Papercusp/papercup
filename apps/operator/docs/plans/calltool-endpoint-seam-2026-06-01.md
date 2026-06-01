---
title: callTool — single client endpoint seam with registry-picked transport
slug: calltool-endpoint-seam-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
---

# callTool — single client endpoint seam with registry-picked transport

## Now

**State:** Phase A COMPLETE. Phase D code-COMPLETE (3 layers aligned to D-006; unit-verified, 66 tests). Phase C COMPLETE (P-006): a dev IPC-traffic inspector. desktop-ipc gained a zero-cost inspector seam (setIpcInspector/emitIpcTrace/nextIpcTraceId, no-op in prod) instrumenting dispatchEndpointStreamIpc (invoke/-done/-error with sys:http path+method) + IpcEventSource (es-open on construction, es-connect on head-200, es-drop, es-error, es-close) — desktop-ipc 83b81ea, +6 tests. The operator installs a ring-buffer recorder → window.__ipcInspector with churn()/summary()/events(), wired first in RootSyncProvider, dev-only — superproject 1f529205d, +5 tests, clean operator-vite prod build (no server-module leak). The churn() report is the instrument: ONE construction across drops = the Phase D fix working; many constructions for one URL = churn. Phase B STARTED (use-ui-presence→callRoute).

**Next:** Phase D LIVE verification — now equipped: re-enable dev-IPC in isolation (the .env.local IPC vars + the bin/host-bootstrap gate), restart the host, open the dev desktop, let it run a few minutes, then read window.__ipcInspector.churn() via the Tauri bridge eval. PASS = /api/zero-harness/sse shows constructions:1 with drops>0 (one persistent channel, internal reconnects) and no visible flashing; FAIL = constructions climbing. Keep dev-IPC OFF until that PASS. Independent, unblocked anytime: Phase B broad sweep (~100 fetch→callRoute / streaming→callTool, codemod-able); Phase E per-tool direct-dispatch (code-unblocked; verify D live first). Optional polish: a small UI panel over window.__ipcInspector (currently console/bridge-only).

## Background

**Two IPC mechanisms exist, and they are not the same thing.**

1. **`sys:http` — HTTP-over-IPC bridge (what the webview uses today).** The
   polyfill turns every same-origin `fetch('/api/…')` + `EventSource` into a
   `sys:http` call: the request is shipped over the unix socket and **replayed
   through the real Hono route → tool**, so route logic (auth/session, workspace
   RLS, cost-caps, persistence) is preserved. Works for every endpoint. Cost: an
   extra loopback-HTTP hop server-side. **"All `/api` off browser-pooled HTTP" is
   already true via this — zero per-tool work.** (The browser pool is the libsoup
   ~6-connection-per-host limit that makes a webview's own write `fetch` hang
   under SSE load — the actual motivation.)
2. **Direct in-process dispatch (`expose: { ipc: true }`).** `endpoint_invoke` →
   `dispatchProjectedToolStream` calls the tool *handler* directly, skipping the
   loopback replay. Lower latency, but **bypasses the route** — only safe when the
   handler is fully self-contained. This is the lever `expose.ipc` exposes; it's
   one line, but flipping it on a route-dependent tool is the footgun closed in
   `desktop-ipc-transport-completion-2026-05-20` (oracle:chat / agent_chats:chat).

**The gap this plan fills:** the existing imperative seam (`dispatchEndpointStream`
→ `ipc-stream` vs `http-stream`) does direct dispatch on desktop but is **not
route-aware** (no `sys:http` fallback for route-dependent tools) and is **not used
everywhere** (the bulk of traffic is `fetch` → `sys:http`, and data reads go
through `useSyncQuery`/`rest-query`). `callTool` unifies these into one seam that
picks the optimal **and safe** transport per endpoint from the registry.

**Honest scope of the win (read before greenlighting):**
- Off-browser-HTTP: already delivered by `sys:http`; the seam doesn't add it, it
  just makes it the clean default and lets some endpoints go faster.
- Latency from direct dispatch: ~tens-to-hundreds of µs saved per request against
  PG/LLM work in ms-to-seconds → imperceptible. Apply selectively, profile-first.
- For big/streamed payloads HTTP is *better* (the `papercusp://` handler buffers).
  Keep those on HTTP/`sys:http`.
- Observability: any IPC (sys:http or direct) is invisible to the browser network
  panel — the panel we just used to debug. A dev inspector is part of this plan.

## Design

### The seam API
- **`callTool(name, input, opts?)`** — unary call to a projected tool; returns the
  typed `ToolResult`. Type-safe per `name` against the projected registry.
- **`callToolStream(name, input, opts?)`** — streaming call; async iterable of the
  tool's typed events (`delta` / `sse-chunk` / …) + a terminal.
- **`callRoute(path, init?)`** — escape hatch for arbitrary **non-tool** routes
  (sync `rest-query`, plugin routes). Off-HTTP via `sys:http` on desktop, HTTP
  otherwise. (Today's `fetch` polyfill, made explicit.)
- Clients call ONLY these — never `fetch('/api/…')` directly.

### Transport picker (registry-driven, the core)
Per call, resolve from the projected registry + runtime:
1. **Not in Tauri** → plain HTTP. Universal floor.
2. **In Tauri + IPC up + tool `expose.ipc`-eligible (self-contained)** → direct
   dispatch (`ipc-stream` / `endpoint_invoke`). Fast path.
3. **In Tauri + IPC up + route-dependent** (or `callRoute`) → `sys:http`
   (route-preserving). Default for everything not explicitly upgraded.
4. **IPC not up** → plain HTTP — NOT a permanent latch; re-checked per call (the
   permanent latch caused the dev-IPC reload churn, see `dev-ipc-sse-churn-reverted`).

### Request context (the correctness-critical part)
The route injects what an IPC dispatch lacks: **session user** (cookie →
`getSessionUserOrDefault`) and **workspace scope** (`?ws=`/header → ALS → RLS GUC).
- `callTool` assembles a `RequestContext { userId, workspaceId, headers }`
  client-side (desktop: local user + the window's `getBrowserWorkspaceId()`).
- **`sys:http` path:** context rides as headers exactly as today — no change.
- **Direct path:** the IPC server applies the `RequestContext` server-side (set the
  workspace RLS GUC + `ctx.user`) so a direct-dispatched tool is scoped
  **identically** to the route path. This parity is the eligibility gate.

### Eligibility invariant
`expose: { ipc: true }` ⟺ the handler performs **every** security + correctness +
persistence effect the route did (principal/auth, RLS scoping, cost-caps,
persistence, audit). The route may keep ONLY in-boundary-safe shell concerns
(rate-limit DoS, idle-cache short-circuit). Enforced by a per-tool **parity test**
(direct == route: same auth, RLS scope, side-effects) — not a blind flip.

### Observability + streaming
- A **dev IPC-traffic inspector** (`/dev` panel + ring buffer) records
  `{ tool, transport: direct|sys:http|http, durationMs, status }` per call —
  replaces the network panel for IPC traffic.
- `callToolStream` unifies SSE (`sse-chunk`) and tool events (`delta`, …) under one
  async-iterator shape; fallback re-checks IPC per call (no latch). **Prereq:** the
  SSE-over-IPC reconnect/`onopen` churn (the dev-IPC flashing) must be fixed before
  the IPC streaming path is trusted (Phase D).

## Phase A — Build the seam (behavior-preserving)

Default everything to `sys:http`; no direct dispatch yet. A pure refactor that
centralizes the transport without changing semantics.

- **P-001** `todo` Define `callTool` / `callToolStream` / `callRoute` API + per-`name` types derived from the projected tool registry (generated client types or a typed registry).
- **P-002** `todo` Transport picker — registry-driven (HTTP / sys:http / direct) with a per-call fallback (no permanent latch). Default = `sys:http`; direct disabled until Phase E.
- **P-003** `todo` `RequestContext` assembly client-side (userId = local/default; workspaceId = `getBrowserWorkspaceId()`; headers). Rides as headers on the sys:http path (no behavior change).

## Phase B — Migrate call sites onto the seam

Sweep `fetch('/api/…')` → `callTool` / `callRoute`. Incremental — the polyfill
keeps un-migrated `fetch` working as a safety net.

- **P-004** `todo` Codemod tool-shaped `fetch('/api/x', init)` → `callTool('x', input)` across the operator SPA; non-tool routes → `callRoute`. Polyfill remains the net for the long tail.
- **P-005** `todo` Route the sync data fetcher (`useSyncQuery` / `rest-query` batch) through `callRoute` so the bulk traffic rides the seam.

## Phase C — Dev IPC-traffic inspector

So IPC traffic is debuggable (the network panel can't see it).

- **P-006** `todo` `/dev` IPC-traffic panel + ring buffer: per-call `{ tool, transport, durationMs, status }`.

## Phase D — SSE-over-IPC reliability (prereq for streaming over IPC)

- **P-007** `todo` Fix the `IpcEventSource` reconnect / `onopen` / channel-lifecycle churn that caused the dev-IPC reload loop (see `dev-ipc-sse-churn-reverted`) before relying on `callToolStream` over IPC. Affects release SSE too.

## Phase E — Selective direct-dispatch upgrades (profile-driven)

Per hot endpoint proven transport-bound — NOT a blanket flip.

- **P-008** `todo` Server: direct-dispatch path applies the `RequestContext` (workspace RLS GUC + `ctx.user`) so direct == route scoping.
- **P-009** `todo` Per profiled hot endpoint: self-contained-ify the handler + `expose.ipc: true` + a parity test (direct == route auth/RLS/effects) → `callTool` auto-upgrades it. `blockedBy: P-008`.

## Risks & open questions

- **Migration size.** 100+ call sites. Mitigate: incremental + codemod-able; the
  polyfill is the net for the long tail.
- **Not all `/api` are tools.** Sync `rest-query`, plugin routes → `callRoute`
  (sys:http), not `callTool`.
- **Context parity is the hard correctness bar.** Direct dispatch must scope
  identically to the route (RLS GUC + user). Per-tool parity test required.
- **Payoff is µs.** Phase E is selective. If review decides no endpoint warrants
  direct dispatch, Phases A–D still stand alone (seam + off-HTTP + observability).
- **Open:** does `callTool` subsume/rename `dispatchEndpointStream` (recommended)
  or wrap it? How are per-`name` types derived from the registry? Does the data
  seam (`useSyncQuery`) wrap its fetcher in `callRoute`, or stay as-is on sys:http?

## Acceptance

- `callTool` / `callToolStream` / `callRoute` exist, typed against the registry; a
  representative slice of call sites migrated; **behavior unchanged** (sys:http
  parity); webview shows **0** browser-pooled `/api` network entries.
- Dev IPC inspector shows per-call `{ tool, transport, duration }`.
- ≥1 endpoint upgraded to direct dispatch with a **passing parity test**, shown as
  `direct` in the inspector.

## Decisions

### D-001 — Default transport is sys:http; direct dispatch is opt-in per eligible tool
Date: 2026-06-01
`callTool`/`callRoute` default every desktop call to `sys:http` (HTTP-over-IPC, route-preserving) — already off browser-pooled HTTP and semantically identical to a plain route call. Direct in-process dispatch is an *opt-in upgrade* the picker chooses only for registry-eligible (`expose.ipc`) tools. Safe-by-default: a new or un-reviewed endpoint is correct (routes run) without any per-tool work; you never get the route-bypass footgun by default. Off-desktop (browser/webapp) → plain HTTP.

### D-002 — Two surfaces: callTool (typed registry tools) + callRoute (arbitrary paths)
Date: 2026-06-01
`callTool(name, input)` / `callToolStream` cover projected tools, typed against the registry. `callRoute(path, init)` is the escape hatch for non-tool endpoints (sync `rest-query`, plugin routes, static-ish) — essentially today's `fetch` polyfill made explicit, off-HTTP via `sys:http` on desktop. Both are the ONLY ways clients hit an endpoint; no hand-crafted `fetch('/api/…')` remains. Only `callTool` can ever be upgraded to direct dispatch; `callRoute` is always sys:http/HTTP.

### D-003 — Direct-dispatch eligibility is earned, not flipped
Date: 2026-06-01
`expose: { ipc: true }` is valid ONLY when the handler performs every security + correctness + persistence effect the route did (principal/auth, workspace RLS scoping, cost-caps, persistence, audit). The route may keep only in-boundary-safe shell concerns (rate-limit DoS protection, idle-cache short-circuit). Two gates per upgrade: (1) `callTool` assembles a `RequestContext` client-side and the IPC server applies it on the direct path (RLS GUC + ctx.user) so direct == route scoping; (2) a per-tool parity test asserts direct and route produce the same auth result, RLS scope, and side-effects. Cookie/session identity is genuinely transport-level — trivial on single-user desktop but must be explicit. This is the gate that prevents the oracle:chat/agent_chats:chat footgun.

### D-004 — No permanent IPC latch — re-check availability per call
Date: 2026-06-01
The transport fallback (IPC → HTTP) must re-evaluate IPC availability on each call, never set a session-permanent "IPC dead" latch. The existing `ipcStreamingUnavailable` permanent latch is implicated in the dev-IPC reload churn (see `dev-ipc-sse-churn-reverted`): one early failure before the IpcClient connected pinned the whole session to a degraded path. `callTool` connects/handshakes early and falls back transiently, so a late-connecting or briefly-dropped IPC recovers instead of staying down.

### D-005 — The value is the seam + off-HTTP + observability — not latency; direct dispatch is selective
Date: 2026-06-01
Direct dispatch saves only the loopback-HTTP replay (~tens-to-hundreds of µs) against PG/LLM work in ms-to-seconds — imperceptible. So Phase E (direct-dispatch upgrades) is profile-driven and selective, never a blanket flip. Phases A–D (the seam, sys:http default, call-site migration, dev inspector, SSE-over-IPC reliability) deliver the real value — a clean single interface, off browser-pooled HTTP everywhere, and IPC observability — and stand on their own even if the review decides NO endpoint warrants direct dispatch. For big/streamed payloads, plain HTTP/sys:http is preferred (the papercusp:// handler buffers; HTTP streams).

### D-006 — SSE-over-IPC reconnect: transport auto-reconnects (CONNECTING); consumers recreate only on CLOSED
Date: 2026-06-01
Root cause of the dev-IPC flashing (Phase D): `IpcEventSource` was one-shot — `done`/stream-end/transient-error called `close()` (CLOSED, terminal). A native `EventSource` instead AUTO-RECONNECTS on a drop (readyState→CONNECTING, re-opens with `Last-Event-ID`) and only goes CLOSED on a fatal/`.close()`. So a dropped sync SSE made native reconnect seamlessly but `IpcEventSource` die → the consumer's resilient layer recreated it → a fresh IPC channel + sync re-subscribe + re-render every drop = the churn.

The contract, applied across the stack: the **transport** (`IpcEventSource`, like native) reconnects itself on a drop, staying CONNECTING; **consumers** recreate the EventSource ONLY when it is genuinely dead (`readyState === CLOSED`), never on a transient error/CONNECTING. Fixed so far: `IpcEventSource` auto-reconnects (desktop-ipc 8f2da9a); `DesktopAttentionNotifier.onerror` now recreate-on-CLOSED (was `!== OPEN`, which fired during reconnect). REMAINING: the main sync consumer — `SSEAdapter` → `@papercusp/sse` `createResilientEventSource` — manages its own reconnect (zombie watchdog + backoff) and must be audited/aligned to recreate-on-CLOSED (not on every error); plus end-to-end verification (re-enable IPC, confirm no reconnect storm in the IPC-traffic inspector / no flashing). Until that alignment + verification, dev-IPC stays off.
