---
title: Get Papercusp green across the test surface
slug: papercup-test-suite-green-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-03
owner: aviynw3@gmail.com
---

# Get Papercusp green across the test surface

## Now

**State (updated 2026-06-03 session):** UNIT tier fully GREEN. Integration TESTCONTAINER green. lint:tests + gen:contract:check green. Cargo: no in-scope tests. All committed. Items 1-6:
- (1) DOCS astro DONE — pinned exact 6.3.6 across root+docs. ✅
- (4) FEDERATION — **FULLY FIXED THIS SESSION (was escalated; now resolved).** (a) Migration **114** restores the IS-DISTINCT-FROM guard on substrate-outbox UPDATE capture (fixes the migration-108 regression) — applied live + committed (submodule 572f0fd, pointer bumped). (b) Found + fixed the **REAL root-cause bug**: the Hyperbee→PG projections double-encoded jsonb columns via `${JSON.stringify(x)}::jsonb` — postgres-js ALSO json-serializes the bound value, so each merge pass added a layer (`[]`→`"[]"`→`"\"[]\""`, unbounded) → outbox never converges + jsonb corruption. Fixed all 5 sites with postgres-js `sql.json()` (issues.notes, harness-features.metadata+tags, usage.payload, contributors.device_attestations). `feature-content-federation.integration` now CONVERGES/passes (~1.3s); +202 projection unit / 29 integration green. No live data corruption found (all jsonb cols clean on the dev DB). Agent-insight written (`agent-insights/postgres-js-jsonb-double-encoding`). ✅
- (5) itLive AUTH — admin 401→403 loopback, power-user su-bearer + REAL refresh-route auth bug, ask-choice validation: fixed+verified. ✅
- (3) LLM — Meridian router :3456 **started + working** (was down last session). Harness proven end-to-end (connects/dispatches/retries correctly; behavioral-smoke completed real LLM scans through it). **A full clean scenario verdict is BLOCKED by Claude Max OAuth quota exhaustion** — the account is shared across agents (meridian.log shows concurrent `opencode` consumers); even a solo `op-S01` run got 429 on all 8 retries (~180s sustained → a window-quota, not a per-min burst). No separate `ANTHROPIC_API_KEY` configured to bypass. ⛔ external quota.
- (2) behavioral-smoke — provisioning (mig 113) + concurrency retry-wrapper + 300s/scan timeout fixes committed; **4/6 scans pass**. The 2 failures (supervisor-notes, audit:list) are **LLM tool-choice nondeterminism** (supervisor-notes PASSED a prior run; this run the model chose `cross_harness_supervisor_notes`+`harness_list` instead of `harness:escalation`; audit:list called the correct history tools PLUS `harness_list`). Not timeouts/infra. Clean 6/6 blocked by LLM nondeterminism + the same Claude Max rate limit.
- (2) E2E — **148+ specs pass** against the live :3055/:3070; route-stable subset 30/34. Remaining failures triaged precisely: (i) **retired-surface specs** — `home.spec` tests a marketing home that no longer exists (`/` is now a pure redirect→`/adv`|`/setup`); needs REWRITE-to-assert-redirect, not delete. (ii) **auth-posture spec-drift** — e2e expects old codes (e.g. rest-query [400,404]) but the D3 tightening returns 403; specs need updating to the new gating. (iii) **FAKE_LLM-gated** (chat-streaming, plan-agent-launch, card-response, voice). (iv) **test-injection** (auth pgUnavailable). The Vite config hardcodes :3055→:3070, so the suite can only run against the singleton stack; making (iii) pass requires restarting the live :3070 with `PAPERCUSP_FAKE_LLM=1`, which **would break the user's currently-attached Tauri desktop (connect-once, no reconnect) + 6 peers**. ⛔ dedicated-env.

**Next:** (a) E2E full green = Phase-9 dedicated stack (isolated :3055/:3070 with FAKE_LLM, or a dedicated Xvfb Tauri) + careful per-spec modernization (rewrite retired-surface specs, update auth-posture codes). Not safe to churn 28 specs blind or restart the user's live desktop on the shared peer-saturated box. (b) LLM scenario verdict + clean behavioral-smoke 6/6 = need a Claude Max quota window (account currently shared/saturated with other agents incl. opencode) or a dedicated `ANTHROPIC_API_KEY`. The harnesses themselves are verified working; only the external quota blocks the final verdict.

