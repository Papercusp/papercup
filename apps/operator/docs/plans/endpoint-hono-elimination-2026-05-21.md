---
title: Endpoint follow-ups — finish _hono elimination + auth-tightening
slug: endpoint-hono-elimination-2026-05-21
status: active
created: 2026-05-21
updated: 2026-05-21
owner: pandawamble@gmail.com
companion-to: [endpoint-unification-2026-05-21, endpoint-route-migration-2026-05-20, host-architecture-2026-05-20-v2]
---

## Now

**State:** The `endpoint-unification-2026-05-21` arc shipped E1–E6 (the `defineRoute`→`defineTool` collapse + the full mobile flag) plus E7-docs, E10, E11, and E13-partial (`coord` + `su-locks` migrated off `_hono`). Its tail — E8/E9/E12/E13-plugins/E14 — was found to be two genuinely separate projects, too large and too risky to fold into that arc. **This plan is that tail, re-scoped from audit.**

**Next:** A4 batches 26…N — continue migrating `_hono/harness.ts` routes to `defineRoute`. **44 routes still in harness.ts** (down from 138); 3509 LOC. Then A6 (delete `_hono/`) and A7 (no-raw-route-handlers ESLint rule).

⚠️ **Before each batch:** `grep -rn "path: '/harness/…'" lib/endpoint-route/routes/` — A1's `cross-harness` migration already claimed `/harness/:slug/{supervisor-notes,inbox,outbox,messages}` + `/harness/all/recent-activity`, and other A1/A2 routers (`projects`, `pty`, `agent-chats`, `experts`) hold `/harness/`-prefixed paths. A legacy route shadowed by an already-migrated literal must be **dropped as dead code, not re-migrated** (`register.ts` throws on duplicate `(method, path)`; `composed-app-shadowing` is the gate).

A1 shipped (`c019a0ff`): 5 small routers. **A2 complete** — `pty` (10, `7be65218`), `agent-chats` (5, `24c532fa`), `experts` (17, `e9b82847`). **A3 complete** (`d336a44e`): 5 still-live `_hono/plugins.ts` routes + dispatcher relocation merged into `routes/plugins/catchall.ts`. **A5 complete** (`b3499031`): `harness-paths.ts` → `lib/`.

**A4 batch 1** (`92857349`): 11 non-route helpers + 3 private deps → `lib/harness-core.ts` (–423 LOC), 3 external importers repointed.
**A4 batch 2** (`baf0e2a2`): `/:slug/spec` GET+PUT + `lib/harness-project-files.ts` carve-out (–178 LOC).
**A4 batch 3** (`7d424f2c`): `/:slug/{issues,summary,logs/run}` 3 reads (–27 LOC).
**A4 batch 4** (`9f50cd2f`): `/:slug/{runs,runs/:name,escalation,competitions}` 4 reads (–99 LOC).
**A4 batch 5** (`6ceb89d9`): standalone `/{identity,needs-human-review,templates,templates/:id/file}` 4 routes (–102 LOC); also fixed a latent unexported-`rowToFeature` bug from batch 1.
**A4 batch 6** (`3c5f1623`): `/projects/:id/{budget,stats}` 2 routes (–81 LOC).
**A4 batch 7** (`852b4b94`): `/:slug/{health,lanes,knowledge,prs}` 5 routes (–66 LOC).

**Cumulative A4: 20 routes migrated, –976 LOC** from `_hono/harness.ts` (7418 → ~6455). **9 of 10 `_hono` routers fully off Hono** as of A3.

Per-batch verification: `composed-app-shadowing` 6/6 after every batch (both mechanism + real `_hono/app.ts` wiring).

# Endpoint follow-ups — finish `_hono` elimination + auth-tightening

## 1. Why this is a separate plan

The unification arc's remaining phases were sized wrong in the original plan:

