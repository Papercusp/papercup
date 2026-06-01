---
title: Cross-backend agent cost capture (claude / codex / omp) — make spend real for ALL backends
slug: cross-backend-cost-capture-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: aviynw10@gmail.com
---

# Cross-backend agent cost capture (claude / codex / omp) — make spend real for ALL backends

## Now

**State:** **Overview / not started — implement later.** Agent cost capture is **claude-only today**; codex + omp runs record **$0** (and 0 tokens for codex). The run writer `apps/operator/lib/harness-agent-runs.ts` (`scanAgentRuns`, ~line 100) parses only claude-stream-json's terminal shape: `costUsd = obj.total_cost_usd ?? 0`, `usage.input_tokens/output_tokens`. The three backends emit DIFFERENT terminal events: **claude** `{type:"result", total_cost_usd, usage}` (cost given); **codex** `{type:"turn.completed", usage:{input_tokens,output_tokens}}` (tokens only, NO cost); **omp** `usage.cost.total` (cost, different shape — see `pm-dispatch.ts:474`). So `agent_runs_consolidated.cost_usd` is reliable for claude, ~partial for omp, broken (0) for codex. The same claude-only assumption is in `cost-cap.ts` `sumJsonlCost` (sums only `total_cost_usd`) → the per-harness `maxCostUsd` cap doesn't fire for codex/omp runs either. The Insights **SpendCard** (`load-spend.ts`/`load-your-place.ts`) queries phantom `tool_invocations.cost_microcents` (no such column) → always 0, shielded behind a "proxy-witness" deferral explainer. Tokens are the robust common denominator — all three emit token counts; cost is the fragile part (only claude/omp report it directly; codex must be priced from tokens). A model→price table with claude AND codex prices already exists but is scoped to the LLM-testing harness: `apps/operator/lib/llm-testing/llm-client.ts` `MODEL_PRICES` (a liftable building block).

**Next:** Owner decides the approach (D-002: A full-cost vs B tokens-first vs C defer) before implementing. Recommended: B (capture tokens reliably for all three; show cost only where derivable, honest about estimated-vs-billed).

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — Implementation (later)

