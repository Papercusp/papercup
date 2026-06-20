# Token-usage tracking — plan + briefs (2026-06-20)

## Why
We're burning account quota faster than expected. Audit (24h): **~$788 notional, opus = 90%
of spend, cache-read = 82% of all tokens** (~402K cache-read tokens/call avg → giant contexts
re-read every turn). We can't yet attribute it **per-session/plan/agent**, and the Insights
"Spend" card **under-counts tokens ~5×** (it sums input+output only, excludes cache). We need a
real token dashboard + the attribution to drive spend down — especially as the system shifts
from su/continuous-sessions to the queen/bee model (whose token-efficiency bet this tracking
will validate).

Good news from the codebase map: we ALREADY capture rich per-call data in
`harness_shared.agent_usage_samples` (input/output/cache-read/cache-creation tokens, cost_usd,
model, bucket_key, role, harness_slug, run_id, ts + the RL snapshot). The gaps are
*attribution* (session/plan/tool) and *surfacing*.

## Decisions
- **D-001** — New **"Tokens"** subtab under Insights; move the current Insights content to an
  **"Overview"** subtab. nuqs `?insightView=overview|tokens` (default `overview`), mirroring
  `LearningTab.tsx`'s `?lview` pattern.
- **D-002** — Phase 1 (the dashboard) reads EXISTING captured data → ships with no new plumbing.
  Phase 2 adds the attribution (session/plan/tool) that unlocks the deeper views.
- **D-003** — Count ALL four token types (input/output/cache-read/cache-creation) everywhere;
  fix the `load-spend.ts` cache undercount.
- **D-004** — Keep the fleet footprint **LEAN** (3 briefs / ~3 agents). Building a usage-tracker
  shouldn't torch the budget — the irony is the point.

## Briefs

### B-TOK-1 — Tokens subtab UI + `load-tokens` query (Phase 1)
**Goal:** the Insights → Overview/Tokens subtab split + a Tokens dashboard from existing data.
**Files:** `apps/operator/app/harness/insights/InsightsTab.tsx` (render Overview vs Tokens) + a new
`TokensSubtab` component; the insights route + `apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx`
(`AdvInsightsTab`) — add the nuqs param; new `packages/operator-core/lib/harness-insights/load-tokens.ts`
(sibling of `load-spend.ts`).
**Do:** nuqs `?insightView=overview|tokens` (parseAsStringEnum, default overview), subtab bar mirroring
LearningTab. **Overview = the current 6 cards, unchanged.** **Tokens** shows (from
agent_usage_samples + gateway /stats + account-pool): headline ($ 24h/7d, **opus %**, total tokens,
**cache-read %**); spend+tokens over time (24h/7d/30d, stacked by model-class); token-type breakdown
(input/output/cache-read/cache-creation); cache hit-rate (cache-read ÷ (input+cache-read)); by-model
(opus/sonnet/haiku: calls/tokens/$); **by-role + by-harness** top consumers; per-account 5h/7d
utilization + paused state; fleet opus-governor zone + shedding; a **Coordination** panel (token footprint by coord category + coord-triggered-turn spend — fed by B-TOK-4). `load-tokens.ts` aggregates
agent_usage_samples (GROUP BY bucket_key/model/role/harness_slug, windowed), counting ALL token types.
**Acceptance:** subtab renders; `?insightView` toggles + persists in URL; Overview unchanged; Tokens
shows live numbers that match the audit (opus ~90%, cache-read ~82%); tests + a verdict UI check.
**Deps:** none (existing data). The per-session/plan/tool panels light up after B-TOK-2.

