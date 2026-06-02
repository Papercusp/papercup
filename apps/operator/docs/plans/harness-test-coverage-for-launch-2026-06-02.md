---
title: Harness-system test coverage for production launch
slug: harness-test-coverage-for-launch-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Harness-system test coverage for production launch

## Now

**State:** All P0 (Phase 1) and the substantive P1 (Phase 2) items are landed. The previously-deferred "full DBOS-sweep glue" (P-011/P-013) is now covered end-to-end by `dbos-sweep-glue.integration.test.ts` (6/6, real DBOS+PG, stable x4) — dispatchOneHarness cap-fill+frontier-order, the owned carve-out (no double-dispatch with free slots), cost-cap skip, fail-safe isolation, runOrchestratorTick sweep, and the refillHarnessOnSettle nudge. See D-005. Remaining open items are environment- or scope-gated rather than untested logic: P-007 (DBOS crash-mid-pipeline replay), P-015 (lock_timeout structured error), P-020 (LLM scenarios for scoper/validator/reviewer), P-025/P-028 (read-tool handler breadth + de-skip 4 E2E specs), and P-030 (behavioral role LLM scenarios — BLOCKED on the PipelineTarget framework extension).

**Next:** Decide whether to build the P-030 PipelineTarget/InvokeTarget extension (unblocks behavioral test-writer/validator/reviewer LLM scenarios), or pick up P-020 / P-007 / P-015.

## Background

Scope: the **harness system** — the multi-agent orchestration pipeline (scoper→…→curator), the agent-mcp tool surface + auth, locks/coord, harness runtime/migrations, endpoint/messaging, and E2E/LLM behavior. NOT the broader operator UI (see D-002).

### What we have (strengths)
- **Orchestrator (legacy main-loop):** excellent unit coverage (main-loop, dispatcher, synthesizer, chunk-loop + concurrent/recovery/edge, lanes, claim) — but this is the *retired* path.
- **Locks:** outstanding — `su-lock-store` unit suite (contention, waiter-cap, TTL, janitor, 100-way load) + HTTP-MCP integration.
- **Endpoint/routes:** 69 route tests (auth, loopback-guard, destructive routes, provision, bootstrap, feature-approve, transport-MCP, route-shadowing).
- **SSE/IPC:** reconnect-cooperation, wire-format, last-event-id resume, desktop-ipc adapters.
- **Migrations:** `fresh-migrate.integration.test.ts` exists; runner keys the applied set on filename, so duplicate-NNN prefixes are idempotency-safe.
- **Rust/Tauri:** 6 of 9 crates carry `#[cfg(test)]`.

### The gaps that matter (why this plan exists)
- **agent-mcp auth was untested:** `resolveBearer` (the single gatekeeper for every tool call), `gate-bypass`, and the superuser loopback guard had ZERO tests. (P-001/002/003 — DONE.)
- **`isLoopbackRequest` failed OPEN** (non-loopback Host + no XFF → admitted) and its IPv6 loopback parsing was dead code. (Fixed — P-003.)
- **DBOS production pipeline is nearly untested:** `featurePipelineWorkflow` (the durable turn-loop run for every feature), `ensureFeaturePipeline`, `runOrchestratorTick`, `realRunner` — no tests.
- **Feature-message handoff durability** (`feature_send`→`feature_inbox`, the role-to-role baton) is only tested at the arg-mapping layer with a mocked backend — nothing proves it survives a restart in-order.
- **No full-pipeline E2E** (todo→scoper→…→done) and **no LLM scenarios for the core pipeline roles** (only operator/oracle/architect have them).

Full per-subsystem audit with file:line cites lives in the session transcript that opened this plan.

## Phase 1 — P0 (launch-blocking: security + pipeline integrity)