- **P-001** `todo` Per-backend usage extractor: normalize each terminal event → canonical `{model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd?}`. claude `result.total_cost_usd`+`usage`; omp `usage.cost.total`+tokens; codex `turn.completed.usage` (tokens-only). One module, unit-tested per format. Foundation for everything below. importance: high
- **P-002** `todo` Record the per-run model id on the run (needed to price codex's tokens — it reports no cost). The spawn already resolves a model (invoke.ts resolveModel/normalizeModelForBackend); persist it on the agent-run record.
- **P-003** `todo` Lift `MODEL_PRICES` (apps/operator/lib/llm-testing/llm-client.ts — already has claude + codex prices) to a shared lib + a `costFromTokens(model, usage)` helper. Provider-reported cost wins when present; else compute from tokens×price. Note the ongoing-maintenance reality (prices drift).
- **P-004** `todo` Make the writers backend-aware: replace the claude-only parse in `harness-agent-runs.ts` (scanAgentRuns ~L100) with the extractor, and fix `orchestrator/src/cost-cap.ts` `sumJsonlCost` so the per-harness `maxCostUsd` cap actually fires for codex/omp runs (not just claude). This alone stops codex/omp reading as $0 / uncapped. importance: high
- **P-005** `todo` Add `workspace_id` to `agent_runs_consolidated` (currently absent; PK `(harness_slug, run_id)`) + populate at the writer + scope reads, so run cost/tokens are workspace-scoped under the shared operator (D-003 #1). Migration + writer + query updates.
- **P-006** `todo` Repoint the Insights SpendCard: `load-spend.ts`/`load-your-place.ts` read real cost/tokens (from the now-backend-aware run data) instead of phantom `tool_invocations.cost_microcents`. Drop/rework the unattributable per-viewer line (D-003 #2); label estimated (token-priced) vs provider-billed; retire or repurpose the proxy-witness explainer.

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)

### D-001 — D-001 — Finding: cost capture is claude-only; codex=0, omp=partial (evidence)
Date: 2026-06-01
Traced the real cost path (2026-06-01):
- **Writer** `apps/operator/lib/harness-agent-runs.ts` `scanAgentRuns` (~L100) tail-reads the last result line for `obj.total_cost_usd` + `obj.usage.{input,output,cache_*}_tokens` — **claude-stream-json's shape only**. It writes `agent_runs_consolidated.{cost_usd,input_tokens,...}`.
- **Per-backend terminal events differ** (`StreamFormat` = `claude-stream-json | omp-json | codex-json` in `orchestrator/src/invoke.ts:342`): claude `{type:"result", total_cost_usd, usage}`; codex `{type:"turn.completed", usage:{input_tokens,output_tokens}}` (TOKENS, no cost — see `invoke.test.ts:1042`); omp `usage.cost.total` (cost, different shape — `pm-dispatch.ts:474`).
- **Consequence:** `agent_runs_consolidated.cost_usd` is correct for claude, 0 for codex (writer never reads `turn.completed`), 0 for omp (writer ignores `usage.cost.total`). codex also gets 0 tokens.
- **Same claude-only bug in the cost cap:** `orchestrator/src/cost-cap.ts` `sumJsonlCost` sums only `total_cost_usd` → per-harness `maxCostUsd` never fires for codex/omp runs.
- **SpendCard** (`harness-insights/load-spend.ts` + `load-your-place.ts`) queries `tool_invocations.cost_microcents` — a column that does not exist (no cost column on tool_invocations at all) → spend always 0, hidden behind the "proxy-witness" deferral explainer.

So a naive "repoint the SpendCard to agent_runs_consolidated.cost_usd" would show claude-only spend and report codex/omp as $0 — misleading. The real work is making capture backend-aware.

### D-002 — D-002 — Approach options (OPEN — avi's call): A full-cost / B tokens-first / C defer
Date: 2026-06-01
Tokens are the robust common denominator (all three backends emit token counts); cost is fragile (claude/omp report it; codex must be priced from tokens × a per-model rate). Options:

- **A — Full cross-backend cost.** Per-backend usage extractor → canonical `{model, inputTokens, outputTokens, cacheRead, cacheCreate, costUsd?}`; record the per-run model id; lift `MODEL_PRICES` (llm-client.ts — already has claude + codex prices) to a shared lib; cost = provider-reported when present, else tokens×price. Most accurate, but codex/omp numbers are ESTIMATED (list price, not provider-billed), and price tables need ongoing upkeep as models/prices drift.
- **B — Tokens-first, cost-where-known (RECOMMENDED).** Fix the writer to parse all three terminal shapes so TOKENS are reliable for all backends; show cost only where derivable; label estimated vs billed. Less maintenance, no false precision. Tokens are the trustworthy unit.
- **C — Defer.** Keep the proxy-witness explainer; revisit when cost matters more.

Recommendation: **B.** Decision needed before implementation. Also decide whether this gates the SpendCard or whether the higher-value first win is just making the writer + cost-cap backend-aware (so codex/omp runs stop reading as $0 / uncapped).

### D-003 — D-003 — Coupled gaps surfaced alongside (decide when implementing)
Date: 2026-06-01
Two adjacent gaps the SpendCard repoint would otherwise inherit:
1. **`agent_runs_consolidated` has NO `workspace_id` column** (PK is `(harness_slug, run_id)`). So run cost/tokens aren't workspace-scoped — same harness slug across workspaces would mix (a per-window-workspace-context P-041-class gap). Fix = add `workspace_id` + populate at the writer + scope reads. Needed for correct per-workspace spend under the shared operator.
2. **Per-viewer ("you") spend has no source.** The SpendCard's `viewerUsdThisWeek` wants per-`github_user_id` attribution, but agent runs are orchestrator-spawned, not attributed to a person — `agent_runs_consolidated` has no user/actor column. → drop the per-viewer line, or add actor attribution to runs (bigger). The harness TOTAL is the meaningful, available number.
