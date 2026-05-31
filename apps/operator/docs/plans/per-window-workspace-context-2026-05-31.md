---
title: Per-window workspace context — resolve workspace per request, not per process
slug: per-window-workspace-context-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

# Per-window workspace context — resolve workspace per request, not per process

## Now

**State:** Design plan (not started), **revised 2026-05-31 after a code-verified
peer review** (findings folded in below). Captures the fix for a fragility
surfaced dogfooding the papercup harness Tests tab: harness data resolves against
a single **process-global active workspace** (`reg.current`), so two desktop
windows on different workspaces collide, and anything that flips `reg.current`
(a workspace switch, or a concurrent agent) silently corrupts a window's data.

**Concrete symptom (2026-05-31):** the papercup harness lives in
`papercusp-workspace`. While `reg.current` was `default` (flipped by concurrent
org-harness work), `GET /api/harness/papercup/testing/domains` could not resolve
papercup → the Tests tab fell back to the generic 6-domain set (and on reload
the `/adv` window flipped to `default`'s `sheets` harness). The window's URL said
`?ws=papercusp-workspace`, but the backend ignored it.

**Next action:** Phase 0 — the **go/no-go gate (D-006)** comes first: confirm
whether the data lives in one shared embedded-PG (RLS-scoped) or per-workspace
DBs, because that decides whether "two workspaces in one process" is even
feasible and whether the ALS/`app.workspace_id` mechanism is the right layer. In
parallel, run the call-site audit (P-001, now 3 request classes) and settle the
**stream transport** (P-002 — SSE/WS *cannot* carry a custom header; see D-001).
Nothing ships until D-006 and D-001 are resolved.

## Background

### How workspace is resolved today (the single global)

`activeWorkspaceId()` (`apps/operator/lib/workspace-registry.ts:77`) returns
`readRegistry().current` — read **fresh on every call, no memoization** (review-
confirmed) — from `~/.papercusp-workspaces/registry.json` (root via
`PAPERCUSP_WORKSPACES_ROOT`, else `homedir()`; see insight
`workspaces-root-vs-remapped-home`). That one value drives **two** things:

1. **Harness resolution** — `resolveProject(slug)` (`harness-core.ts`) →
   `loadHarnessRegistry()` → the *active workspace's* registry row. A slug in a
   non-active workspace returns `null` ("unknown project"). (The other caches in
   `harness-core.ts` are keyed on filesystem paths — orthogonal to workspace, so
   they don't defeat per-request resolution. Review-confirmed.)
2. **PG row scoping** — `routeWithWorkspace(fn)` (`route-workspace.ts:38`) =
   `withWorkspace(activeWorkspaceId(), fn)` → a tx with
   `SET LOCAL app.workspace_id` (`workspace-context.ts:42`), enforced by **RLS
   policies** (`USING (workspace_id = current_setting('app.workspace_id', true))`).

So *both* "which harness" and "which rows" come from the process-global value,
and **492 call sites genuinely funnel through that one function** (review-confirmed).

### What the frontend knows but doesn't send

Each window knows its workspace: `window.__PAPERCUSP_WS__` (injected into
`index.html`); `getBrowserWorkspaceId()` (`browser-workspace.ts`) reads it (→
`?ws=` → `'default'`). But **requests don't carry it** — the operator-vite IPC
bridge (`window.fetch = ipcFetch`, `window.EventSource = IpcEventSource`,
installed first in `__root.tsx`) forwards to the sidecar without a workspace.

### Verified by review (2026-05-31) — load-bearing facts

- **One ALS middleware covers both ingresses.** `:3055` (Next) delegates to the
  same inner Hono app as `:3070` via `hono/vercel`
  (`app/api/[[...route]]/route.ts` → `bin/host-app.ts`). No ingress multiplicity
  to worry about — one middleware on the inner app does it.
- **`ipcFetch` already forwards arbitrary headers end-to-end**
  (`desktop-ipc/src/ipc-fetch.ts` → `ipc-endpoint-server/src/sys-http.ts`,
  hop-by-hop filtered). So the header for the **fetch** path is real and easy.
- **Streams CANNOT carry a custom header.** On desktop `window.EventSource =
  IpcEventSource`, which takes no `headers` option and hardcodes only
  `accept: text/event-stream` + conditional `Last-Event-ID`
  (`desktop-ipc/src/ipc-event-source.ts`). Native `EventSource` has the same
  web-platform limitation. The Zero/voice **WS** transports likely share the gap.
  This is a real blocker, not an assumption — see D-001.
- **Shared-DB-with-RLS vs per-`HOME` PG is a genuine conflict (the feasibility
  fork).** The schema is built shared-DB: ~205 `workspace_id` columns + RLS
  scoping by `app.workspace_id` — i.e. *one DB serving many workspaces*. **But**
  packaged spawns the sidecar with `HOME` remapped per-workspace
  (`src-tauri/src/main.rs:111 .env("HOME", workspace_home)`), and embedded-PG
  discovery is `HOME`-relative (`~/.papercusp/embedded-pg.json`) → packaged
  runtime gives each workspace its **own** PG instance. One window serving two
  workspaces is impossible under per-`HOME` PGs; it works only on the shared-DB
  model the schema already assumes. **This is D-006 and it gates the plan.**

### Why it "works" in packaged but not dev

Packaged isolates per-workspace via per-`HOME` sidecar+PG (above). Dev shares
**one** sidecar (`papercup-dev-api.service` on `:3070`, `HOME=~`) → all windows +
agents share one `reg.current` → the flapping. The shipped model leans on
process-per-workspace; expensive (sidecar reboot per switch) and still can't hold
two workspaces open at once in one process.

### Goal

A request resolves against the **window that made it**, not the process.
`reg.current` keeps meaning only "default for new windows / non-request work" — it
stops being authoritative for request resolution.

### Relationship to other plans

- `harnesses-across-workspaces-2026-05-31` — the **membership** model (a harness
  in N workspaces; shared results; workspace-owned config). This plan is the
  **resolution** half: once a harness is in N workspaces, a request must say
  *which* workspace it acts in. Both must agree on `(workspace, harness)`.
  **D-006's shared-DB resolution is a shared dependency** with that plan's
  "shared results."
- `workspace-localstorage-isolation-2026-05-27` — client-side per-workspace
  storage; complementary (server side here).

## Decisions

### D-001 — Transport: header for fetch; an explicit stream channel for SSE/WS `[proposed]`

Windows send `x-papercusp-workspace: <id>`. **For fetch this is real and easy** —
`ipcFetch` already forwards arbitrary headers (review-confirmed). **For streams it
is NOT possible:** `EventSource`/`IpcEventSource` cannot set custom headers. So:
- **Streams (SSE `/api/zero-harness/sse`, voice WS, Zero WS):** either
  **(A, preferred)** extend `IpcEventSource` with a `headers` option merged into
  its `run()` headers (small change in a borrowable lib — it dispatches over the
  same `sys:http` channel that already forwards headers), **or (B, fallback)**
  accept a `?ws=` query param **on connect only**. The blanket "no query params"
  rejection holds for fetch but **does not** hold for streams — `?ws=` on connect
  is the standard `EventSource` workaround.
- A fetch-only fix is a **half-fix**: `GET /testing/domains` would resolve while
  live SSE invalidations keep using `reg.current`, so the opening symptom
  persists on the primary sync path. The stream channel is a must-fix, not polish.
- *Rejected for fetch:* threading `ws` through ~492 call sites (misses PG scoping,
  enormous churn).

### D-002 — Request-scoped context via AsyncLocalStorage; `activeWorkspaceId()` prefers it `[proposed]`

One Hono middleware on the **inner** app (covers `:3055` + `:3070`) populates an
`AsyncLocalStorage<{ workspaceId }>` from the header. `activeWorkspaceId()` becomes
`currentRequestWorkspaceId() ?? readRegistry().current`. Linchpin: `resolveProject`
and `routeWithWorkspace` already call it, so **both harness resolution and PG
scoping become per-request with ~zero call-site changes**.

### D-003 — Background contexts pass workspace explicitly; never silently inherit the global `[proposed]`

Scanner, orchestrator, scheduled jobs, SSE/WS push fan-out, timers — no request on
the stack → no ALS. They carry an **explicit** workspace decided at job creation,
not `reg.current`. (ALS context can also be **lost across async detach points** —
event emitters, queued/timer work — silently falling back to the global; P-021's
assert + P-061's guard are the safety net for that.)

### D-004 — A header is untrusted input; authz must gate workspace access `[needs-human]`

`x-papercusp-workspace` is client-supplied/spoofable. Today's trust is loopback-
based. Before relying on it on any exposed/multi-tenant host, the principal must be
checked against its allowed workspaces. (RLS softens the *leak* risk — a wrong
workspace yields **empty**, not another tenant's rows — but authz is still needed
to prevent *acting* in a workspace you shouldn't.) Low-risk for loopback desktop.

### D-005 — Keep `reg.current`; redefine its role `[proposed]`

Keep it as the default a *new* window opens into and the workspace background jobs
use when not told otherwise. Stop making it authoritative for request resolution.

### D-006 — Sidecar/PG model: shared one-embedded-PG vs per-`HOME` per-workspace DB (go/no-go) `[needs-human]`

**This gates the whole plan and must be answered first.** The schema is already
shared-DB + RLS (one DB, many workspaces) — which *enables* the goal. But packaged
runtime is per-`HOME` → per-workspace PG, which *blocks* one process serving two
workspaces and *collides* with `harnesses-across-workspaces`' shared results.
- **Go (recommended direction):** packaged adopts one shared embedded-PG with RLS
  (the model the schema already targets) and drops per-`HOME` PG isolation. Then
  the ALS/`app.workspace_id` mechanism is the right layer and the headline goal is
  reachable.
- **No-go:** if per-`HOME` data isolation is load-bearing (real per-workspace DBs),
  then "two workspaces in one process" is off the table and the goal/mechanism
  change. Decide before Phase A.

### D-007 — Unknown workspace header → hard error; only a *missing* header falls back `[proposed]`

P-011 must distinguish: **missing** header (legacy/background) → global fallback is
acceptable; **present-but-unknown** workspace id → **reject loudly (400/409)**,
never silently fall back. Present-but-unknown is exactly the silent-corruption mode
this plan exists to kill (and is likely under packaged per-`HOME`, where a sidecar
only knows its own workspace).

## Phase 0 — Gate decisions + audit (no shipping code)

- **P-001** `todo` Enumerate every `activeWorkspaceId()` reader (492 sites) +
  `routeWithWorkspace`/`withWorkspace` users, tagging each as one of **three**
  request classes: **(a) browser-window request** (gets ALS from the header),
  **(b) background job** (explicit workspace, D-003), **(c) MCP/agent tool call**
  (`mcp__papercusp__*` hits the same sidecar, resolves `activeWorkspaceId()`, is
  neither a window nor purely background — the MCP server is harness-scoped at
  launch; define how a tool call carries its workspace into the ALS). Count via
  `rg -c activeWorkspaceId` per file (output-mangling caveat).
- **P-002** `todo` **Decide + spec the stream transport** (D-001): extend
  `IpcEventSource` with `headers` (preferred) vs `?ws=` on connect; enumerate ALL
  stream endpoints (`/api/zero-harness/sse`, voice WS, Zero WS, agent-chat
  streams). This is "decide + own as work," not "confirm."
- **P-003** `todo` **Resolve D-006 (go/no-go).** Read `src-tauri/src/main.rs` +
  the embedded-PG discovery path; determine whether packaged can move to one
  shared embedded-PG (RLS) or whether per-`HOME` isolation is load-bearing. This
  is the feasibility gate, not a late-phase cleanup.
- **P-004** `todo` Lock D-001…D-007 with the owner (esp. D-006 go/no-go, D-004
  authz, D-007 error semantics).

## Phase A — Request-scoped workspace context + stream transport (the core)

- **P-010** `todo` Add the workspace ALS — **match the existing
  `runWithPluginExecCtx`/`currentPluginExecCtx` precedent** (`lib/log-events.ts:54`)
  for naming/shape; decide whether workspace is a sibling field on that context or
  a second ALS instance. Export `runWithWorkspace(id, fn)` +
  `currentRequestWorkspaceId()`.
- **P-011** `todo` One middleware on the **inner Hono app** (covers `:3055` +
  `:3070`): read `x-papercusp-workspace`; **missing → empty ALS (global fallback);
  present-but-unknown → 400/409 (D-007)**; valid → wrap handler in
  `runWithWorkspace`.
- **P-012** `todo` `activeWorkspaceId()` → `currentRequestWorkspaceId() ??
  readRegistry().current`. Single change; everything downstream inherits it.
- **P-013** `todo` Frontend fetch: inject `x-papercusp-workspace` from
  `getBrowserWorkspaceId()` in the operator-vite `fetch` wrapper (trivial —
  `ipcFetch` already forwards headers).
- **P-015** `todo` **Stream transport (D-001/P-002):** implement the chosen option
  for SSE + voice/Zero WS so live invalidations carry the window's workspace —
  without this the fix is a half-fix.
- **P-014** `todo` Verify the win on **both** paths: `GET /testing/domains` AND a
  live SSE subscription resolve papercup **while `reg.current=default`** (the exact
  failure from today). Add the two-windows test (P-060).

## Phase B — Background- and MCP-context safety

- **P-020** `todo` For each background reader (P-001 class b), thread an explicit
  workspace from the job's creation context (scanner sweep, orchestrator spawn,
  scheduled routine, SSE/WS push fan-out) — never the global.
- **P-022** `todo` For MCP/agent tool calls (P-001 class c), carry the launch-time
  harness/workspace scope into the ALS for the duration of the tool call.
- **P-021** `todo` Dev assert/log when `activeWorkspaceId()` falls through to the
  global *inside a request* (header missing, or ALS lost across an async boundary).

## Phase C — `/adv` view drives off the window's workspace

- **P-030** `todo` `/adv` active workspace + harness come from the window
  `?ws=`/`__PAPERCUSP_WS__`, not a re-resolve against `reg.current` on load — fixes
  the reload-flip to another workspace's harness.
- **P-031** `todo` A switch in one window doesn't yank others; it updates this
  window's URL + (optionally, last-writer-wins) `reg.current` as the new default
  without forcing reloads elsewhere. (`reg.current` is a JSON file — concurrent
  writes are last-writer-wins; acceptable since it's only the new-window default.)

## Phase D — PG scoping correctness

- **P-040** `todo` Confirm `routeWithWorkspace` (now per-request) sets
  `app.workspace_id` to the request workspace and RLS isolates two concurrent
  requests on different workspaces (true by construction — `SET LOCAL` per-tx).
- **P-041** `todo` Audit direct `getOrgPg().sql` reads of workspace-scoped tables
  that bypass `withWorkspace` for missing scoping now the workspace varies
  per-request.

## Phase E — Implement the D-006 decision (packaged data model)

- **P-050** `todo` Implement the D-006 outcome. If **Go**: make packaged use one
  shared embedded-PG with RLS and stop per-`HOME` PG isolation (one source of
  truth; enables multiple workspaces open at once; aligns with
  `harnesses-across-workspaces`). If **No-go**: revise the plan's goal/mechanism.
  (This is implementation of a Phase-0 decision, not a deferred reconciliation.)

## Phase F — Tests + regression guard

- **P-060** `todo` Integration test: one host, two simulated windows with different
  `x-papercusp-workspace` (and the equivalent on a stream connect), assert each
  gets correctly-scoped harness + PG data with no cross-talk.
- **P-061** `todo` Guard: fail if a *request-path* module reads `reg.current`
  directly (bypassing `activeWorkspaceId()`/ALS) — same spirit as
  `no-server-imports-in-client`.

## Risks / open questions

- **Stream transport (D-001)** — the must-fix; `EventSource`/`IpcEventSource` can't
  carry headers, so SSE/WS need the extend-or-`?ws=` channel or the symptom
  persists on the primary sync path.
- **Sidecar/PG fork (D-006)** — the feasibility gate; shared-DB-RLS enables the
  goal, per-`HOME` PG blocks it. Resolve first.
- **Auth (D-004)** — header spoofable; RLS prevents leaks (wrong ws → empty) but
  not unauthorized *action*. Gate before any non-loopback exposure.
- **ALS context loss** — across async detach points the workspace can silently fall
  back to the global; P-021 assert + P-061 guard are the net (and the chokepoint-
  threading refinement below shrinks the exposure).
- **Membership coupling** — land consistently with `harnesses-across-workspaces`;
  the request workspace is the `(workspace, harness)` disambiguator.
- **Refinement (considered):** rather than 492 ambient reads, thread the workspace
  explicitly through the few **chokepoints** (`getOrgPg`/`routeWithWorkspace`,
  `resolveProject`/`resolvePhasedProject`) with the ALS feeding their default —
  most of explicit-threading's compile-time safety for ~10% of the churn.