- "E12 — migrate `_hono/harness.ts`, 135 routes" was only **one** of ten legacy routers. Audit (2026-05-21) found **~199 routes across 10 `_hono` routers** still un-migrated.
- "E9 — auth-tightening, ~30–50 routes" is actually **229 routes today** (every migrated route landed `auth: 'public'`), growing to **~430** once Workstream A migrates the remaining 199.

These are not "continue the arc" items. They are two real projects with different risk profiles — a mechanical-but-large migration, and a security pass requiring per-route judgement. This plan scopes both, plus the leftover `_hono/` deletion and the enforcement lint rule.

## 2. The two workstreams

| | Workstream A — `_hono` elimination | Workstream B — auth-tightening |
|---|---|---|
| **What** | Migrate the 10 remaining `_hono/*` routers (~199 routes) to `defineRoute`; delete `_hono/`; land the `no-raw-route-handlers` lint | Convert every `auth: 'public'` route to an explicit `PrincipalRequirements` posture (or confirm it's genuinely public) |
| **Risk** | Low–medium per route — mechanical port, posture preserved, wire-compatible URLs | **Security-sensitive** — a wrong gate is fail-open (hole) or fail-closed (broken caller) |
| **Verification** | Route serves identically via Hono in-process `app.request()`; `tsc` clean; suites green | Per-route: the intended caller still works AND an unprivileged caller is rejected |
| **Size** | ~199 routes, 10 routers, ~12 batches | ~430 routes, family batches |

**Sequencing: A fully, then B.** Tightening auth on a route that is about to be re-migrated is wasted work. B0 (the audit/categorization — pure analysis, no code) MAY start concurrently; B's conversions wait for A.

E8 (`expose.ipc` for routes) stays **deferred** — the flag is typed but inert and has no consumer. Out of scope here; revisit when a route-over-IPC driver appears.

---

## Workstream A — `_hono` elimination

### Inventory (verified 2026-05-21)

| Router | Routes | LOC | Mounted via | Notes |
|---|---|---|---|---|
| `oracle.ts` | 3 | 146 | `registerOracle(app)` | also exports prompt helpers — keep those |
| `operator-notes.ts` | 2 | 42 | `registerOperatorNotes(harness)` | trivial |
| `dock-layouts.ts` | 6 | 124 | `registerDockLayouts(app)` | — |
| `cross-harness.ts` | 5 | 289 | `registerCrossHarness(harness)` | imported by `routes/marketplace/spawnable.ts` — check exports |
| `projects.ts` | 6 | 203 | `registerProjects(harness)` | — |
| `experts.ts` | 17 | 969 | `registerExperts(harness)` | exports `experts-data` helpers — keep |
| `pty.ts` | 10 | 835 | `registerPty(harness)` | **WS** terminal upgrade — see A2 caveat |
| `agent-chats.ts` | ~5–9 | 437 | `registerAgentChats(harness)` | **SSE** chat streaming |
| `plugins.ts` | 7 | 576 | `app.route('/plugins', plugins)` | **`installPluginApiDispatcher` mutates the sub-app** — see A3 |
| `harness.ts` | 138 | 7418 | `app.route('/harness', harness)` | the big one — see A4; also exports many non-route helpers |
| `bootstrap.ts` | 0 | 112 | `runBootstrap()` | startup hooks — **stays** (not a router) |
| `harness-paths.ts` | 0 | 79 | imported as a lib | helper — **stays / moves to `lib/`** |

**Total route surface: ~199 across 10 routers.**

### A1 — Small routers (oracle, operator-notes, dock-layouts, cross-harness, projects) — ~22 routes — ✅ SHIPPED `c019a0ff`

- ✅ One `routes/<family>/index.ts` module per router (array-export). 22 routes across 5 files.
- ✅ Auth posture preserved verbatim — all `auth: 'public'` (the legacy routers gated none). The `oracle` FLAGS.ORACLE 404-gate middleware became a per-handler `oracleEnabled()` check (`defineRoute` has no per-prefix middleware).
- ✅ 5 `_hono/*.ts` deleted + 5 `register*()` calls removed from `_hono/app.ts`.
- ✅ **Export check done:** `cross-harness.ts`'s `getSpawnableTemplates` (imported by `routes/marketplace/spawnable.ts`) relocated to `lib/spawnable-templates.ts`; importer repointed. `oracle`'s prompt helpers were already in `lib/agent-tools/oracle/prompts.ts` — no move needed.
- ✅ The `/oracle/chat` test block of `_hono/chat-shim-routes.test.ts` migrated to `endpoint-route/__tests__/oracle-chat.test.ts` (4 tests — round-10 close guard, 400-no-messages, 404-flag-off, UUID-runId).
- ✅ Verified: tsc clean; route-shadowing + composed-app green; oracle-chat 4/4; chat-shim (trimmed) 3/3.

### A2 — Mid routers (experts, pty, agent-chats) — ◐ 2/3 SHIPPED

- ✅ **`pty.ts` (10 routes)** → `routes/pty/` (`7be65218`). **Audit corrected the plan:** `pty.ts` has NO WebSocket — terminal output streams over SSE (`/pty/:id/stream`), input over POST. A plain HTTP migration. The prewarm pool moved verbatim from the `registerPty` closure to module scope.
- ✅ **`agent-chats.ts` (5 routes)** → `routes/agent-chats/` (`24c532fa`). The `/messages` SSE stream ports cleanly. The `chat-shim-routes.test.ts` agent-chats block migrated to `agent-chats-messages.test.ts`; that test file is now fully migrated (oracle block went in A1) and deleted.
- ✅ **`experts.ts` (17 routes, 969 LOC)** → split (`e9b82847`): helpers → `lib/experts-core.ts` (`experts-data.ts` repointed), 17 routes → `routes/experts/`. `experts.test.ts` (19-test suite) migrated to `endpoint-route/__tests__/` — **18 of its tests fail on a pre-existing registry-stub drift**, confirmed by running the untouched legacy test at HEAD (fails the same 18). Faithful migration; the stub drift is a separate test-infra bug.

**A2 complete — 8 of 10 `_hono` routers migrated.**

### A3 — `plugins.ts` (7 routes) + relocate the plugin-API dispatcher — ✅ SHIPPED `d336a44e`

- Audit found `routes/plugins/global.ts` + `contributions.ts` had already shadowed 2 of the 7 legacy routes as phase-1 literals — dead code, dropped without re-migration.
- Dispatcher relocation: `installPluginApiDispatcher(plugins): void` (Hono-sub-app mutation) → `dispatchPluginApiRoute(req): Promise<Response|null>` (pure function). `defineRoute` handlers cannot yield via `next()`; the registry-miss path is expressed as a `null` return that `routes/plugins/catchall.ts` checks before falling through to projected-tool dispatch. The two `/plugins/*` paths (apiRoutes registry + projected-tool) merged into a single defineRoute — `register.ts` errors on duplicate `(method, path)` so they couldn't be separate routes.
- 5 still-live legacy routes migrated to `routes/plugins/{list,installed,runtime-status,runtime-invoke-action,runtime-fire-event}.ts`.
- Helpers + their tests relocated: `lib/plugin-catalog.ts` (`listPluginsIn`, `resolveProjectPath`, `HARNESSES_DIR`, `GLOBAL_PLUGINS_DIR`, `PluginManifest` type) — was Avi @ endpoints-migration agent's prior WIP, completed in this commit.
- Fixed a latent `operationId()` bug in `lib/endpoint-route/openapi.ts`: `/plugins` and `/plugins/*` both reduced to `route_GET_plugins` because the trailing-underscore strip ate the wildcard delimiter. Mapped `*` → `wildcard` before the generic non-alphanumeric collapse. Surfaced when this arc added the bare `/plugins` route.
- Deleted `_hono/plugins.ts` (576 LOC) + `_hono/plugins.test.ts`; dropped `app.route('/plugins', plugins)` from `_hono/app.ts`.

### A4 — `harness.ts` (138 routes) — the big one

- **Batch 1 ✅ SHIPPED `92857349`** — 11 non-route helpers + 3 private deps relocated to `lib/harness-core.ts`. `harness.ts` itself re-imports them; 3 external importers (`architect/prompts.ts`, `harness-readers.ts`, `mobile/harnesses.ts`) repointed. Layering violation (`lib/* → _hono/*`) eliminated. –423 LOC from `_hono/harness.ts`. tsc clean; composed-app-shadowing 6/6.
- **Batches 2–12 ✅ SHIPPED** — 37 routes total. Each batch composed-app-shadowing 6/6, one commit, explicit pathspecs:
  - b2 `baf0e2a2` — `/:slug/spec` GET+PUT (2) + `lib/harness-project-files.ts`
  - b3 `7d424f2c` — `/:slug/{issues,summary,logs/run}` (3)
  - b4 `9f50cd2f` — `/:slug/{runs,runs/:name,escalation,competitions}` (4)
  - b5 `6ceb89d9` — standalone `/{identity,needs-human-review,templates,templates/:id/file}` (4)
  - b6 `3c5f1623` — `/projects/:id/{budget,stats}` (2)
  - b7 `852b4b94` — `/:slug/{health,lanes,knowledge,prs}` (5)
  - b8 `c59a936a` — `/:slug/{scoper-result,debug-notes×2,synthesis-notes,diff/working}` (5)
  - b9 `0b484d47` — `/:slug/feature(s)/:id/{lineage,audit,timeline,diff}` (4)
  - b10 `e607a2a1` — `/:slug/orchestrator/adaptive-telemetry` GET+POST+PATCH (3)
  - b11 `ccf35750` — `/:slug/proposals` GET + GET/:id (2)
  - b12 `0a688a6d` — `/:slug/screenshots` GET/POST/DELETE (3)
- **Cumulative: 37 routes off `_hono/harness.ts`; 7418 → 5826 LOC.** New route modules under `lib/endpoint-route/routes/harness/`.
- **Batches 13–16 ✅ SHIPPED** — 23 routes total. Commits: `77620028` (snapshots ×4), `f5913b88` (hooks ×4), `d44865b5` (config-files mcp/claude-settings/env ×6), `bab19fcc`+`d8002408` (skills ×4 + supervisor-notes PUT/append ×2; the duplicate GET was dropped — see warning above). New `lib/harness-project-files.ts` no longer the only carve-out — `scanSnapshots`/`syncSnapshotsToPg` now live in their route file.
- **Cumulative: 60 routes off `_hono/harness.ts`; 7418 → 5294 LOC.**
- **Batches 17–19 ✅ SHIPPED** — 16 routes. Commits: `d08d8b76` (prompts ×4 + dropped dead `NON_CHAT_ROLES`), `ad3bd84b` (brainstorm GET/PUT ×6 — `brainstorm/promote` deferred, needs features/issues helpers), `fbd1a9ab` (orchestrator status/lane/lanes/clear-running + checkpoint request/grant ×6).
- **Cumulative: 76 routes off `_hono/harness.ts`; 7418 → 4818 LOC.**
- **Batches 20–22 ✅ SHIPPED** — 9 routes. Commits: `55c88dc0` (git show/worktrees/log ×3) + `d1aafae1` (fix: batch-20 `sed` left a dangling `/**` because the delete range started 3 lines below the JSDoc — runaway comment silently swallowed pause/unpause/stop; `composed-app-shadowing` missed it since it only probes a few routes), `f407646a` (process-control pause/unpause/stop ×3; resume deferred — needs shared `launchRun`), `cd1aed8c` (architect-reviews ×3).
- **Cumulative: 85 routes off `_hono/harness.ts`; 7418 → 4342 LOC.**
- **Process note (3rd correction):** when sed-deleting a block that opens with a JSDoc, the delete range MUST start at the JSDoc's `/**` line — grep the real comment-start, never eyeball. A dangling `/**` is a *runaway* comment, not a syntax error: it compiles, so `composed-app-shadowing` won't catch it. After any block delete, `grep -nE "^/\\*\\*$"` near the splice or run `tsc` syntax check.
- **Batches 23–24 ✅ SHIPPED** — 5 routes. Commits: `866fdc1f` (Memory-tab memory/memory-file ×3 — new `lib/harness-memory-map.ts` carries `MEMORY_MAP` + helpers + the fail-closed validation IIFE, which now survives harness.ts deletion), `8c13f760` (phases read + setup ×2).
- **Batch 25a ✅ SHIPPED** (`6501c3d1`) — issues-helpers carve-out only (no routes moved). New `lib/harness-issues.ts` owns the 7 helpers shared between the 6 issues routes AND `brainstorm/promote` (target='issue'). Routes + brainstorm/promote re-import from the lib; both keep working unchanged. Split off because the all-in-one (~530-LOC) issues batch repeatedly aborted at this session's edit-budget.
- **Batch 25b ✅ SHIPPED** (`7a8c2799`) — 5 of 6 issues routes migrated (issues-list, POST issues, append-pending, issues/:id/update, triage). `POST /:slug/issues/:id/promote` deferred — depends on `auditFeatureChange` still in harness.ts; ships with the features-mutation cluster. Also fixed an ambient `notifySyncInvalidate` reference (the legacy harness.ts code used it without a static import — caught when porting to the new file).
- **Cumulative: 95 routes off `_hono/harness.ts`; 7418 → 3509 LOC.**
- **Batches 26…N** — 44 routes still pending. Each batch: one commit, explicit pathspecs, per-batch `composed-app-shadowing` parity check (read the result BEFORE committing). Remaining:
  - shared-state agents/streams (`activeStreams`, `scanAgentRuns`), features mutations + `issues/:id/promote` (share `auditFeatureChange` helper — carve out as 26a), proposals accept/reject, `brainstorm/promote`, launch/invoke/resume (`launchRun`/`invokeScoperBackground`), product-review/replan/cleanup, promote/promote-confirm/rollback (share `PHASE_ORDER` + git machinery), archive/restore, save-as-template, supervisor, escalation/resolve, architect/apply, bootstrap-from-template, the `/:slug/tests/*` sub-router.
- **Process lesson:** when an in-place migration is too large for a single turn's edit budget (≳400 LOC across one route file + harness.ts diff), split it: ship the helper relocation alone as batch *Na*, leave routes in place importing from the new lib, then ship the routes themselves as batch *Nb* in a later session.
- Auth posture preserved verbatim per batch.
- Acceptance: per batch — routes serve identically, `tsc` clean, endpoint-route suite green; the `harness` UI smoke-tested at the end of A4.
- `harness.ts` is deleted only once its 138 routes are all gone; the `harness` Hono sub-app declaration drops out of `_hono/app.ts` at the same time.

### A5 — Orphan triage — ✅ SHIPPED `b3499031`

- `harness-paths.ts` → `lib/harness-paths.ts` via `git mv`. 4 importer repoints + 3 test-mock-path repoints. 40/40 affected tests green.
- `bootstrap.ts` deferred to A6 (it's the host startup hook — moves with `app.ts` when the host seam is relocated).
- `dock-layouts.integration.test.ts` + `BOUNDARY.md` + `execute-action.contract.md` similarly deferred to A6.

### A6 — Delete `_hono/`

- After A1–A5, the only files left in `_hono/` are `app.ts` (the Hono app instance + `cors`/`compress` middleware — the host seam) and possibly `bootstrap.ts`.
- Move `app.ts` to a host-appropriate home (`bin/` or a `host/` dir) and delete the now-empty `_hono/` directory. Rename references.
- Acceptance: zero `_hono/` imports outside the relocated `app.ts`; `composed-app-shadowing` test green.

### A7 — `no-raw-route-handlers` ESLint rule

- A custom ESLint rule rejecting raw `app.get/.post/.put/...` and `new Hono()` route registration outside the relocated host seam — the regression guard that keeps routes on `defineRoute`.
- Can only land **after** A1–A6 (until then the rule would fail lint across `_hono/`).
- Acceptance: `eslint` clean; a deliberate raw `app.get` in a test fixture trips the rule.

---

## Workstream B — auth-tightening

### B0 — Audit + categorize (pure analysis — may start anytime)

Every `auth: 'public'` route (229 today, ~430 after Workstream A) is classified into exactly one bucket:

| Bucket | Target posture | Examples |
|---|---|---|
| **genuinely public** | stays `auth: 'public'` | OAuth callbacks (`oauth/*`), `flags/webhook`, `mobile/pair`, `mobile/desktop/mint-pair-token`, `mobile/rest-query`, `mobile/qr.svg` |
| **loopback-tier** | `auth: { trust: ['trusted','verified','unverified-loopback'] }` | desktop-local operator routes — the bulk |
| **verified-user** | `auth: { kind: ['user'], trust: ['verified'] }` | routes that must have a real session |
| **agent/system** | `auth: { kind: ['system','pi'] }` | agent-bearer-only routes |
| **mobile** | `auth: { kind: ['mobile'] }` + `mobile: true` | already done in the unification arc |

Output: a categorization table committed into this plan, and a stub `auth-posture.test.ts` enumerating every route with its bucket + rationale.

### B1…Bn — Convert in family batches

- ~10 routes per batch, one commit each.
- The 29 routes with an **inline** auth check are the priority first batches — there `auth: 'public'` is actively misleading; the conversion just makes the existing in-handler gate declarative and deletes the inline code.
- The 200 with **no** check are the bulk — each needs the B0 bucket decision applied.
- **Per-route verification is mandatory** and is the gate: the intended caller still succeeds, an unprivileged caller is rejected. A batch does not ship on `tsc` + green-suite alone.

### B acceptance

- `git grep "auth: 'public'"` returns only routes in the **genuinely-public** bucket.
- `auth-posture.test.ts` enumerates every route, its posture, and a one-line rationale; it fails CI if a new route lands `auth: 'public'` without a rationale entry.

---

## 3. Risks

- **R1 — `harness.ts` helper exports (A4).** Deleting `harness.ts` before relocating `getHarnessStatusFull` et al. breaks importers (incl. migrated mobile routes). Mitigation: helper-relocation is the *first* batch of A4, with `tsc` as the gate.
- **R2 — the plugin-API dispatcher (A3).** Relocating a runtime-mutated catch-all is the subtlest part of A. Mitigation: A3 gets its own design note; a plugin-supplied route is the acceptance fixture.
- **R3 — pty WebSocket (A2).** The WS upgrade is not a `defineRoute`. Mitigation: split control-routes from the WS handler explicitly; don't force WS into the route model.
- **R4 — auth-tightening fail-open (B).** A route mis-bucketed as loopback-tier when it should be verified-user is a security hole. Mitigation: per-route verification is the batch gate; `auth-posture.test.ts` is the durable check.
- **R5 — concurrent agents.** This repo has multiple agents committing. Every commit uses explicit `--only` pathspecs; `git status --short` before each commit.

## 4. Sequencing summary

```
A1  small routers (~22)            ─┐
A2  mid routers (~34)               │  Workstream A
A3  plugins + dispatcher (7)        │  ~199 routes → defineRoute
A4  harness.ts (138, ~18 batches)   │  then delete _hono/
A5  orphan triage                   │
A6  delete _hono/                    │
A7  no-raw-route-handlers lint      ─┘
B0  audit + categorize (~430)       ─┐  Workstream B
B1…Bn  convert in family batches     │  auth-tightening
B    auth-posture.test.ts gate      ─┘  (after A; B0 may start early)
```

Deferred (not in this plan): E8 `expose.ipc` for routes — no driver.