## Background

Follows the test-framework coverage audit (`testing-domains-registry.ts`
+ `lint-tests.ts` guard) that made all 1169 canonical tests visible in
the `/adv` Tests tab. The user put me in charge of getting the app to
**pass** them, prioritized by importance, reusing the agent-made suites
in `apps/operator/lib/admin-test-suites.ts` (`desktop-health`,
`admin-testing-core`, `memory-core`, `packaged-readiness`, etc.).

Prioritization model (D-005): centrality × dependants × coverage-size ×
current-redness. Coverage sizes (test files): operator/lib other 321,
app 115, agent-tools 100, endpoint-route 81, harness 78, libs/generic 71,
libs/papercusp 68, dogfood/substrate 58, packages 51, gym 41,
integration 29, e2e 29, voice 24, memory 11.

Working discipline (D-004): triage each failure as real-bug /
stale-test / flake. Fix code for real bugs; update stale tests to assert
*correct current* behavior — never weaken or delete a test to force a
pass. Flakes → `quarantine.txt` with a written reason. Per-turn commits
on `main`, lock + coord discipline, no pushing.

## Phase 0 — Baseline + green-gate

P-001: [ ] Establish the authoritative `main` baseline — run the full unit suite + integration (Docker) + cargo on a clean `main`; read latest-status-per-file from `harness_shared.test_runs`; produce the true red list (the 71 is a floor — surface reds among files `test_runs` has never recorded).
P-002: [ ] Add a `green-gate` rollup (script reusing `scripts/affected-tests.mjs` + the `admin-test-suites` pattern) that runs one domain's tests and prints a pass/fail summary, so every pass is measurable and future agents inherit it.
P-003: [ ] Smoke-verify the key-dependent tiers actually resolve creds: run ONE LLM scenario via Meridian + one `memory-core` embedder check (OpenAI unset → try local transformers). Quarantine (with a written reason) only if genuinely unrunnable. Blocks: P-100.

## Phase 1 — agent-tools (the MCP tool layer; 32 red, most central)

P-010: [ ] Triage the agent-tools failure cluster for a shared root cause (a changed test helper / dispatcher / tool-registry) BEFORE editing 32 files — fix the root cause first.
P-011: [ ] Green every remaining `apps/operator/lib/agent-tools/**/__tests__/*.test.ts` (coordination, locks, operator, cross_harness, plans, flags, harness, plugins, projects, roles, delegates, dev, docs, experts, processes, substrate) + the top-level `agent-tools/__tests__/*` (backup/flags/messages/search/streaming-migration/registry-residuals). Blocked-by: P-010.

## Phase 2 — endpoint-route (HTTP/RPC routes; 12 red)

P-020: [ ] Green `apps/operator/lib/endpoint-route/**/__tests__/*.test.ts` (admin routes, harness, users, internal-ingestion, su-locks, snapshots).

## Phase 3 — foundations (everything imports these)

P-030: [ ] Run + green the foundation libs: `packages/agent-mcp`, `libs/papercusp/libs/db`, `libs/papercusp/packages/*`, `libs/generic/*` (sse, tooldef, ipc, plan-parser, search-core, rrf, embedded-pg-discovery), `packages/*`. A red here masks failures everywhere.

## Phase 4 — dogfood / collaborative core

P-040: [ ] Green the collaborative substrate: `apps/operator/lib/sync/hyperbee/**`, `orchestrator/**` (claim), `pr-host/**`, `agent-tools/substrate/**`, `identity/**`, `harness/__tests__/**` federation.

## Phase 5 — operator core + harness + app UI

P-050: [ ] Green the operator brain/state/plans/harness lib tests + the failing app component tests (`login/page`, `WorkspaceSwitcher`, `CreateHarnessPicker`, `AutoLoginWelcomeToast`, `agent-chat-stream.fake`, `branch-actions`).

