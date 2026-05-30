---
title: Harness finish-line — last 20 routes, _hono/ delete, no-raw-routes lint
slug: harness-finish-line-2026-05-21
created: 2026-05-21
updated: 2026-05-30
status: shipped
---

## Now

**Done 2026-05-21.** A4 batches 36–44 shipped (9 batches; 20 routes off harness.ts + 2 helper carve-outs). `_hono/` directory deleted (A6, `09688a6b`) — host seam relocated to `bin/host-app.ts` + `bin/host-bootstrap.ts`. `no-raw-route-handlers` ESLint rule live (A7, `f019c2df`) with 0 violations across the operator + agent-mcp source trees.

Acceptance: `composed-app-shadowing` 6/6 throughout; rule unit-test passes; no live `_hono` imports remaining.

## Scope

This plan finishes Workstream A from `endpoint-hono-elimination-2026-05-21.md`:

- **A4 batches 36–44** — the last 20 routes off `_hono/harness.ts`.
- **A6** — delete `_hono/harness.ts` + relocate `_hono/app.ts` to a host seam.
- **A7** — `no-raw-route-handlers` ESLint rule.

Workstream B (auth-tightening) is **out of scope** here — separate plan, sequenced after A.

## Remaining 20 routes (verified 2026-05-21 from `harness.ts` HEAD)

| Cluster | Routes | Shared deps |
|---|---|---|
| **Projects** (top-level, no `:slug`) | `GET /projects/lite`, `GET /projects`, `POST /projects`, `DELETE /projects/:slug` | none |
| **Status** | `GET /:slug/status` | uses `getHarnessStatusFull` (already in `lib/harness-core.ts`) |
| **Agents reads** | `GET /:slug/agents`, `GET /:slug/agents/:runId` | `scanAgentRunsCached` + `syncAgentRunsToPg` (already in `lib/harness-agent-runs.ts` from b35) |
| **SSE streams** | `GET /:slug/agents/:runId/stream`, `GET /streams/active`, `GET /:slug/stream`, `GET /:slug/log/stream` | **`activeStreams` Map + `HARNESS_STREAM_TOTAL_CAP`** — module-scope singleton (globalThis-backed); needs Na carve-out |
| **Log history** | `GET /:slug/log/history` | standalone; reads `run.log.jsonl` + rotated `.N.gz` peers |
| **Spawn** | `POST /:slug/launch`, `POST /:slug/invoke`, `POST /:slug/resume` | **`launchRun` helper** (~80 LOC, spawns TS orchestrator via `nohup`); needs Na carve-out |
| **Template** | `POST /:slug/bootstrap-from-template`, `POST /:slug/save-as-template` | none not already in `lib/` |
| **Promote** | `POST /:slug/promote`, `POST /:slug/promote/:id/confirm`, `POST /:slug/rollback` | `PHASE_ORDER` (local one-liner — inline into first route file) |

Total: 4 + 1 + 2 + 4 + 1 + 3 + 2 + 3 = **20 routes**.

## Batch plan

Verification gate per batch: `composed-app-shadowing` 6/6 BEFORE `git commit`. Helper relocations (Na) verify by running the test once with the legacy `harness.ts` re-importing from the new lib — routes still serve the same handlers, just with the dependency moved.

### Batch 36 (Na) — `lib/harness-active-streams.ts`

- Move the `StreamToken` type, `activeStreams` Map (incl. its `globalThis as any` re-attachment for HMR stability), and `HARNESS_STREAM_TOTAL_CAP` constant out of `harness.ts:855–863`.
- `harness.ts` re-imports both for the 4 routes still on it. No route motion.
- Acceptance: `composed-app-shadowing` 6/6; the 4 SSE routes still serve via `_hono` (verified with one curl smoke per route).

### Batch 37 — agents-reads + `/streams/active`

- 3 routes: `GET /:slug/agents`, `GET /:slug/agents/:runId`, `GET /streams/active`.
- New file: `routes/harness/agents.ts` (already exists from a stale draft per `git status` — verify-or-overwrite as fresh).
- `/streams/active` is the simplest consumer of the new `lib/harness-active-streams.ts` — good first user.
- Acceptance: `composed-app-shadowing` 6/6; route literal `(GET, /harness/streams/active)` registers once.

### Batch 38 — SSE streams cluster

- 3 routes: `GET /:slug/agents/:runId/stream`, `GET /:slug/stream`, `GET /:slug/log/stream`.
- All three follow the established `sseResponse({ signal, heartbeatMs, setup })` pattern + activeStreams-cap + per-IP eviction. Faithful 1:1 ports.
- File: `routes/harness/streams.ts` (or split if >400 LOC after diff).
- Acceptance: `composed-app-shadowing` 6/6; one EventSource smoke per route at the desktop console to verify live SSE delivery (UI smoke is mandatory for SSE — `composed-app-shadowing` only probes request shape, not stream emission).

