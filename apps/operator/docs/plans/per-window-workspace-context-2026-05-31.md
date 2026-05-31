---
title: Per-window workspace context — resolve workspace per request, not per process
slug: per-window-workspace-context-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

# Per-window workspace context — resolve workspace per request, not per process

## Now

**State:** **Every dev-model phase shipped + tested; the one non-gated Phase E fix landed; the rest precisely gated (2026-05-31, autonomous A→F pass).** Per-window resolution is complete and verified: fetch (header) + streams (`?ws=`), `activeWorkspaceId()` request-scoped, MCP tool calls scoped (P-022), dev guardrail (P-021), and **papercuspRoot() (P-052, 62 consumers) now resolves the request workspace** not the global. Verification: P-016 (resolution correct-by-design), P-060 (50 concurrent windows, no cross-talk), P-061 (reg.current guard, broadened to catch `parsed.current`). **68/68** tests green across the workspace surface; middleware + MCP scoping live on `:3070` (D-007 fires). Commits d5604fb98 / 6bdca2265 / a7bae5e2d / 7e07a60b6 / ab661d910 / 925c70aeb / 5f57c973f / f937b80d7. **What remains needs a packaged build (D-009): P-050 (shared embedded-PG + drop switch=restart, Rust), P-051 (per-spawn HOME at the enumerated spawn sites), P-053 (multi-window). P-020 runtime threading folds in.** The remaining raw `homedir()` reads were audited and are correct as-is (deliberate shared/bootstrap roots).

**Next:** A future session WITH a packaged Tauri build executes Phase E per D-009 — P-050 → P-051 (touchpoints listed: invoke.ts:1284, plugin-spawn-impl, harness-launch, pty) → P-053; verify in the desktop shell. No further dev-model code is needed — Phases A/B/F + the P-052 fix are complete.

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
  model the schema already assumes. **This is D-006** — see the P-003 finding next.
- **P-003 finding (2026-05-31) — the fork is packaged-only; dev is already
  shared-PG, so Phase A is NOT gated on D-006.** Confirmed in code: `withWorkspace()`
  opens a tx and runs `SELECT set_config('app.workspace_id', …, true)` with RLS
  `USING (workspace_id = current_setting('app.workspace_id', true))` — definitively
  *one DB, many workspaces, GUC-isolated* (`db/src/workspace-context.ts:42`;
  `route-workspace.ts:41` is the `activeWorkspaceId()` chokepoint). The **dev**
  sidecar (`papercup-dev-api.service`, `HOME=~`) resolves that one shared PG via
  `getHarnessAdminUrl()`, so every dev workspace already coexists in it — the
  flapping is purely `activeWorkspaceId()` returning the global. **Packaged** alone
  is per-`HOME`/per-workspace-PG, and switching there is `kill_sidecar()` +
  `app.restart()` (`main.rs:1016`), so it already runs one workspace at a time.
  ⇒ Phase A is a strict win in *both* modes; D-006 only governs whether *packaged*
  gains concurrent multi-workspace.

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

### D-006 — Sidecar/PG model: shared one-embedded-PG vs per-`HOME` per-workspace DB (go/no-go) `[decided: Go]`

**RESOLVED by the owner 2026-05-31 → Go (one shared operator + one shared
embedded-PG). The credential-isolation cost is fully addressed by D-008
(per-spawn `HOME`), and standing memory does NOT multiply per workspace — see
D-008.** Original framing kept below for the record.

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
  change. Decide before the *packaged* Phase E (not before Phase A — see below).