## Phase 6 — feature domains

P-060: [ ] Green the self-contained feature domains: voice, gym, design, memory (non-suite units), mobile, snapshots, provisioning, workspace, dbos, adv, backup.

## Phase 7 — integration tier (Docker)

P-070: [ ] Green `apps/operator/test/*.integration.test.ts` (DB/lifecycle/RLS/cross-workspace-isolation/checkpoints/feature-lifecycle) + `*.integration.test.ts` elsewhere, via testcontainers Postgres.

## Phase 8 — cargo (rust)

P-080: [ ] Run + green cargo tests in the `libs/papercusp` crates. (papercusp-desktop's own Rust/wdio is OUT of scope — D-003.)

## Phase 9 — E2E + desktop suites (dedicated Xvfb Tauri)

P-090: [ ] Stand up a dedicated Xvfb Tauri instance (own `DISPLAY=:99` + own `PAPERCUSP_BRIDGE_PORT`; never the user's live `:0` window) per `/internal/docs/testing/agent-e2e`.
P-091: [ ] Green the Playwright E2E specs (`apps/operator/e2e/*.spec.ts`) against that instance, capped at 4 workers (dev-server compile limit).
P-092: [ ] Green the agent-made suites: `desktop-health` (the per-pass smoke gate) + `admin-testing-core`; then the opt-in `desktop-performance` / `admin-testing-extended` / `packaged-readiness`. Blocked-by: P-090.

## Phase 10 — key-dependent tiers (Meridian / embedder)

P-100: [ ] Green the LLM scenarios (`apps/operator/lib/llm-testing/scenarios/**`) + `ai-explore-prompts` (Meridian) + `memory-core` (embedder). Blocked-by: P-003.

## Phase 11 — close-out

P-110: [ ] Full green pass: every tier green OR explicitly quarantined with a written reason; `lint:tests` + `gen:contract:check` clean; `desktop-health` passing; final report with the green count per domain.

## Decisions

### D-001 Key-dependent tiers (LLM / ai-explore / memory) are IN scope

Date: 2026-06-02

The user confirmed the model key is saved. `llm-client.ts` routes through
`runAgentChat` with `backend: 'meridian'` (Claude Max — the same backend
this psu session runs on), with PG `operator_credentials` + env
`ANTHROPIC_API_KEY` fallbacks. So these tiers are runnable. P-003
verifies resolution by running one real scenario; `memory-core` needs an
embedder (OpenAI unset → fall back to local transformers). Anything truly
unrunnable is quarantined with a written reason, not left silently red.

### D-002 Include E2E + the desktop suites

Date: 2026-06-02

Per the user. Run them via a dedicated Xvfb-driven Tauri instance on its
own `DISPLAY`/`PAPERCUSP_BRIDGE_PORT` — never the user's live `:0` window
(focus-steal on a shared box is unacceptable). `desktop-health` becomes
the per-pass smoke gate.

### D-003 papercusp-desktop's own Rust/wdio tests are OUT of scope

Date: 2026-06-02

Per the user. `papercusp-desktop` is a separate checkout (the native
Tauri shell). This effort targets papercup's own `/adv` test surface. The
shell's `src-tauri` cargo tests + the wdio packaged-build driver are a
follow-up, not part of this plan.

### D-004 Fix code for real bugs; update stale tests to correct behavior — never weaken a test to pass

Date: 2026-06-02

The goal is a genuinely-passing app, not a green dashboard. For each
failure: real product bug → fix the code; test asserting outdated
behavior → update it to assert the *correct current* behavior (and say
why before removing any coverage); flake → `quarantine.txt` with a
reason. Deleting/skipping a test to force green is prohibited.

### D-005 Prioritization order

Date: 2026-06-02

centrality × dependants × coverage-size × current-redness →
agent-tools → endpoint-route → foundations (libs/packages) →
dogfood/substrate → operator core/harness/app → feature domains →
integration → cargo → e2e/desktop suites → key-dependent tiers. Highest
leverage first: the agent-tools cluster (most central, most red, likely
one root cause).
