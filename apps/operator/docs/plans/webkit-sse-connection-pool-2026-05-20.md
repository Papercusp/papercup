---
title: WebKitGTK connection-pool exhaustion — diagnosis & fix plan
slug: webkit-sse-connection-pool-2026-05-20
status: active
created: 2026-05-20
updated: 2026-06-01
owner: pandawamble@gmail.com
---

## Now

**State:** Root cause still valid: WebKitGTK/Chromium cap of 6 conns/host; permanent SSE streams camp all slots and starve fetches + the agent-thinking popover. Since written, the FIX track moved to the **desktop IPC transport**: `http2-sse-transport-2026-05-20` (the original HTTP/2 fix) is now `superseded` and explicitly "supersedes the fix section of THIS plan" → `desktop-ipc-transport-completion-2026-05-20` is canonical. On packaged desktop, `IpcEventSource`/`ipcFetch` (apps/operator/lib/transport-adapters) route /api/* SSE+fetch over IPC, bypassing the libsoup cap entirely. 3 pressure-reduction fixes shipped (SSE-only transport, removed duplicate HarnessZeroProvider, batched rest-query). NOT shipped: Option A (SSE mux) + Option B (lazy streams 3/4/5 — OperatorBackgroundScanner / intent-dispatcher / use-state-snapshots are all still always-on). Caveat: dev still uses native EventSource (IPC-SSE caused webview reload churn in dev and was reverted); packaged IPC-SSE was Phase-4-verified under Xvfb but default-gated pending a packaged smoke.

**Next:** Owner — decide: (a) supersede this into desktop-ipc-transport-completion once a COLD-launch run passes the verification protocol (≤4 ESTAB :3055 sockets, zero "access control" errors on first /harness paint), OR (b) ship Option B (make streams 3/4/5 lazy) as a transport-independent floor that helps even when SSE falls back to native EventSource. Keep this doc as the canonical root-cause diagnosis either way.

## Symptom

In the Tauri desktop app (`papercusp-desktop`), the console intermittently fills with:

```
Fetch API cannot load http://localhost:3055/api/... due to access control checks.
```

…on a fresh window launch, worst on `/harness`. The JS-side manifestation is
`TypeError: Load failed`. It is **not** a CORS error — that message is WebKit's
misleading label for a fetch that never got a connection.

## Root cause — CONFIRMED (two independent lines of evidence)

WebKitGTK routes HTTP through **libsoup**, whose `SoupSession` has a default
`max-conns-per-host` of **6**. The operator opens too many *permanent* SSE
streams against `localhost:3055`, so all 6 slots are camped and every regular
`fetch()` queues for a slot that never frees.

### Evidence 1 — live socket count

`ss -tnp` on the running webview process showed **exactly 7 ESTAB sockets** to
`127.0.0.1:3055`, all idle (zero queue). An in-page
`fetch("/api/desktop/version?probe=...")` **never reached the server** (no log
line) while `curl` to the identical URL returned 200 in 7 ms.

### Evidence 2 — static analysis of SSE consumers

Each component calls `createResilientEventSource` independently — `@restart/sse`
has server-side channel fan-out (`getChannel`) but **no client-side connection
multiplexer**. One consumer = one EventSource = one permanent socket.

| # | Consumer | Endpoint | Mounted |
|---|---|---|---|
| 1 | `HarnessZeroProvider` (Zero sync) | `/api/zero-harness/sse` | always (root) |
| 2 | `OperatorPanel` | operator stream | always (ChromeShell) |
| 3 | `OperatorBackgroundScanner` | `/api/agent-mcp/operator-scan?background=1` | always (ChromeShell) |
| 4 | `intent-dispatcher` | `/api/ui/intents/stream` | always (UiPresenceProvider) |
| 5 | `use-state-snapshots` | `/api/operator/state-snapshot` | always (OperatorConversationProvider) |
| 6 | `HarnessDashboard` | `/api/harness/<slug>/log/stream` | `/harness` only |

**5 always-on + 1 on `/harness` = 6 SSE streams. Plus Next dev's HMR socket = 7.**
That matches the 7 ESTAB sockets exactly. On non-harness routes it's 5 SSE + HMR
= 6 — still at the limit, zero headroom. This is why even `/setup` showed errors.

## Why ~15 prior fix attempts failed

Every previous "fix" (devUrl, `Connection: close`, route prewarmer, CORS
headers) addressed a *different* hypothesis. None reduced the connection count.
And every verification was done in a **warm session** — where the SSE streams
had already settled and a `fetch()` happened to win a slot during reconnect
churn. The bug only reproduces reliably on a **cold window launch**, which only
the user was doing. The verification methodology was structurally blind to it.

---

## Fix options

### Option A — client-side SSE multiplexer in `@restart/sse` (correct, larger)

One shared `ResilientEventSource` to a new `/api/sse/mux` endpoint; consumers
`subscribe(topic, handler)`. Server fans the requested channels into one stream,
tagging each event with its topic. 6 connections → 1.

- **Pros:** correct, permanent, scales; collapses the whole class of bug.
- **Cons:** new server endpoint + topic routing; new client `SharedEventSource`
  (subscribe/unsubscribe, dynamic topic set, reconnection); 6 call-site
  migrations. The 6 endpoints are heterogeneous (pure subscriptions vs.
  request-scoped streams like `operator-scan` and the slug-parameterised
  harness log) — the mux endpoint must handle both shapes.
- **Effort:** ~1–2 focused sessions. Feature-sized; needs its own review.

### Option B — make non-critical SSE streams lazy (smaller interim)

Only streams 1 (Zero sync) and 2 (OperatorPanel) are genuinely always-needed.
Make 3/4/5 connect **only when their feature is active**:

- `OperatorBackgroundScanner` (#3) — runs a *background scan*; does not need a
  permanent stream. Connect on demand, or poll on a timer.
- `intent-dispatcher` (#4) — agent→UI control; only needed while an agent
  session is live.
- `use-state-snapshots` (#5) — chat-card state; only needed while chat is open.

Steady-state always-on drops to 2 SSE + HMR = 3 — large headroom.

- **Pros:** smaller, no new endpoint, no library change.
- **Cons:** "lazy" has its own correctness surface (when exactly to
  connect/disconnect); 3 files change behaviour; fragile if a future component
  re-adds an always-on stream.
- **Effort:** ~1 session.

### Why not the others
- **Bump `max-conns-per-host`:** WebKitGTK exposes no public API for it; not
  reachable from Tauri.
- **Split SSE onto a second host (`127.0.0.1` vs `localhost`):** doubles the
  pool to 12 but is fragile (breaks again at 6 streams on one host) and
  interacts with cross-origin/credentials on EventSource. Rejected.

## Recommendation

**Option A** is the right fix. Option B is a reasonable interim if a same-day
unblock is needed. They are compatible — B can ship first, A supersedes it.

## Verification protocol (mandatory — the prior failure mode)

A fix is **not** verified until:
1. The user **fully quits** the Tauri app and relaunches via `npm run dev`.
2. On the **first paint** of `/harness`, the console shows zero
   `Fetch API cannot load … access control checks` lines.
3. `ss -tnp | grep WebKit | grep :3055` shows **≤ 4** ESTAB sockets at rest.

Warm-reload verification is invalid for this bug and must not be used.

---

## Session loose ends (separate from this fix)

Correct, keep: `devUrl: localhost`, `OperatorPanel.tsx` stray `)}` removal,
`HarnessZeroProvider.tsx` revert, voice-mode WebRTC guard + transient filter,
static `tauri-bindings` imports, `SupportAgentPanel` localhost skip.

Reconsider once the fix lands: `next.config.js` `Connection: close`,
`instrumentation-node.ts` prewarmer (both speculative — written under wrong
hypotheses; harmless but probably unnecessary).

Done: diagnostic `localStorage` capture removed from `layout.tsx`.

---

## Update 2026-05-20 (later) — popover investigation + 3 shipped fixes

Reached this same root cause from a different symptom: the live
agent-thinking popover (hover an active-agent pill) stuck on
"connecting…" forever while the harness runs. The popover's EventSource
is effectively a 7th SSE stream — with all 6 slots camped it never gets
one. Confirmed in plain Chromium too (not WebKit-specific — Chromium's
HTTP/1.1 cap is also 6): blank page → agent stream connects in 700ms;
loaded `/harness` page → 11s+, intermittently never.

Three fixes shipped (commits `21e5c1b3` main + `1b2ee83` libs/sync):

1. **Transport selection** — in a plain browser `HarnessZeroProvider`
   fell through to `syncType="POLLING"` (the WEBSOCKETS branch needs a
   `zeroServer`, which is null since zero-cache retired). POLLING
   re-fetched all ~40 Zero queries every 5s — a `fetch()` storm *on top
   of* the 6 camped SSE slots. Now SSE for every runtime; dead
   WEBSOCKETS/zeroServer plumbing removed.
2. **Duplicate provider** — `HarnessZeroProvider` was mounted at the
   root layout *and* again in `harness/layout.tsx`, opening a 2nd
   unread `/api/zero-harness/sse`. Removed the harness-layout copy.
   (This stream is not in the table above — it was an 8th, undercounted.)
3. **Batched rest-query** — invalidate waves fired ~40 parallel
   `GET /rest-query`. Added `POST /rest-query-batch`; client batches a
   whole wave into one request. Cuts `fetch()` pressure hard.

**These reduce the pressure but do NOT resolve the core finding.** The
6 permanent SSE streams (table above) still camp all 6 slots, so the
popover's EventSource still has zero guaranteed headroom — it connects
only when reconnect churn briefly frees a slot (measured 0.4s best case,
>8s / fails worst case). **Option A or B is still required** to give the
popover (and every on-demand `fetch`) a reliable slot. Recommend B as
the targeted unblock (make streams 3/4/5 lazy → 2 always-on + popover =
3, comfortable headroom), A as the permanent fix.
