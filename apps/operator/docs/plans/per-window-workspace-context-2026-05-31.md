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

**State:** Design plan (not started). Captures the fix for a fragility surfaced
while dogfooding the papercup harness Tests tab: harness data resolves against a
single **process-global active workspace** (`reg.current`), so two desktop
windows on different workspaces collide, and anything that flips `reg.current`
(a workspace switch, or a concurrent agent) silently corrupts a window's data.

**Concrete symptom (2026-05-31):** the papercup harness lives in
`papercusp-workspace`. While `reg.current` was `default` (flipped by concurrent
org-harness work), `GET /api/harness/papercup/testing/domains` could not resolve
papercup → the Tests tab fell back to the generic 6-domain set (and on reload
the `/adv` window flipped to `default`'s `sheets` harness). The window's URL said
`?ws=papercusp-workspace`, but the backend ignored it.

**Next action:** Phase 0 audit — enumerate `activeWorkspaceId()` call sites and
split them into *request-context* vs *background-context*, confirm the desktop
dev-vs-packaged sidecar model, and lock the transport + fallback decisions
(D-001…D-004). Nothing ships until that audit is done.

## Background

### How workspace is resolved today (the single global)

`activeWorkspaceId()` (`apps/operator/lib/workspace-registry.ts`) returns
`readRegistry().current` — a single value read from
`~/.papercusp-workspaces/registry.json` (root resolved via
`PAPERCUSP_WORKSPACES_ROOT`, else `homedir()`; see the insight
`workspaces-root-vs-remapped-home`). That one value drives **two** things:

1. **Harness resolution** — `resolveProject(slug)` (`harness-core.ts`) →
   `loadHarnessRegistry()` → reads the *active workspace's* registry row. A slug
   in a non-active workspace returns `null` ("unknown project").
2. **PG row scoping** — `routeWithWorkspace(fn)` (`route-workspace.ts`) =
   `withWorkspace(activeWorkspaceId(), fn)` → opens a tx with
   `SET LOCAL app.workspace_id = <id>` (`@papercusp/db-org` workspace-context).
   Every workspace-scoped table read/write keys off this.

So *both* "which harness" and "which rows" come from the process-global value.

### What the frontend knows but doesn't send

Each window already knows its workspace: `window.__PAPERCUSP_WS__` is injected
into `index.html`; `getBrowserWorkspaceId()` (`browser-workspace.ts`) reads it
(falling back to `?ws=` then `'default'`). But **requests don't carry it** — the
operator-vite IPC bridge (`window.fetch = ipcFetch`, `window.EventSource =
IpcEventSource`, installed first in `__root.tsx`) forwards to the sidecar without
a workspace, and the sidecar resolves from `reg.current`. The `?ws=` in the URL
is display-only.

### Why it "works" in packaged but not dev

Packaged desktop spawns the operator **sidecar with a per-workspace `HOME`**
(`src-tauri/src/main.rs` — "per-workspace isolation: override HOME so the
sidecar … "), so each active workspace effectively gets its own sidecar +
registry root + `reg.current`. Dev mode shares **one** sidecar
(`papercup-dev-api.service` on `:3070`, `HOME=~`), so all windows + all agents
share one `reg.current` → the flapping. The shipped model leans on
process-per-workspace; that's expensive (a sidecar reboot per switch) and still
doesn't let two workspaces be open at once in one process.

### Goal

A request resolves against the **window that made it**, not the process. A window
on `papercup`/`papercusp-workspace` gets papercup data regardless of what any
other window or agent set globally. `reg.current` keeps meaning only "the default
for new windows / non-request background work" — it stops being authoritative for
request resolution.

### Relationship to other plans

- `harnesses-across-workspaces-2026-05-31` — the **membership** model (a harness
  can belong to multiple workspaces; shared results; workspace-owned config).
  This plan is the **resolution** half: once a harness is in N workspaces, a
  request must say *which* workspace it's acting in. The two must agree on
  `(workspace, harness)` as the scoping key.
- `workspace-localstorage-isolation-2026-05-27` — client-side per-workspace
  storage; complementary (this plan handles the server side).

## Decisions

### D-001 — Transport: a request header, not a query param `[proposed]`

Windows send `x-papercusp-workspace: <id>` on every request, injected by the
operator-vite fetch/EventSource wrapper from `getBrowserWorkspaceId()`.
- **Header > query param:** works uniformly for GET/POST/SSE without rewriting
  every URL or every `fetch()` call site; survives redirects; doesn't pollute
  caches/logs the way a `?ws=` on every route would.
- The endpoint-route layer already normalizes requests; one ingress point reads
  the header.
- *Alternative rejected:* thread `ws` as an explicit param through
  `resolveProject`/`resolvePhasedProject`/every route — correct but touches
  hundreds of call sites and misses PG scoping.

### D-002 — Request-scoped context via AsyncLocalStorage; `activeWorkspaceId()` prefers it `[proposed]`

A Hono middleware populates an `AsyncLocalStorage<{ workspaceId }>` from the
header. `activeWorkspaceId()` becomes
`als.getStore()?.workspaceId ?? readRegistry().current`. This is the linchpin:
`resolveProject` and `routeWithWorkspace` already call `activeWorkspaceId()`, so
**both harness resolution and PG scoping become per-request with ~zero call-site
changes**. The global stays as the fallback for code with no request on the stack.

### D-003 — Background contexts pass workspace explicitly; never silently inherit the global `[proposed]`

Scanner, orchestrator, scheduled jobs, SSE pushers, and any timer have no request
on the stack → no ALS. They must carry an **explicit** workspace decided at job
creation (the workspace the job was queued for), not `reg.current`. Phase B
audits every `activeWorkspaceId()` reachable from a non-request entrypoint.

### D-004 — A header is untrusted input; authz must gate workspace access `[needs-human]`

`x-papercusp-workspace` is client-supplied and spoofable. Today's trust model is
loopback-based (one machine, one user). Before relying on the header in any
multi-tenant / shared-host context, the request principal must be checked against
the workspaces it may access. For the single-user desktop this is low-risk
(loopback only); flag the gap so it isn't forgotten if the host is ever exposed.

### D-005 — Keep `reg.current`; redefine its role `[proposed]`

Do not remove `reg.current`. It remains: the default workspace a *new* window
opens into, and the workspace background jobs use when not told otherwise. We only
stop making it the authority for request-scoped resolution.

## Phase 0 — Audit & lock decisions (no code)

- **P-001** `todo` Enumerate every `activeWorkspaceId()` reader (and
  `routeWithWorkspace`/`withWorkspace` user) and tag each **request-context** (gets
  ALS for free) vs **background-context** (needs explicit workspace, Phase B). Note
  the mangling caveat — count via `rg -c activeWorkspaceId` per file.
- **P-002** `todo` Map the SSE/streaming paths (`/api/zero-harness/sse`,
  voice WS, agent-chat streams): workspace is fixed at connect — confirm the header
  is read once on the upgrade and pinned for the connection's life.
- **P-003** `todo` Confirm the desktop sidecar model precisely (read
  `src-tauri/src/main.rs`): does dev share one sidecar while packaged spawns
  per-workspace? Decide in E whether per-workspace sidecars stay or the header
  subsumes them.
- **P-004** `todo` Lock D-001…D-005 with the owner (esp. D-004 authz).

## Phase A — Request-scoped workspace context (the core)

- **P-010** `todo` Add `AsyncLocalStorage<{ workspaceId }>` in a server-only module
  (`apps/operator/lib/workspace-context-als.ts`); export `runWithWorkspace(id, fn)`
  + `currentRequestWorkspaceId()`.
- **P-011** `todo` Hono host middleware (`bin/hono-host.ts` / `_hono/app.ts`): read
  `x-papercusp-workspace`, validate it's a known workspace id, wrap the handler in
  `runWithWorkspace`. Unknown/missing → leave ALS empty (falls back to global).
- **P-012** `todo` `activeWorkspaceId()` → `currentRequestWorkspaceId() ??
  readRegistry().current`. Single change; everything downstream inherits it.
- **P-013** `todo` Frontend: `ipcFetch` + `IpcEventSource` (operator-vite) inject
  `x-papercusp-workspace` from `getBrowserWorkspaceId()` on every request/upgrade.
- **P-014** `todo` Verify the win: `GET /api/harness/papercup/testing/domains` with
  `x-papercusp-workspace: papercusp-workspace` resolves papercup **while
  `reg.current=default`** (the exact failure from today).

## Phase B — Background-context safety

- **P-020** `todo` For each background reader from P-001, replace the implicit
  global with an explicit workspace threaded from the job's creation context
  (scanner sweep, orchestrator spawn, scheduled routine, SSE push fan-out).
- **P-021** `todo` Add a dev assertion/log when `activeWorkspaceId()` falls through
  to the global *inside* a request (means the header was missing) — catches
  un-instrumented paths.

## Phase C — `/adv` view drives off the window's workspace

- **P-030** `todo` `/adv` active-workspace + active-harness come from the window
  `?ws=` / `__PAPERCUSP_WS__`, not a re-resolve against `reg.current` on load —
  fixes the "window flips to another workspace's harness on reload."
- **P-031** `todo` Workspace switch in one window must not yank other windows
  (each window's `__PAPERCUSP_WS__` is independent); switching updates *this*
  window's URL + (optionally) `reg.current` as the new default, without forcing
  reloads elsewhere.

## Phase D — PG scoping correctness

- **P-040** `todo` Confirm `routeWithWorkspace` (now per-request) sets
  `app.workspace_id` to the request workspace; two concurrent requests on
  different workspaces stay isolated (already true — `SET LOCAL` is per-tx on a
  pooled connection).
- **P-041** `todo` Audit any direct `getOrgPg().sql` (non-`withWorkspace`) reads of
  workspace-scoped tables for missing scoping now that the workspace varies
  per-request.

## Phase E — Desktop model reconciliation

- **P-050** `todo` Decide: with the header in place, does **dev** need anything
  (one sidecar + header = correct), and should **packaged** drop per-workspace
  sidecars in favor of one sidecar + header (cheaper, allows multiple workspaces
  open at once) — or keep per-workspace sidecars and treat the header as a
  no-op/defense-in-depth? Avoid two competing sources of truth.

## Phase F — Tests + regression guard

- **P-060** `todo` Integration test: one host, two simulated windows with different
  `x-papercusp-workspace` headers, assert each gets correctly-scoped harness +
  PG data with no cross-talk.
- **P-061** `todo` Guard: fail if a *request-path* module reads `reg.current`
  directly (bypassing `activeWorkspaceId()`/ALS) — same spirit as the
  `no-server-imports-in-client` guard.

## Risks / open questions

- **Auth (D-004)** — the header is spoofable; safe for loopback desktop, not for a
  shared host. Gate before any exposure.
- **Membership coupling** — must land consistently with
  `harnesses-across-workspaces` (shared results, workspace-owned config): the
  request workspace is exactly the disambiguator a multi-workspace harness needs.
- **Long-lived connections** — SSE/WS pin the workspace at connect; a mid-session
  switch opens a new connection (acceptable).
- **Leakage via missing header** — any request that forgets the header silently
  uses the global; P-021's assertion + P-061's guard are the safety net.