### B-TOK-2 — Usage attribution + the cache-undercount fix
**Goal:** attribute every LLM call to its session / plan / tool, and stop under-counting cache tokens.
**Files:** a migration extending `harness_shared.agent_usage_samples` (FIRST verify the status of
`279-agent-usage-samples-session-id.sql` — session_id may already exist);
`packages/operator-core/lib/agent-usage-telemetry.ts` (record the new fields);
`packages/operator-core/lib/harness-insights/load-spend.ts` (the cache fix).
**Do:** add `session_id` (if 279 didn't land it), `plan_id`, `tool_name` columns; populate them in
recordUsageSample / recordUsageTokens / recordUsageHeaders from the spawn/turn context (session id,
current plan slug, the turn's tool). **FIX `load-spend.ts`:** the token total must include
cache_read + cache_creation (it's input+output only today → ~5× undercount). Add indexes for
`(session_id)`, `(plan_id)`, `(role, ts DESC)`.
**Acceptance:** new calls record session/plan/tool; a query sums tokens per-session + per-plan;
load-spend token total includes cache; tests.
**Deps:** none (backend/DB). Unlocks B-TOK-1's per-session/plan/tool views. ⚠ coordinate the migration
number with su-7fa79 (papercup→papercusp) + any other in-flight migration (avoid a number collision).

### B-TOK-3 — Rollups + pricing snapshot + per-account history (Phase 3)
**Goal:** fast trends + cost transparency + persistent per-account spend.
**Files:** migrations (`agent_usage_hourly`/`agent_usage_daily` rollups; `model_pricing` snapshot;
`account_usage_summary`); a rollup routine (reuse the routines engine); wire the dashboard trends to
read the rollups.
**Do:** hourly/daily rollup tables (a routine aggregates agent_usage_samples → buckets) so the
dashboard doesn't re-scan raw rows; a `model_pricing` table (model_id, input/output/cache-creation/
cache-read $/Mtok, effective_date) for correct cache-tier pricing + $ transparency; an
`account_usage_summary` for persistent per-account spend history (ephemeral today). Surface the
existing `source` column for interactive-vs-fleet split.
**Acceptance:** rollups populate on the routine tick; the dashboard trend reads the rollup; pricing
table drives cost; per-account history survives a restart; tests.
**Deps:** B-TOK-2's schema (loosely). Phase-3, lower priority.

### B-TOK-4 — Coordination token attribution (the coord-cost lens)
**Goal:** surface which KINDS of coordination consume the most tokens, and how many.
**Key insight:** coord tool calls (coord:send/inbox/presence/wake) are MCP calls — ~0 LLM tokens
themselves — but coordination drives LLM token spend TWO ways: **(a)** coord CONTENT injected into
agent contexts (inbox messages, presence injections, plan-events, wake payloads, the ambient feed)
bloats the cached context re-read every turn — a direct contributor to the 82%-cache-read finding;
**(b)** every `coord:send {wake}` TRIGGERS a turn → an LLM call. Track both.
**Files:** the context-assembly / prompt-build path where coord content enters the prompt
(prompt-build.ts + the inbox/presence/plan-events injectors); agent-usage-telemetry.ts (tag the turn
trigger); a coord-token capture.
**Do:** (1) instrument the context assembler to measure the token-size of coord-originated content
injected per turn, **bucketed by coord type** (inbox / presence / plan-events / wake-payload /
ambient-feed) — record it (a `coord_inject_tokens` breakdown on the usage sample, or a sibling
`coord_usage` table). (2) tag each usage sample's **turn-trigger** (coord-wake / cron / user /
autoloop) so we can sum "tokens consumed by coord-triggered turns." (3) expose the aggregation:
tokens by coord-category + coord-triggered-turn token total.
**Acceptance:** a query shows tokens attributable to each coord category + the coord-wake-triggered
token total; surfaced in B-TOK-1's Tokens subtab as a **Coordination** panel; tests.
**Deps:** B-TOK-2 (attribution columns) loosely; B-TOK-1 surfaces it.

## Routing & waves
⚠ **GATED ON THE RENAME WINDOW.** su-7fa79 is mid a ~900-file papercup→papercusp **physical rename
with git-sync PAUSED** (several agents parked for it). These briefs touch operator-core/operator-vite
+ add a migration → **claim now, but START building only after su-7fa79's rename window closes +
git-sync resumes** (then coordinate the migration number). Building on the moving/paused tree now =
conflicts + lost work.
- **W1 (post-window):** B-TOK-1 (UI) + B-TOK-2 (attribution) + B-TOK-4 (coord) — independent, parallel.
- **W2:** B-TOK-3 (after B-TOK-2's schema).
- Owner: role-1176eb92 — ping on blockers. Lean: 4 briefs / 4 agents.

### Routing (confirmed-available; NOT gateway-plan or rename-parked agents)
| Brief | Owner | why |
|---|---|---|
| B-TOK-1 (UI + subtab) | su-5695e | active + available; clean recent ships |
| B-TOK-2 (attribution + cache fix) | su-fcbcc | built B-GW-4 opus-governor + B-X-1 — knows the usage/rate layer |
| B-TOK-3 (rollups/pricing) | su-2a0b4 | available; aggregation/migration work |
| B-TOK-4 (coord-token) | su-37003 | did the coord/scout scheduler wiring — closest to coord-context |