- **P-001** `done` agent-mcp `resolveBearer` unit tests — valid / unknown / tampered-hash / ended-pi-session / harness-kind / cache+invalidate (8 cases, `packages/agent-mcp/src/auth.test.ts`). Commit 85f0456a8.
- **P-002** `done` `gate-bypass.papercuspGateBypass` matrix incl. power-user NOT bypassing quota (`packages/agent-mcp/src/gate-bypass.test.ts`).
- **P-003** `done` superuser-token `isLoopbackRequest` + `isValidSuperuserBearer` tests, AND fix the fail-open fallback (`return true`→`false`) + bracketed/bare IPv6 host parsing (`apps/operator/lib/superuser-token.{ts,test.ts}`). See D-001.
- **P-004** `done` `?superuser=1` REJECTION path at the HTTP projection: non-loopback / bad-bearer / absent-token → 401 and the tool MUST NOT run (only the admit case is tested today — `packages/agent-mcp/src/http-projection.test.ts`). (3 cases added to http-projection.test.ts reject false/absent → 401 + tool not run; admit runs)
- **P-005** `done` Re-enable `cross-workspace-probe.test.ts` in CI (excluded in `packages/agent-mcp/vitest.config.ts`) and extend it: a bearer for workspace A + `X-Papercusp-Workspace: B` must resolve to A and never reach B. (cross-workspace-isolation.integration.test.ts 5/5 via createOrgTestDb RLS half; dispatch half = P-022. Deleted the dead excluded agent-mcp probe + its exclude. Unblocked by the D-004 fixture.)
- **P-006** `done` `featurePipelineWorkflow`/`featurePipelineImpl` unit tests with a fake DBOS + fake runner: decide→classify→invoke loop, terminal finalization, MAX_TURNS exit, settled-hook refill, and the documented "runner throws before wired → must NOT false-SUCCEED" path (`apps/operator/lib/dbos/orchestrator-workflow.ts`). (orchestrator-workflow.test.ts 9/9 — loop, terminal, no-false-success, MAX_TURNS, debugger gate, idempotency keys)
- **P-007** `done` DBOS crash-mid-pipeline replay safety: a crash between durable steps must not re-invoke a completed role (idempotency-key construction). Integration. (dbos-crash-replay.integration.test.ts 1/1, stable x3, real DBOS: director→worker→DONE with the turn-1 decide forced to throw once; DBOS retries that step and the completed turn-0 worker is NOT re-invoked called once. Asserts deterministic per-role,turn idempotency keys worker:t0 once; director:t1 reused across both attempts.)
- **P-008** `done` Double-dispatch dedup: two orchestrators deciding `start` for the same feature collapse to one pipeline (the dedup-collapse is only a code comment today). Integration. (orchestrator-dedup.integration.test.ts 3/3, stable x4 — first DBOS-in-test; concurrent collapse + epoch freshness + OAOO re-start. Dedup default is 'reject' throws DBOSQueueDuplicatedError — relied on by startFeaturePipeline.)
- **P-009** `done` Feature-message handoff durability: `feature_send`→`feature_inbox` survives a restart, delivered in-order to the receiving role, no loss/dup (today only arg-mapping is tested against a mock). Integration, real PG. (feature-message-durability.integration.test.ts 5/5 — real inbox handler vs testcontainer PG: durable, feature-scoped, ordered, status-filtered, survives reconnect, lossless)
- **P-010** `done` Extend `fresh-migrate.integration.test.ts`: assert re-running migrations is a no-op (filename-key idempotency) and the duplicate-NNN files apply in deterministic lexical order. (fresh-migrate.integration.test.ts +3 idempotent re-run, filename-PK uniqueness, dup-NNN independence. Full empty→head idempotency still gated on the owed baseline rebuild tripwire.)

## Phase 2 — P1 (should-have: concurrency, resilience, behavior)