### Batch 39 — status + log-history

- 2 routes: `GET /:slug/status`, `GET /:slug/log/history`.
- Standalone reads, grouped purely for batch size.
- Files: `routes/harness/status.ts`, `routes/harness/log-history.ts`.
- Acceptance: `composed-app-shadowing` 6/6.

### Batch 40 (Na) — `lib/harness-launch.ts`

- Move `launchRun(project, extra?)` and its 3 private helpers (`tsxBin`, `harnessPackageDir` if not already in lib, the encrypted-search-keys env-build call) out of `harness.ts:96–144`.
- Keep `invokeScoperBackground` (already moved in b29) and `launchRun` co-located — they're sibling spawn helpers.
- `harness.ts` re-imports for the 3 routes still on it. No route motion.
- Acceptance: `composed-app-shadowing` 6/6.

### Batch 41 — spawn cluster

- 3 routes: `POST /:slug/launch`, `POST /:slug/invoke`, `POST /:slug/resume`.
- All call `launchRun`. `/invoke` additionally posts to the spawn-mcp invoke endpoint; `/resume` is the deferred route from batch 21 (pause/unpause/stop shipped without it because it needed `launchRun`).
- File: `routes/harness/spawn.ts`.
- Acceptance: `composed-app-shadowing` 6/6; one POST smoke per route to verify a non-trivial subprocess actually starts (route is meaningless if it returns 200 but the orchestrator never spawns).

### Batch 42 — template cluster

- 2 routes: `POST /:slug/bootstrap-from-template`, `POST /:slug/save-as-template`.
- These are the heaviest remaining handlers (template materialization + tarball ops). Verify their non-trivial paths still work — the existing marketplace `/templates` GET (already migrated in b5) is read-only and doesn't exercise these.
- File: `routes/harness/templates.ts`.
- Acceptance: `composed-app-shadowing` 6/6; one save-as-template + one bootstrap-from-template smoke against a real harness slug to verify on-disk side effects.

### Batch 43 — promote cluster

- 3 routes: `POST /:slug/promote`, `POST /:slug/promote/:id/confirm`, `POST /:slug/rollback`.
- `PHASE_ORDER = [...ALL_PHASES]` inlines into the route file (single one-liner; no other consumer remains in harness.ts after this batch).
- These manipulate phased-worktree state — verify a staging→testing promotion completes and a rollback restores the previous SHA.
- File: `routes/harness/promote.ts`.
- Acceptance: `composed-app-shadowing` 6/6; smoke a real staging→testing promote against the operator's own harness slug.

### Batch 44 — top-level projects cluster

- 4 routes: `GET /projects/lite`, `GET /projects`, `POST /projects`, `DELETE /projects/:slug`.
- Top-level (no `:slug` prefix) — last because the path shape differs from the rest and they touch the harness registry (PG-canonical via `lib/harness-registry`, already imported).
- File: `routes/harness/projects.ts`.
- Acceptance: `composed-app-shadowing` 6/6; one create + one delete smoke against a throwaway slug to verify PG-side effects.

After batch 44: `_hono/harness.ts` is empty of route declarations. Drop the `app.route('/harness', harness)` line in `_hono/app.ts`, then **A6**.

## A6 — delete `_hono/`

After batch 44 the `_hono/` directory contains:

| File | Disposition |
|---|---|
| `app.ts` (108 LOC) | host seam — `cors`/`compress` middleware + the Hono app instance. **Move to `bin/host-app.ts`** (sibling to `bin/host-handler.ts`); rename imports. |
| `bootstrap.ts` (112 LOC) | runtime startup hook (not a router). Move to `lib/bootstrap.ts` or `bin/bootstrap.ts` (audit the importer to pick). |
| `harness.ts` | **delete** (empty). |
| `BOUNDARY.md`, `execute-action.contract.md` | architectural docs. Move to `apps/operator/docs/internal/` or `apps/operator-docs/src/content/docs/spec/`. |
| `dock-layouts.integration.test.ts` | integration test for the relocated `dock-layouts` routes. Move alongside other `endpoint-route/__tests__/`. |

Steps:

1. Move/rename each file per the table above using `git mv` (preserve history).
2. Repoint every import — `_hono/app` is the most common; ~50–80 sites likely.
3. `rm -rf apps/operator/app/api/_hono/`.
4. Acceptance: `git grep "_hono"` returns zero hits outside the rename-tracking commit message; `tsc` clean; `composed-app-shadowing` 6/6; one full `npm run dev` + browser smoke.

## A7 — `no-raw-route-handlers` ESLint rule

A custom ESLint rule blocking raw Hono route registration outside the relocated host seam. Regression guard.

