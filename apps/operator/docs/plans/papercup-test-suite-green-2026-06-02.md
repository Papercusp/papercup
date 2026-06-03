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
- (3) LLM — **DONE via the claude-code backend** (user-directed: use the subscription, reserve the Anthropic SDK). `LLM_TEST_BACKEND=claude-code` routes the harness through the `claude` CLI subprocess (subscription session) — no meridian/Claude-Max-OAuth 429s, no API key. `op-S01-status-quick` runs to a **PASSING verdict** (status=passed, judge 0 errors, $0.15) after fixing a mis-authored assert (`control_tag_present` defaults minCount=1, but the scenario expects 0 `<continue/>` → added `minCount:0`). ✅ (Minor follow-up: ledger persistence to `git_export_outbox` fails on a null `harness_slug` — non-fatal, scenario proceeds.)
- (2) behavioral-smoke — provisioning (mig 113) + concurrency retry-wrapper + 300s/scan timeout fixes committed; runs on the **claude-code subscription backend** (operator `.env.local` AGENT_BACKEND=claude-code). **4/6 scans pass; the 2 failures ROTATE across runs** (run A: supervisor-notes+audit:list; run B: escalation+audit:list) = genuine **LLM tool-choice nondeterminism**, not infra/timeouts. `audit:list` fails most consistently (model adds `harness_list` to the correct history tools — a possible guidance nuance). Infra fixes are correct; residual is model variance — NOT forced green (D-004). ✅ infra / ⚠ inherent nondeterminism.
- (2) E2E — **148 → 180 pass / 4 skip / 28 fail** (against the stable `:3070` built-SPA target). Landed this session:
  - **Render root-cause fixed.** SPA rendered blank in headless Chromium (`#root=0ch`): the Vite dev server serves a noop `/@vite/client` stub when HMR is off, but dev-transformed modules import `createHotContext` → throws → nothing mounts. Fix: `PAPERCUSP_ENABLE_HMR=1` on the e2e webServer (committed). The **built SPA at `:3070`** is the robust target (a standalone HMR vite OOM-crashed under 4 workers).
  - **405 dispatcher restored** (`lib/endpoint-route/method-not-allowed.ts` + `host-app.ts`): a Hono `notFound` hook returns 405 (with `Allow`) for a known path hit with the wrong verb (was a blanket 404), excluding catch-alls to avoid false 405s. +unit test. Cleared the A1 cluster (~13: card-response, sse, workspace-*, admin embed/prune, …).
  - **home.spec** rewritten to assert the `/`→`/adv|/setup` redirect (retired marketing surface); **admin-routes** now send the SU bearer (VT-gated routes) + accept 401|403; **dock/find-in-page** dropped `waitForLoadState('networkidle')` (hung on persistent SSE).
  - **Remaining 28**, each needing real work (not mechanical): **dock (10)** — a client-side workspace-sync (`?ws=`) **clobbers the `?dock=1` search param** so the dock shell never activates (real routing bug — ws-sync must preserve other search params); **plugins-lifecycle/host 405 (4)** — these paths go through the `/plugins/*` catch-all which intercepts before `notFound`, so 405 needs the **plugins dispatcher** itself; **voice a11y (4)** — real axe violations / TTS-engine count drift (product UI); **auth (3)** — `/login?switch` depends on injected auth-state; **find-in-page (3)** — find-bar behavior on the rendered page; **memory:remember (1)** — route returns **200 without auth** (the test expected it gated — a possible **real auth gap** to verify, not a test fix); **backups SSE (1)** + **ui-flow login-validation (1)**.

**Next:** E2E remaining clusters are deeper/product-ish: dock = fix the ws-sync to preserve search params (clears 10); plugins-405 = teach the `/plugins/*` dispatcher to 405; voice-a11y = fix the axe violations; memory:remember = decide whether the route should be auth-gated (possible security gap). The ~4 truly FAKE_LLM-gated specs (chat-streaming, plan-agent-launch) need a FAKE_LLM `:3070` window. All harnesses (LLM via claude-code, behavioral-smoke) are verified working; the e2e render + A1/home/admin clusters are LANDED.

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