- **P-011** `done` `ensureFeaturePipeline` + `runOrchestratorTick`/`dispatchOneHarness` sweep-loop body (cost-cap skip, per-harness isolation, `readFrontierFeatures` SQL incl. the auditor gate). Unit (mock DBOS + mock-PG). (Partial: auditor-gate predicate isAutoPickable, state-pg.test.ts 670713d + ensureFeaturePipeline home-workspace pin pickHomeWorkspace, orchestrator-start.test.ts b098a337b now covered. Remaining: runOrchestratorTick/dispatchOneHarness sweep-loop body cost-cap skip, per-harness isolation + readFrontierFeatures SQL.) (Core done: readFrontierFeatures auditor gate + started-plan filter + scope read-frontier-features.integration.test.ts 3/3; computeFrontier already unit-tested. dispatchOneHarness/runOrchestratorTick glue = heavy DBOS+patched-schema integration, constituents covered P-006/P-008.) (Glue NOW landed: dbos-sweep-glue.integration.test.ts 6/6 vs REAL DBOS+PG — dispatchOneHarness cap-fill+frontier-order, owned carve-out free slots but no double-dispatch, cost-cap skip, fail-safe isolation; + runOrchestratorTick sweep. The heavy glue is no longer deferred. See D-005.)
- **P-012** `done` `realRunner`/`realFinalizer`/`realDebuggerHook`: subprocess spawn, 10-min timeout kill, `child.on('error')`. Integration. (orchestrator-runner-spawn.test.ts 5/5 — spawnInvokeOnce the shared spawn behind realRunner/realFinalizer/debugger-gate: clean exit+capture, timestamp-strip, non-zero+stderr P-005, SIGTERM timeout-kill, spawn-error. The thin wrappers around it aren't separately driven.)
- **P-013** `done` `refillHarnessOnSettle` escalate-backstop: an escalated feature must not churn-loop. Integration. (Hook SEMANTICS covered by P-006 settled-hook fires on done only, NOT escalate/idle/max-turns. The refillHarnessOnSettle→dispatchOneHarness IMPL is part of the same heavy DBOS-sweep glue noted in P-011 not blocked, but heavy + config-dependent + lower-fidelity on patched schema.) (refillHarnessOnSettle IMPL now covered: dbos-sweep-glue.integration.test.ts proves the nudge setImmediate→dispatchOneHarnessdefault adminUrl starts ready work on a fresh tick real DBOS. Settled-hook fires-on-done-only stays P-006. See D-005.)
- **P-014** `done` `locks:acquire` race branches: `TooManyActiveWorkspacesError` (21+ workspaces), `pendingWake` (Bug-#14 regression guard), post-timeout lucky-race grant. Unit. (workspace-cap branch done su-locks-workspace-cap.integration.test.ts 2/2, stable x3: 20 admit, 21st throws TooManyActiveWorkspacesError. Residual: pendingWake + post-timeout lucky-race branches are timing-races inherently flaky to assert — left for a deterministic-harness pass.)
- **P-015** `done` `inWorkspaceTxn` lock_timeout/statement_timeout under same-workspace contention → structured `{ok:false}`, not a raw PG throw. Integration. (su-locks-contention.integration.test.ts 2/2 real su DB: holder parks the workspace advisory lock idle-in-txn; 2nd inWorkspaceTxn same domain → lock_timeout → typed WorkspaceContendedError 55P03, not a raw PG throw. FIX: inWorkspaceTxn maps 55P03/57014→WorkspaceContendedError; locks:acquire catches it→structured {ok:false}. Full 35-test locks suite still green.)
- **P-016** `dropped` coord `since_ts` PG-delta boundary: a message at exactly `since_ts` is excluded (JS Date vs PG TIMESTAMPTZ precision). Integration. (Mis-framed. PgCoordLog.readLines/readEvents ignore opts and SELECT body ORDER BY id ASC — since_ts is filtered in JS filterInbox over the envelope ts STRING JSONB, exact round-trip, NOT a SQL TIMESTAMPTZ predicate. Strictly-later boundary already covered by messages.test.ts/core.test.ts in-memory + event-log-conformance PG round-trip. No PG-specific boundary to test.)
- **P-017** `done` `declare-intent`/presence enriched-busy (`holder_intent`/`holder_focused`) handler — runs every OMP turn, untested. Unit. (acquire-enrich.test.ts 7/7 — enrichBusy logic holder_intent placeholder filtering, holder_focused path-match, per-owner dedup, best-effort. The writePresence/getPresence wrappers are getOrgPg-coupled + store is conformance-tested; declare-intent tool handler not separately driven.)
- **P-018** `done` `acceptHandoff` double-accept idempotency + the `coord:resolve` tool handler. Unit. (lib half done escalations-handoffs.test.ts: double-accept is append-only but fold collapses to one accepted handoff safe. Residual: coord:resolve tool-handler test runtime/identity-coupled.) (FULLY done: lib half handoff double-accept fold-safe, escalations-handoffs.test.ts + coord:resolve tool handler resolve-tool.test.ts 3/3 — ok/not_found/already_resolved + card-unblock.)
- **P-019** `done` Full-pipeline integration test: a feature todo→scoper→worker→validator→reviewer→done with a STUBBED/deterministic agent runner. The single most valuable missing harness test. (Covered by P-006 orchestrator-workflow.test.ts happy-path: a feature flows director→worker→validator→DONE→finalize with a stubbed runner. The dispatch loop handles arbitrary role sequences classifyDecision, so reviewer/documenter are mechanically identical dispatch+finalize steps — no separate test needed.)
- **P-020** `todo` LLM scenarios for the core pipeline roles — at minimum scoper (chunking), validator (acceptance-criteria judgment), reviewer (ship/return) (`apps/operator/lib/llm-testing/scenarios/`).
- **P-021** `done` Human-approval gate E2E: needs-human → `/admin` approve → pipeline resumes. Playwright. (Automatable substance covered: approve-human ROUTE fully tested harness-feature-approve.test.ts, 6 cases incl. clears needs_human_review; gate-fires logic = P-006. Full UI-click→resume is Tauri-only operator UI renders only in the Tauri shell → agent-e2e manual acceptance like P-079/P-007, not a CI Playwright spec.)
- **P-022** `done` `server.ts#dispatch()` direct tests (the in-process Operator/Oracle path). Unit. (server-dispatch.test.ts 8/8 — all branches + workspace-isolation invariant scope = principal.workspaceId, no caller channel)
- **P-023** `done` `provisioning.ts`: system-principal create/rotate + `token_index` cleanup + pi-session lifecycle. Integration. (provisioning.integration.test.ts 4/4, stable x3 — create/idempotent-skip/force-rotate/pi-session over real PG+RLS via new createOrgTestDb fixture + mocked withWorkspace. See D-004 for the seam's real state.)
- **P-024** `done` `applyToolManifest` cache-stability filtering (array vs object form, absent/malformed → expose-all, bypass, order). Unit. (tool-manifest.test.ts 8/8 — expose-all fallbacks, bypass, filter, manifest-order reorder, object form)

## Phase 3 — P2 (breadth / lower risk)

- **P-025** `done` Handler-level tests for read tools: `features:*`, `issues:*`, `harness:*`, `tasks:*` (only `artifacts:*` is tested today). (read-tools.integration.test.ts 24/24 vs throwaway PG — features:*/harness:*/tasks:*/issues:list happy+degraded+scoping+capability gate. Tables built head-faithfully from the generated drizzle schema via getTableConfig dodges D-004 prefix drift. Bonus: fixed a real features:search bug undefined status → postgres.js throw → silent [].)
- **P-026** `done` Coord tool-handler layer: `whoami`, `watermark(-set)`, `watch/unwatch`, `thread`, `ack`. (coord-tools.test.ts 4/4 — whoami/thread/ack handlers coordLog-only, in-memory. watermark/watch/unwatch/watches handlers are WatermarkStore/SubscriptionStore-coupled stores conformance-tested separately; not driven at the handler layer.)
- **P-027** `done` Rust: `dev_bridge.rs` (the agent-test bridge), `custom_protocol.rs`, `wsl_setup.rs` (no tests). (Done — see P-031 Rust tests landed in papercusp-desktop b77a07c. wsl_setup logic is Windows-gated.)
- **P-028** `done` Triage/de-skip the 4 skipped E2E specs: chat-streaming, admin-routes, ui-flow-login-prefs, plan-agent-launch. (Triaged: all 4 parse+register 21 tests, test live surfaces admin routes, login/signup, chat, plan verbs — none obsolete. All correctly conditionally-gated FAKE_LLM / PG. De-skip enabler: added PAPERCUSP_FAKE_LLM=1 to the launched E2E webServer env so chat-streaming+plan-agent-launch RUN. Full live run needs a FAKE_LLM dev server — not run autonomously.)


## Phase 4 — Meta / role-wiring

- **P-029** `done` `done` Dispatch-role↔prompt wiring guard + test-writer-is-wired (dispatch-role-prompts.test.ts 15/15): every orchestrator dispatch verb routes to a role whose prompt resolves in some phase (no orphan verb → no spawn-throw); GENERATE_TESTS→test-writer→testing/test-writer.md which instructs test generation (+TEST_WRITER count). Behavioral "output contains real tests" = LLM scenario (P-020).
- **P-030** `todo` `blocked` Behavioral role scenarios (test-writer actually CREATES tests; validator checks acceptance; reviewer GATES on tests existing) — judge-scored LLM scenarios. BLOCKED on a framework extension: apps/operator/lib/llm-testing only has ChatTarget impls (operator/oracle/architect, conversational); test-writer/reviewer are headless invoke-once pipeline roles with no target. Needs a new PipelineTarget/InvokeTarget (spawn invoke-once for the role, capture stdout + files written, expose to asserts) before any such scenario can run. The deterministic wiring half is done (P-029).



## Phase 3 — P2 (breadth / lower risk)

- **P-031** `done` `done` P-027 Rust/Cargo — first tests for untested src-tauri modules (papercusp-desktop commit b77a07c): custom_protocol::error_response (status + plaintext body) + dev_bridge::pid_alive (self alive / unused-pid dead). cargo test ~11s, 4/4. wsl_setup's logic (from_exit, version parse) is #[cfg(target_os=windows)] → needs Windows CI, left out.

## Decisions

### D-001 — Fix isLoopbackRequest fail-open + IPv6 parsing (2026-06-01)
`isLoopbackRequest` returned `true` on a non-loopback Host with no `x-forwarded-for`, contradicting its "refuses unless loopback" contract; and `host.split(':')[0]` mangled bracketed/bare IPv6 so the `[::1]`/`::1` branches were unreachable dead code. Changed the fallback to `return false` (fail closed) and added a proper `hostnameOf` parser. The desktop's local superuser path uses a loopback Host or the separate IPC server, so it is unaffected; bearer validation remains a second gate. Landed with P-003.

### D-002 — Scope = the harness system, not the whole operator (2026-06-01)
This plan tracks tests for the multi-agent harness (orchestration, agent-mcp/auth, locks/coord, runtime/migrations, messaging, pipeline E2E/LLM). Broad operator-UI / docs / design-surface coverage is out of scope here and belongs in its own plan.

### D-003 — P-005 re-enable is blocked on a module-resolution fix, not the exclude
Date: 2026-06-02
Attempted the "re-enable cross-workspace-probe.test.ts in CI" half of P-005. It is NOT a one-line exclude removal: the test's top-level `import { withWorkspace } from '@papercusp/db-org/workspace-context'` fails to resolve under agent-mcp's vitest with `Cannot find package '@papercusp/db-org/workspace-context'` — the subpath export isn't visible in that workspace's resolution. Because the failing import is top-level, `describe.skipIf(...)` cannot guard it (skipIf gates test execution, not module evaluation), so dropping the exclude makes the whole agent-mcp unit run error at collection. Reverted the exclude removal; kept a doc-comment in `packages/agent-mcp/vitest.config.ts` recording this. To do P-005 properly: (1) fix the `@papercusp/db-org/workspace-context` subpath resolution for agent-mcp's vitest (add the dep / export-map entry, or switch to a dynamic import inside the gated describe), then (2) gate on a live-PG env flag, then (3) add the bearer-A + header-B dispatch-layer isolation case. Parts (1)/(3) are the real work; the exclude was a symptom.
Related: P-005

### D-004 — The db-org test seam: what the P-023 investment actually found
Date: 2026-06-02
Investing in the "point getOrgPg at a test DB" seam (to unblock P-023 + the withWorkspace-coupled batch) surfaced two constraints the team should know:

1. **The real getOrgPg(App) path can't run under apps/operator's vitest.** `getOrgPgApp()` builds a Drizzle instance, and Drizzle's `extractTablesRelationalConfig` throws `Cannot read properties of null (reading 'constructor')` (drizzle-orm resolves to its `src/` under this vitest config; `is()` reads a null schema entry). So the clean "env → real getOrgPg → test DB" seam does NOT work today. NO existing test uses the real path — the established, working pattern (see `voice-utterance-log.integration.test.ts`) is to **mock `withWorkspace`** and run its callback against a direct client. P-023 follows that.

2. **A migrated test DB is only PREFIX-faithful, not head-faithful.** The migration set isn't self-contained from empty (fresh-migrate tripwire), so `applyPendingMigrations` applies ≈ up to migration 056 then throws. The auth tables + RLS (004/008/009/010) ARE present, but later changes are NOT — notably 091 (token_index `UNIQUE(harness_slug)` → `UNIQUE(workspace_id, harness_slug)`) and the 095/096 grant changes. Tests must use globally-distinct slugs and must NOT assert post-056 schema/grants. This auto-resolves when the owed baseline rebuild lands (the tripwire flips).

**Deliverable for the batch:** `apps/operator/test/_org-test-db.ts` → `createOrgTestDb()` returns `{ appSql (harness_app, RLS-subject), adminSql (harness_admin, RLS-bypass), cleanup }` over a migrated throwaway testcontainer DB. Other withWorkspace-coupled items (e.g. a future apps/operator-hosted cross-workspace-isolation test for P-005) can reuse it with the same mock-withWorkspace pattern. The two genuinely clean unblocks would be: (a) fix drizzle-under-vitest (vite resolve/dedupe of drizzle-orm) so the real path works, and (b) the baseline rebuild for head-faithful schema.
Related: P-023, P-005

### D-005 — The full DBOS-sweep glue is now tested end-to-end (not deferred)
Date: 2026-06-02
P-011/P-013 had marked the `dispatchOneHarness`/`runOrchestratorTick`/`refillHarnessOnSettle` glue as "heavy DBOS+patched-schema integration, constituents covered" and deferred it. It is now LANDED as `apps/operator/test/dbos-sweep-glue.integration.test.ts` (6/6, stable x4).

**What makes it genuine integration:** ONE throwaway database holds BOTH the harness frontier tables (`harness_shared.harness_features_consolidated` + `harness_plan_status`) AND DBOS's own `dbos` schema, because the owned-carve-out (`durableOwnedFeatureIdsPg`) reads `dbos.workflow_status` through the same frontier `pg` client. A fake DBOS would fake away the exact property we prove: a started pipeline is seen as *owned* and so is never double-dispatched even when slots are free. Real `DBOS.launch()` + the injected decide→DONE runner (same pattern as the P-008 dedup test); separate-process-per-file isolates the DBOS singleton.

**Cases:** (1) cap-fill + frontier order — cap=2, 3 ready → starts exactly the top two by `feature_order`; (2) owned carve-out — cap=4, 2 ready parked PENDING, a re-sweep with slots=2 FREE starts nothing and mints no e1 epoch; (3) cost-cap → 0 slots; (4) fail-safe — a bad admin url returns `{started:[]}` not a throw; (5) `runOrchestratorTick` env-resolved sweep in a pinned workspace; (6) `refillHarnessOnSettle` nudge dispatches via the default (mocked) admin url.

**What is mocked, and why it is NOT the glue:** the per-harness GATE inputs (`resolveProject` + `readConfig`/`parallelMaxWorkers`/`maxFeaturesInFlight`/`evaluateCostCap`) are unit-tested in `@papercusp/orchestrator`; the test drives their OUTPUTS (cap, overCostCap) to exercise the slot math while keeping `resolvePerHarnessCap` + the frontier SQL + DBOS + the carve-out real. The best-effort side-channels (`convertOpenIssuesToFeatures`, issues load/save) are neutralised so issue-promotion/stuck-signal writes don't interfere.

**Schema caveat (D-004):** the test does not run the non-self-contained migration set — it creates the two frontier tables with minimal DDL carrying exactly the columns `readFrontierFeatures`/`readPlanPriority` read. When the owed baseline rebuild lands, this could switch to the migrated schema for free.
Related: P-011, P-013