- **Rule logic**: error on `app.get(...)` / `app.post(...)` / `app.put(...)` / `app.patch(...)` / `app.delete(...)` / `app.use(...)` / `new Hono(...)` outside an allowlist of files.
- **Allowlist**: `bin/host-app.ts` (the relocated `_hono/app.ts`) and any third-party Hono-using packages (e.g., the agent-mcp HTTP projection if it still uses Hono — audit at land time).
- **Fixture**: a deliberate raw `app.get(...)` added to a test file under `__tests__/eslint-fixtures/` to verify the rule fires.
- **Acceptance**: `eslint .` exits 0; the fixture's `.lint.expected.json` confirms exactly one violation at the expected line/column.

## Risks

- **R1 — SSE batch (38) regressions are invisible to `composed-app-shadowing`.** The shadowing test asserts request/response shape, not stream lifetime or heartbeat. Mitigation: per-route EventSource smoke against a running desktop dev server is mandatory; do not commit batch 38 off `composed-app-shadowing` alone.
- **R2 — `launchRun` subprocess side effects (41).** A route that returns `{ ok: true }` without actually spawning is silently broken. Mitigation: post-batch, `pgrep -af papercusp-orchestrator` after a launch smoke; expect a fresh PID.
- **R3 — template + promote side effects (42, 43).** These touch on-disk worktrees and the harness registry. Mitigation: smokes target a throwaway slug; a `git status` in the throwaway worktree afterwards confirms the expected ref change.
- **R4 — A6 import rename blast radius.** `_hono/app` is the import path for `cors`/`compress`/the Hono singleton across many files. Mitigation: `git grep -l "_hono/app"` enumerates all sites; rename via sed; verify with one `tsc`.
- **R5 — Concurrent agents in the same checkout.** Standard procedure: `git status --short` before each commit; commit with explicit `--only` pathspecs; never package other agents' WIP.

## Sequencing

```
b36 (Na)  activeStreams → lib                  ─┐
b37       agents-reads + /streams/active        │
b38       SSE streams (3) ─ depends on b36      │
b39       status + log-history                  │  Workstream A4 tail
b40 (Na)  launchRun → lib                       │  ~6 sessions @ 1–2 batches/session
b41       spawn cluster (3) ─ depends on b40    │
b42       template cluster (2)                  │
b43       promote cluster (3)                   │
b44       top-level projects (4)               ─┘
A6        delete _hono/ + relocate app.ts
A7        no-raw-route-handlers lint
```

Each batch: one commit, explicit `--only` pathspecs, plan-doc marker amended in a follow-on `docs(plans):` commit if multiple batches ship in one session.

## Acceptance for the whole plan

- `git ls-files apps/operator/app/api/_hono/` returns empty.
- `git grep -nE "^(app|harness)\.(get|post|put|patch|delete|use)\(" apps/operator/ packages/agent-mcp/` returns only the allowlisted host-seam file (`bin/host-app.ts`).
- `composed-app-shadowing` 6/6.
- Operator dev server boots and the `/harness` UI's golden paths (list, open, launch, promote, rollback, save-as-template) all work.
- `eslint .` exits 0 with the `no-raw-route-handlers` rule active.
- Plan doc `endpoint-hono-elimination-2026-05-21.md` marked `status: done` (or its A6/A7 sub-tasks marked done if Workstream B is still outstanding).

## Items

- P-001 — `[x]` Batch 36 (Na): `activeStreams` → `lib/harness-active-streams.ts` (`c42a6dfd`).
- P-002 — `[x]` Batch 37: agents reads + `/streams/active` (`d1aae41b`).
- P-003 — `[x]` Batch 38: SSE streams cluster (`89a90c31`).
- P-004 — `[x]` Batch 39: status + log/history (`6c3b7a5a`).
- P-005 — `[x]` Batch 40 (Na): `launchRun` → `lib/harness-launch.ts` (`a417be6f`).
- P-006 — `[x]` Batch 41: spawn cluster — launch/invoke/resume (`03dfd040`).
- P-007 — `[x]` Batch 42: bootstrap-from-template + drop save-as-template shadow (`391e464c`).
- P-008 — `[x]` Batch 43: promote/confirm/rollback (`202ee289`).
- P-009 — `[x]` Batch 44: top-level `/projects/*` cluster + drop `app.route('/harness', harness)` mount (`52440c98`).
- P-010 — `[x]` A6: relocated host seam to `bin/host-app.ts` + `bin/host-bootstrap.ts`; auxiliary files to `docs/host/` + `lib/endpoint-route/__tests__/`; `_hono/` deleted (`09688a6b`).
- P-011 — `[x]` A7: `no-raw-route-handlers` ESLint rule + unit test + fixture (`f019c2df`).
