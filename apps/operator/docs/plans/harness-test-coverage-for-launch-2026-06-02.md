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

**State:** Audit complete (2026-06-01). Mapped existing coverage across the six harness subsystems and identified the production-risk gaps. Three P0 security tests + one fail-open fix already landed this session (P-001/P-002/P-003). The rest are tracked below by priority.

**Next:** pick up Phase 1 (P0) — the auth/isolation + pipeline-durability tests that gate launch. P-004/P-005 (superuser-reject + cross-workspace isolation) and P-006/P-009 (DBOS pipeline + handoff durability) are highest urgency.

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
- **P-007** `todo` DBOS crash-mid-pipeline replay safety: a crash between durable steps must not re-invoke a completed role (idempotency-key construction). Integration.
- **P-008** `done` Double-dispatch dedup: two orchestrators deciding `start` for the same feature collapse to one pipeline (the dedup-collapse is only a code comment today). Integration. (orchestrator-dedup.integration.test.ts 3/3, stable x4 — first DBOS-in-test; concurrent collapse + epoch freshness + OAOO re-start. Dedup default is 'reject' throws DBOSQueueDuplicatedError — relied on by startFeaturePipeline.)
- **P-009** `done` Feature-message handoff durability: `feature_send`→`feature_inbox` survives a restart, delivered in-order to the receiving role, no loss/dup (today only arg-mapping is tested against a mock). Integration, real PG. (feature-message-durability.integration.test.ts 5/5 — real inbox handler vs testcontainer PG: durable, feature-scoped, ordered, status-filtered, survives reconnect, lossless)
- **P-010** `done` Extend `fresh-migrate.integration.test.ts`: assert re-running migrations is a no-op (filename-key idempotency) and the duplicate-NNN files apply in deterministic lexical order. (fresh-migrate.integration.test.ts +3 idempotent re-run, filename-PK uniqueness, dup-NNN independence. Full empty→head idempotency still gated on the owed baseline rebuild tripwire.)

## Phase 2 — P1 (should-have: concurrency, resilience, behavior)

- **P-011** `todo` `ensureFeaturePipeline` + `runOrchestratorTick`/`dispatchOneHarness` sweep-loop body (cost-cap skip, per-harness isolation, `readFrontierFeatures` SQL incl. the auditor gate). Unit (mock DBOS + mock-PG). (Partial: auditor-gate predicate isAutoPickable, state-pg.test.ts 670713d + ensureFeaturePipeline home-workspace pin pickHomeWorkspace, orchestrator-start.test.ts b098a337b now covered. Remaining: runOrchestratorTick/dispatchOneHarness sweep-loop body cost-cap skip, per-harness isolation + readFrontierFeatures SQL.)
- **P-012** `todo` `realRunner`/`realFinalizer`/`realDebuggerHook`: subprocess spawn, 10-min timeout kill, `child.on('error')`. Integration.
- **P-013** `todo` `refillHarnessOnSettle` escalate-backstop: an escalated feature must not churn-loop. Integration.
- **P-014** `todo` `locks:acquire` race branches: `TooManyActiveWorkspacesError` (21+ workspaces), `pendingWake` (Bug-#14 regression guard), post-timeout lucky-race grant. Unit.
- **P-015** `todo` `inWorkspaceTxn` lock_timeout/statement_timeout under same-workspace contention → structured `{ok:false}`, not a raw PG throw. Integration.
- **P-016** `todo` coord `since_ts` PG-delta boundary: a message at exactly `since_ts` is excluded (JS Date vs PG TIMESTAMPTZ precision). Integration.
- **P-017** `todo` `declare-intent`/presence enriched-busy (`holder_intent`/`holder_focused`) handler — runs every OMP turn, untested. Unit.
- **P-018** `done` `acceptHandoff` double-accept idempotency + the `coord:resolve` tool handler. Unit. (lib half done escalations-handoffs.test.ts: double-accept is append-only but fold collapses to one accepted handoff safe. Residual: coord:resolve tool-handler test runtime/identity-coupled.)
- **P-019** `todo` Full-pipeline integration test: a feature todo→scoper→worker→validator→reviewer→done with a STUBBED/deterministic agent runner. The single most valuable missing harness test.
- **P-020** `todo` LLM scenarios for the core pipeline roles — at minimum scoper (chunking), validator (acceptance-criteria judgment), reviewer (ship/return) (`apps/operator/lib/llm-testing/scenarios/`).
- **P-021** `todo` Human-approval gate E2E: needs-human → `/admin` approve → pipeline resumes. Playwright.
- **P-022** `done` `server.ts#dispatch()` direct tests (the in-process Operator/Oracle path). Unit. (server-dispatch.test.ts 8/8 — all branches + workspace-isolation invariant scope = principal.workspaceId, no caller channel)
- **P-023** `done` `provisioning.ts`: system-principal create/rotate + `token_index` cleanup + pi-session lifecycle. Integration. (provisioning.integration.test.ts 4/4, stable x3 — create/idempotent-skip/force-rotate/pi-session over real PG+RLS via new createOrgTestDb fixture + mocked withWorkspace. See D-004 for the seam's real state.)
- **P-024** `done` `applyToolManifest` cache-stability filtering (array vs object form, absent/malformed → expose-all, bypass, order). Unit. (tool-manifest.test.ts 8/8 — expose-all fallbacks, bypass, filter, manifest-order reorder, object form)

## Phase 3 — P2 (breadth / lower risk)

- **P-025** `todo` Handler-level tests for read tools: `features:*`, `issues:*`, `harness:*`, `tasks:*` (only `artifacts:*` is tested today).
- **P-026** `todo` Coord tool-handler layer: `whoami`, `watermark(-set)`, `watch/unwatch`, `thread`, `ack`.
- **P-027** `todo` Rust: `dev_bridge.rs` (the agent-test bridge), `custom_protocol.rs`, `wsl_setup.rs` (no tests).
- **P-028** `todo` Triage/de-skip the 4 skipped E2E specs: chat-streaming, admin-routes, ui-flow-login-prefs, plan-agent-launch.

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