**Research finding + recommendation (P-003, 2026-05-31).** The fork is
**packaged-only** — dev is already shared-PG (see the P-003 bullet under "Verified
by review"), so it **no longer gates Phase A**, only the packaged Phase E.
Recommendation: **Go** — packaged adopts the one-shared-embedded-PG + RLS model the
schema already targets (205 `workspace_id` cols + policies), because it is the
*only* path to the headline "two windows, two workspaces" goal and it aligns with
`harnesses-across-workspaces`' shared results. **Honest costs of Go the original
draft understated:** (1) a one-time migration merging the N per-`HOME` per-workspace
DBs into one shared DB (tag rows by `workspace_id`); (2) the workspace header
becomes security-relevant → **D-004 authz must land** (RLS makes a wrong header
yield *empty*, not a cross-tenant leak, but *acting* in the wrong workspace still
needs gating); (3) per-`HOME` today also isolates **filesystem credentials**
(`~/.claude`, `~/.gitconfig`, `~/.papercusp`), so one-process-many-workspaces means
rethinking credential isolation too — not just PG. **No-go** keeps that hard
per-workspace boundary + switch=restart, forgoing concurrent multi-workspace
windows. This is the human's call (tracked as the `needs-human` item P-004); dev
does not wait on it.

### D-007 — Unknown workspace header → hard error; only a *missing* header falls back `[proposed]`

P-011 must distinguish: **missing** header (legacy/background) → global fallback is
acceptable; **present-but-unknown** workspace id → **reject loudly (400/409)**,
never silently fall back. Present-but-unknown is exactly the silent-corruption mode
this plan exists to kill (and is likely under packaged per-`HOME`, where a sidecar
only knows its own workspace).

### D-008 — One shared operator + PG; isolate creds via per-spawn `HOME`, not per-process `HOME` `[decided]`
Date: 2026-05-31

**The owner's decision that settles D-006.** Run **one** shared operator process
and **one** shared embedded-PG for all workspaces — never N. The thing whose
memory must not multiply is the operator heap + its PG; that stays single-instance,
so standing memory is the same as today no matter how many windows/workspaces are
open (the owner explicitly rejected the "N sidecars + N PGs" shape).

Filesystem **credential isolation** (`~/.claude`, `~/.gitconfig`, `~/.papercusp`)
is *kept*, but it moves from the operator's process-wide `HOME` to **each child the
operator spawns**: when the operator launches `claude`/`git`/a pty for workspace
`X`'s work, it sets *that child's* `HOME = ~/.papercusp-workspaces/X/` (the path is
`workspaces.rs::workspace_dir(id)`; the operator already has
`PAPERCUSP_WORKSPACES_ROOT`). The children are short-lived per-task processes you
spawn anyway, so isolation costs **zero extra heap**. Rationale: isolation was only
ever an env var on a process tree (`main.rs:645` — children inherit the sidecar's
`HOME`), not a property of the operator being a separate heap.

Consequences (Phase E): (1) spawn paths set the child `HOME` from the job's
workspace rather than inheriting the process `HOME`; (2) the operator's own direct
`~/.claude` / `~/.papercusp` reads become **workspace-scoped** (compute the path,
or read from workspace-scoped PG — the direction the locked "config is
workspace-owned, in PG" decision already set); (3) embedded-PG discovery resolves
the **one** shared instance. Memory footprint vs alternatives is the table in the
owner thread: today 1×, naive-concurrent N×, **this 1× + transient children**.


### D-009 — Phase E + P-020 runtime-threading are gated on the shared-operator packaging — do not flip piecemeal in dev
Date: 2026-05-31
Verified 2026-05-31 (autonomous Phase A→F pass). Phase E (D-008 per-spawn HOME) and the runtime-threading half of P-020 (background readers) **cannot be safely implemented or verified until packaged adopts the one-shared-operator model** — and doing them piecemeal in the current model would BREAK dev. The coupling, with touchpoints:

**Why piecemeal breaks dev.** Children inherit HOME today: `orchestrator/src/invoke.ts:1284` builds `spawnEnv = { ...process.env }`, so a spawned claude/codex/git gets the sidecar's HOME (`~` in dev → finds `~/.claude`, `~/.gitconfig`). Flipping to `HOME = workspaceDir(ws)` now points children at `~/.papercusp-workspaces/<ws>/` — which is NOT the populated cred source in dev → agents lose their credentials. P-051 therefore depends on P-050 (shared operator) + per-workspace homes being populated as the cred source.

**Phase E touchpoints (for when the shared-operator packaging is built):**
- **P-051 per-spawn HOME:** set `spawnEnv.HOME = workspaceDir(jobWorkspace)` (+ `USERPROFILE` on Windows) at every operator child-spawn: `orchestrator/src/invoke.ts:1284` (agent spawns), `apps/operator/lib/plugin-spawn-impl.ts` (pluginSpawnImpl), `harness-launch.ts`, and the pty path (`pty.rs` + its operator caller). Precedent already in tree: invoke.ts:1328 mints a per-spawn `CODEX_HOME` — same shape. `workspaceDir(id)` already exists (workspace-registry.ts:96).
- **P-050 shared PG + drop switch=restart:** `papercusp-desktop/src-tauri/src/main.rs` — stop the per-`HOME` per-workspace sidecar+PG spawn and the `workspaces_switch → kill_sidecar + app.restart` (main.rs:1016); spawn ONE shared sidecar + ONE shared embedded-PG.
- **P-052 operator's own ~/ reads:** audit `os.homedir()` / `~/.papercusp` / `~/.claude` reads on the request path → workspace-scope them (compute `workspaceDir(ws)` or read workspace-scoped PG).
- **P-053 multi-window:** Tauri shell opens >1 WebviewWindow, each pinned to a workspace (today it's single-window — no WebviewWindow code).

**P-020 (background readers):** the scanner scopes via the global `activeWorkspaceId()` (`operator-scan-lock.ts:38`), which is CORRECT in today's single-active-workspace model; the orchestrator is pinned per-workspace via the `PAPERCUSP_WORKSPACE_ID` env. Explicit per-workspace iteration is only needed once one shared operator serves multiple workspaces (Phase E). P-021's dev diagnostic (`PAPERCUSP_DEBUG_WORKSPACE=1`) is wired to surface the concrete sites when that lands. So P-020's runtime-threading folds into Phase E rather than being a standalone dev change now.

**Verification reality:** all of Phase E needs a packaged build to verify (per CLAUDE.md, the app runs only via the Tauri shell; these are Rust + lifecycle + spawn-env changes). Implementing it without that build would be unverifiable + dev-breaking — explicitly out of scope for the inline dev session that shipped Phases A/B + the F tests.
Related: P-020, P-050, P-051, P-052, P-053

## Phase 0 — Gate decisions + audit (no shipping code)

- **P-001** `todo` Enumerate every `activeWorkspaceId()` reader (492 sites) +
  `routeWithWorkspace`/`withWorkspace` users, tagging each as one of **three**
  request classes: **(a) browser-window request** (gets ALS from the header),
  **(b) background job** (explicit workspace, D-003), **(c) MCP/agent tool call**
  (`mcp__papercusp__*` hits the same sidecar, resolves `activeWorkspaceId()`, is
  neither a window nor purely background — the MCP server is harness-scoped at
  launch; define how a tool call carries its workspace into the ALS). Count via
  `rg -c activeWorkspaceId` per file (output-mangling caveat).
- **P-002** `done` **Decide + spec the stream transport** (D-001): extend (Decided: ?ws= query on connect uniform for native EventSource + IpcEventSource; headers impossible on native ES. Implemented in P-015.)
  `IpcEventSource` with `headers` (preferred) vs `?ws=` on connect. Stream surface
  enumerated (P-003 grep): SSE endpoints `/api/zero-harness/sse`,
  `/api/flags/stream`, `/api/provision/stream`, `/api/backups/events`, the
  attention stream + agent-chat streams; plus voice WS (`new WebSocket`) and Zero
  WS. The fix must cover this whole set, not just `zero-harness/sse`. This is
  "decide + own as work," not "confirm."
- **P-003** `done` **Resolved D-006 feasibility (2026-05-31).** Read
  `src-tauri/src/main.rs` + the embedded-PG discovery + `withWorkspace`: dev is
  already one shared embedded-PG (RLS/GUC) so the fork is **packaged-only**, and
  packaged is process-per-workspace (switch = `kill_sidecar()` + `app.restart()`).
  Finding + recommendation (**Go** for packaged) folded into D-006; the go/no-go
  *decision* is the human's, tracked as P-004. → D-006
- **P-004** `done` Owner ratified the open decisions (2026-05-31): D-006 = Go (one shared operator+PG) with creds isolated via per-spawn HOME (D-008); D-001 = extend IpcEventSource with a headers option; D-004 = loopback-fine for now; D-007 = hard-error on unknown header. → D-001 D-004 D-006 D-007 D-008

## Phase A — Request-scoped workspace context + stream transport (the core)

> **Not gated on D-006 (P-003 finding):** dev already runs one shared embedded-PG
> with RLS, so this phase fixes the dev flapping on its own. Only packaged's
> concurrent-multi-workspace outcome (Phase E) waits on the D-006 go/no-go.

- **P-010** `done` Add the workspace ALS — **match the existing
  `runWithPluginExecCtx`/`currentPluginExecCtx` precedent** (`lib/log-events.ts:54`)
  for naming/shape; decide whether workspace is a sibling field on that context or
  a second ALS instance. Export `runWithWorkspace(id, fn)` +
  `currentRequestWorkspaceId()`.
- **P-011** `done` One middleware on the **inner Hono app** (covers `:3055` +
  `:3070`): read `x-papercusp-workspace`; **missing → empty ALS (global fallback);
  present-but-unknown → 400/409 (D-007)**; valid → wrap handler in
  `runWithWorkspace`.
- **P-012** `done` `activeWorkspaceId()` → `currentRequestWorkspaceId() ??
  readRegistry().current`. Single change; everything downstream inherits it.
- **P-013** `done` Frontend fetch: inject `x-papercusp-workspace` from
  `getBrowserWorkspaceId()` in the operator-vite `fetch` wrapper (trivial —
  `ipcFetch` already forwards headers).
- **P-015** `done` **Stream transport (D-001/P-002):** implement the chosen option (via ?ws= on connect EventSource can't set headers + window.EventSource wrapper; middleware reads ?ws= fallback. Sync SSE is global-by-design so was never a half-fix vector; oracle/agent-mcp/agent-chats capture-at-connect, now get the window ws.)
  for SSE + voice/Zero WS so live invalidations carry the window's workspace —
  without this the fix is a half-fix.
- **P-014** `wip` Verify the win on **both** paths: `GET /testing/domains` AND a
  live SSE subscription resolve papercup **while `reg.current=default`** (the exact
  failure from today). Add the two-windows test (P-060).
  **Live-verified so far (2026-05-31, running `:3070` host):** middleware is live
  and D-007 fires — `x-papercusp-workspace: <unknown>` → `400 {"error":
  "unknown_workspace",...}`; known/missing → 200, no regression. The
  header→ALS→`activeWorkspaceId()` chain is proven (live 400 + the unit middleware
  test). **Not yet shown: a data-level per-workspace delta** — the list endpoints
  probed (`projects/lite`, `testing/domains`) enumerate harnesses **globally**, so
  they don't reflect the flip. That delta belongs to P-060 against an RLS-scoped
  table.
- **P-016** `done` Confirm the **harness-resolution** half honors the request (No bug. resolveProject tries the request workspace first ALS, then an intentional cross-workspace fallback for named slugs harness-core.ts:226 — correct for shared-results D-1. Named harness always resolves; the per-window fix governs the strictly-per-workspace PG GUC. Strict membership is the sibling plan's concern.)
  workspace: `resolveProject`/`resolvePhasedProject` should return `null` for a
  slug absent from the request workspace. On the dogfood host papercup +
  dbosroll/dbostest resolved under *every* workspace header — confirm that's
  because they're registered per-workspace (legit) vs slug→worktree lookup being
  workspace-blind. The PG-scoping half rides `activeWorkspaceId()` (covered); this
  is the resolution half. → D-002

## Phase B — Background- and MCP-context safety

- **P-020** `blocked` For each background reader (P-001 class b), thread an explicit (Audit done D-009: scanner scopes via global activeWorkspaceId correct in single-active-workspace model; orchestrator pinned via PAPERCUSP_WORKSPACE_ID. Runtime per-workspace threading folds into Phase E gated on the shared-operator packaging + is surfaced by P-021's diagnostic. Not a standalone dev change.)
  workspace from the job's creation context (scanner sweep, orchestrator spawn,
  scheduled routine, SSE/WS push fan-out) — never the global.
- **P-022** `done` For MCP/agent tool calls (P-001 class c), carry the launch-time (MCP tools/call dispatch wraps in runWithWorkspaceIfConcretectx.workspaceId so activeWorkspaceId harness resolution, not just the PG GUC resolves the caller's workspace; '*' stays unpinned.)
  harness/workspace scope into the ALS for the duration of the tool call.
- **P-021** `done` Dev assert/log when `activeWorkspaceId()` falls through to the (runInRequestScope + isInRequestScope; activeWorkspaceId warns deduped, NODE_ENV=development/PAPERCUSP_DEBUG_WORKSPACE when it falls to the global inside a request scope. Drives P-020 empirically.)
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

## Phase E — Packaged: one shared operator+PG + per-spawn `HOME` (D-006=Go / D-008)

- **P-050** `todo` Packaged uses **one** shared embedded-PG with RLS; stop the
  per-`HOME` per-workspace PG split and the switch=restart model
  (`main.rs:1016`). One source of truth; multiple workspaces open at once; aligns
  with `harnesses-across-workspaces`. blocked-by: P-051
- **P-051** `todo` **Per-spawn `HOME` (D-008):** every operator-spawned child
  (`claude`/`codex`/`git`/pty/orchestrator agent spawns) gets
  `HOME = workspace_dir(jobWorkspace)` from the job/request workspace, not the
  inherited process `HOME`. Touchpoints: orchestrator spawn-env, `harness-launch`,
  `pty.rs`, the Rust spawn paths in `main.rs`. This is what preserves credential
  isolation under one shared process.
- **P-052** `done` Audit the operator's own direct `os.homedir()` / `~/.claude` / (Audit done + the genuine per-window bug fixed: papercuspRoot 62 consumers resolves via activeWorkspaceId not the global current f937b80d7. Other raw homedir reads are correct: scratch-root + launch-context are deliberate shared/bootstrap; execute-action follows process HOME folds into gated P-051. P-061 guard broadened for parsed.current.)
  `~/.papercusp` reads (non-spawn, request-path) → make them workspace-scoped
  (compute `workspace_dir(ws)` or read workspace-scoped PG), so the shared process
  resolves the right workspace's creds/config. Pairs with the locked
  "config-in-PG" decision.
- **P-053** `todo` Multi-window: the desktop shell can open >1 webview window,
  each pinned to a workspace (the single-window assumption in `papercusp-desktop`
  is replaced). Switching a window's workspace restarts nothing.

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
- **Sidecar/PG fork (D-006)** — RESOLVED → Go (one shared operator+PG; D-008).
  Credential isolation kept via per-spawn `HOME` (no per-workspace standing
  memory). Residual risk is purely execution: every spawn path (incl. `pty.rs`
  + the Rust spawns) must set the child `HOME`, or a child silently reads the
  shared home's creds — P-051's audit + a guard are the net.
- **Auth (D-004)** — header spoofable; RLS prevents leaks (wrong ws → empty) but
  not unauthorized *action*. Gate before any non-loopback exposure.
- **D-007 hard-400 blast radius (new, 2026-05-31)** — unknown header → 400 on
  *every* request, which would brick a window. Safe on desktop (`__PAPERCUSP_WS__`
  is host-injected = always valid). The exposure is a **dev browser** with a stale
  `?ws=<deleted>` and no injection → a 400-storm. Decision to confirm: keep the
  loud 400 (the D-007 choice, correctness-first) vs fall back to default + a
  one-time console warn when the header is unknown. Leaning keep-400 (testing app;
  a bricked window is a clear "your workspace is gone" signal, fixable by the
  injected id), but flag it.
- **ALS context loss** — across async detach points the workspace can silently fall
  back to the global; P-021 assert + P-061 guard are the net (and the chokepoint-
  threading refinement below shrinks the exposure).
- **Membership coupling** — land consistently with `harnesses-across-workspaces`;
  the request workspace is the `(workspace, harness)` disambiguator.
- **Refinement (considered):** rather than 492 ambient reads, thread the workspace
  explicitly through the few **chokepoints** (`getOrgPg`/`routeWithWorkspace`,
  `resolveProject`/`resolvePhasedProject`) with the ALS feeding their default —
  most of explicit-threading's compile-time safety for ~10% of the churn.
