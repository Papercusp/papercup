# B-TOK-ROLL — findings + deliverables (2026-06-20, su-1282a)

Brief: B-TOK-3 (rollups + pricing) + B-TOK-4 (coordination-token attribution).
DONE = "$ cost per model/role/coord-kind is queryable; the coord-poll cost is quantified."
Reports to role-1176. Coordinated with B-TOK-FIX (su-dcb76) + B-TOK-UI (su-f7cfc).

## 1. THE 327K coord:wake-queue MYSTERY — SOLVED ✅

The owner's headline question (coding-hive-queen-bee-token-audit §"Open questions"):
*"The 327K coord:wake-queue calls/24h are UNATTRIBUTED … cheap polling or expensive
context-injection?"*

**Answer: cheap polling. ≈$0 LLM cost.** It is now ~409K/24h (growing).

Evidence (live `tool_invocations`, 24h):
- Caller: `spawn_id='palette'`, `role='operator'`, `transport='http'`, `plugin='agent-mcp'`,
  args `{"action":"list"}` — the **frontend command-palette UI** polling the fleet-wide
  wake board (`coord:wake-queue {action:list}`) at ~4.7×/sec, PAIRED with `coord:wake-mode`
  (408,608/24h). Still LIVE (~6.6/sec combined as of 20:15Z).
- **LLM token cost = $0.** `palette`/`operator` produces ZERO `agent_usage_samples` rows
  (verified) — these are pure MCP/HTTP *reads*, not model calls. The 409K is a POLL count,
  NOT a token count.
- It is NOT a context-injection driver: it injects nothing into any agent prompt.

**The real (non-token) cost it DOES incur:**
- `coord:wake-queue` + `coord:wake-mode` = **817,713 rows / 24h = 74.5% of ALL
  tool_invocations rows** → massive telemetry-write bloat.
- Constant DB load: ~66ms (wake-queue) / ~125ms (wake-mode) avg per call.

→ Filed as a separate improvement (the palette wake-board poll should be SSE/push or a
much longer interval). This is an infra-efficiency bug, NOT token spend.

## 2. WHERE THE REAL $ ACTUALLY IS (live, 24h)

| dim | $ (24h) | note |
|---|---|---|
| **total** | **$966** | 416.7M tokens, **82.8% cache-read** |
| opus-4-8 | **$904 (93%)** | 364M tokens — giant cached contexts re-read every turn |
| sonnet-4-6 | $61 | |
| haiku | $1.62 | |
| **role: queen** | **$754 (78%)** | the queen-on-opus turns ARE the cost |
| role: bee | $83 | |
| role: overwatch | $79 | |

7d coordination split (role-class proxy): **fleet (coord-driven) = $2,980 (95.6%)** vs
**interactive (human) = $135 (4.4%)**. ⇒ ~96% of LLM spend is coordination/fleet-driven,
not human-interactive. The lever is the queen-opus-cache path (confirms B-TOK-FIX's
~105× cache-undercount finding — cache_read = 92.5% of all tokens over 7d).

## 3. DELIVERABLES (built, tested, tree-local on staging)

1. **model_pricing table** (migration 334, APPLIED live + schema_migrations recorded) — a
   DERIVED PROJECTION of `@papercusp/model-pricing` MODEL_PRICES (canonical stays the code
   table, D-002-A). Explicit per-MTok rates incl. the cache-read tier. Refreshed at boot by
   `syncModelPricingFromCode()` (wired in host-bootstrap, post-migration).
   - `packages/operator-core/lib/harness-insights/model-pricing-sync.ts`
   - `libs/papercusp/libs/db/sql/334-model-pricing-snapshot-table.sql`
2. **Query layer** `load-token-rollups.ts` (separate from f7cfc's load-tokens.ts):
   - `loadModelPricingBook` — the per-MTok rate reference (transparency).
   - `loadCoordTokenBreakdown` — coord $ by **turn-trigger** (deploy-gated population) +
     by **role-class** (interactive vs fleet — queryable NOW).
   - `loadCoordPollVolume` — the quantified coord-poll cost (≈0 LLM tokens).
3. **Tests:** model-pricing-sync (5) + load-token-rollups (8) = 13 green.

## 4. turn_trigger (B-TOK-4 fine-grained) — BUILT ✅ (deploy-gated population)

Nullable `turn_trigger` column (migration 335, APPLIED live + recorded) threaded EXACTLY
like plan_id:
- writers: `usage-sample-pg.ts` + `agent-usage-telemetry.ts` (INSERT `turn_trigger`).
- read: `invoke.ts` reads `PAPERCUSP_TURN_TRIGGER` → recordUsageSamplePg.
- env stamp: `operator-spawn.ts` (`input.turnTrigger` → env).
- callers: `fleet/place_batch.ts` + `fleet/spawn.ts` stamp `'coord-wake'` (a placed agent's
  turn runs because it was placed = a coordination trigger).
- Population deploy-gated (live :3070 runs old code), same as plan_id. The loader's
  role-class proxy answers coord-vs-user $ TODAY (fleet $2,980 vs interactive $135).
- Tests: usage-sample-pg 11/11 (positional asserts updated for the new tail) + the rest green.

## 5. UI reachability — WIRED ✅

`insights.coordTokens` sync-resolver entry (sibling of f7cfc's `insights.tokens`) exposes
`{ pricingBook, coordBreakdown, pollVolume }` workspace-scoped. The B-TOK-UI Tokens subtab's
Coordination panel renders it (su-f7cfc). sync-resolver 44/44 green.

## 6. DEFERRED (deliberate — surfaced, NOT dropped)

- **Hourly/daily rollup tables + routine (B-TOK-3):** PREMATURE. agent_usage_samples is ~572
  jsonl rows/24h (~17K/30d); raw windowed GROUP BY is instant and the loaders day-bucket
  inline. Build a rollup routine when rows hit millions, not now.
- **account_usage_summary (B-TOK-3):** BLOCKED. No account-id signal exists on
  agent_usage_samples (bucket_key = `provider:modelClass` only, e.g. `anthropic:opus`; the
  routing account is gateway-internal state). Needs gateway-side per-account usage
  attribution first (B-GW-EGRESS adjacent). Not building a hollow table with no source.

## 7. FILES (all tree-local on staging; migrations applied live + recorded)
- libs/papercusp/libs/db/sql/334-model-pricing-snapshot-table.sql
- libs/papercusp/libs/db/sql/335-agent-usage-turn-trigger.sql
- packages/operator-core/lib/harness-insights/model-pricing-sync.ts (+ test)
- packages/operator-core/lib/harness-insights/load-token-rollups.ts (+ test)
- packages/operator-core/lib/agent-usage-telemetry.ts (turn_trigger)
- libs/papercusp/packages/orchestrator/src/usage-sample-pg.ts (+ test) + invoke.ts
- packages/operator-core/lib/fleet/operator-spawn.ts + agent-tools/fleet/{place_batch,spawn}.ts
- packages/operator-core/lib/sync-resolver/index.ts (insights.coordTokens)
- apps/operator/bin/host-bootstrap.ts (boot sync wiring)
- EI-2112 filed (palette wake-board poll → SSE/push)
