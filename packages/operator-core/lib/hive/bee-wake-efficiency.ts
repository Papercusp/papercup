/**
 * bee-wake-efficiency — the per-bee, per-SESSION warm-inject carry-cost metric
 * (bee-context-efficiency-2026-06-14 Phase 0 / P-001, the bee analog of
 * queen-wake-efficiency.ts's B-06 per-wake metric).
 *
 * The difference from the Queen: a Queen wake is ONE governed run (1 row ↔ 1
 * wake). A Hive BEE instead processes MANY warm-injected tasks on ONE resumed
 * claude session (`claude --resume <session_id> -p`), its transcript
 * accumulating the full text of every prior task. So the bee metric GROUPS
 * `harness_shared.agent_usage_samples` by `session_id` (migration 279) and reads
 * the cache_read trajectory WITHIN a session: each successive wake re-reads the
 * grown transcript from cache, so cache_read on wake N ≈ "the tokens carried
 * into task N from tasks 1..N-1" — exactly the carry the plan wants to quantify
 * before deciding the Phase-1 fresh-context fork (D-001/D-006).
 *
 * Pure aggregation over an injectable row source (`deps.fetchSamples`) so it
 * unit-tests with no DB; the default reads PG via getOrgPg. Mirrors
 * queen-wake-efficiency's shape (EMPTY fallback, exported SELECT, `num` coercion)
 * so the hive-eval efficiency class (P-015) can fold it the same way.
 *
 * IMPORTANT (Phase-0 honesty): the warm-inject/resume turns are sampled ONLY
 * once `wake-executor`'s resume-headless path records a usage row (the companion
 * P-001 instrumentation). Until then a bee session shows a SINGLE wake (its
 * initial invoke.ts spawn) — `multiWakeSessions === 0` is itself the finding
 * that the resume path is unsampled, not a bug in this reader.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** One bee wake's token + cache sample (one agent_usage_samples row, role='bee'). */
export interface BeeWakeSample {
  runId: string | null;
  sessionId: string | null;
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  turns: number | null;
}

/** One bee SESSION = the ordered wakes that share a session_id (the resumed
 *  transcript). The carry lives in the non-first wakes. */
export interface BeeSession {
  sessionId: string;
  /** Chronological wakes on this session (ts ASC). length 1 ⇒ never warm-injected. */
  wakes: BeeWakeSample[];
  /** cache_read summed over wakes AFTER the first — the resumed-context re-reads
   *  that a fresh-per-task spawn would not incur (the carry signal). */
  carriedReadTokens: number;
  /** cache_read on the LAST wake − cache_read on the FIRST: the net transcript
   *  growth across the session (≥0 when the transcript only accumulates). */
  carryGrowthTokens: number;
  /** Largest single-wake cache_read on the session. */
  peakCacheReadTokens: number;
  totalCostUsd: number;
}

export interface BeeWakeEfficiency {
  /** Distinct bee sessions in the window. */
  sessions: number;
  /** Total bee wakes (rows) across all sessions. */
  totalWakes: number;
  /** Sessions with >1 wake — the ones that ACTUALLY warm-injected (resumed). */
  multiWakeSessions: number;
  /** Mean wakes per multi-wake session (how many tasks a warm bee carries before
   *  a fresh spawn). null when no multi-wake session exists. */
  avgWakesPerMultiSession: number | null;
  /** Σ carriedReadTokens across sessions — the total resumed-context read volume
   *  warm-inject incurs that a fresh-per-task spawn would not. */
  totalCarriedReadTokens: number;
  /** Mean carried read tokens per warm-inject (per non-first wake). null when
   *  there were no warm-injects. */
  avgCarriedPerWarmInject: number | null;
  /** carriedReadTokens / (all prompt tokens: cache_read + cache_creation + input)
   *  across the window — the share of prompt volume that is resumed-transcript
   *  carry. 0 when no prompt tokens were seen. */
  carryShareOfPrompt: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** Per-session detail, newest-session-first (by the session's latest wake). */
  perSession: BeeSession[];
}

/** The zeroed aggregate — the fail-soft fallback (e.g. a not-yet-applied
 *  migration 279) so a consumer renders a no-data state, never a 500. */
export const EMPTY_BEE_WAKE_EFFICIENCY: BeeWakeEfficiency = {
  sessions: 0,
  totalWakes: 0,
  multiWakeSessions: 0,
  avgWakesPerMultiSession: null,
  totalCarriedReadTokens: 0,
  avgCarriedPerWarmInject: null,
  carryShareOfPrompt: 0,
  totalInputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  perSession: [],
};

/** One raw `agent_usage_samples` row (PG numerics may arrive as strings). */
export interface BeeWakeSampleRow {
  run_id: string | null;
  session_id: string | null;
  ts: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_creation_tokens: number | string | null;
  cost_usd: number | string | null;
  turn_count: number | string | null;
}

export interface BeeWakeEfficiencyDeps {
  /** Fetch the raw bee usage rows (newest-first, capped). Injected for tests. */
  fetchSamples: (input: { workspaceId: string; harnessSlug?: string; limit: number }) => Promise<BeeWakeSampleRow[]>;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * The canonical bee-wake usage SELECT over an explicit `sql` client — the single
 * source of the column list so both the default PG deps AND a hive-eval live
 * capture read identical rows. Only session-attributed rows (session_id NOT NULL)
 * participate — an unattributed sample can't be grouped into a session.
 */
export function beeWakeSampleRows(
  sql: postgres.Sql,
  input: { workspaceId: string; harnessSlug?: string; limit: number },
): Promise<BeeWakeSampleRow[]> {
  return sql<BeeWakeSampleRow[]>`
    SELECT run_id, session_id, ts, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_usd, turn_count
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${input.workspaceId}
       AND role IN ('bee', 'cup')
       AND session_id IS NOT NULL
       ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
     ORDER BY ts DESC
     LIMIT ${input.limit}`;
}

function defaultDeps(): BeeWakeEfficiencyDeps {
  return {
    fetchSamples: async (input) => beeWakeSampleRows(getOrgPg().sql, input),
  };
}

/**
 * Aggregate recent bee wakes into the per-session warm-inject carry view.
 * `harnessSlug` scopes to one hive home (omit for the whole workspace's bees).
 */
export async function beeWakeEfficiency(
  workspaceId: string,
  opts: { harnessSlug?: string; limit?: number; deps?: Partial<BeeWakeEfficiencyDeps> } = {},
): Promise<BeeWakeEfficiency> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const rows = await deps.fetchSamples({ workspaceId, harnessSlug: opts.harnessSlug, limit: opts.limit ?? 200 });

  // Group by session, then order each session's wakes chronologically.
  const bySession = new Map<string, BeeWakeSample[]>();
  for (const r of rows) {
    if (r.session_id == null) continue; // defensive — the SELECT already filters
    const sample: BeeWakeSample = {
      runId: r.run_id,
      sessionId: r.session_id,
      tsMs: num(r.ts),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_tokens),
      cacheCreationTokens: num(r.cache_creation_tokens),
      costUsd: r.cost_usd == null ? null : num(r.cost_usd),
      turns: r.turn_count == null ? null : num(r.turn_count),
    };
    const arr = bySession.get(r.session_id);
    if (arr) arr.push(sample);
    else bySession.set(r.session_id, [sample]);
  }

  const perSession: BeeSession[] = [];
  let totalWakes = 0;
  let multiWakeSessions = 0;
  let totalCarriedReadTokens = 0;
  let warmInjects = 0; // non-first wakes across all sessions
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const wakesUnsorted of bySession.values()) {
    const wakes = wakesUnsorted.slice().sort((a, b) => a.tsMs - b.tsMs);
    totalWakes += wakes.length;
    if (wakes.length > 1) {
      multiWakeSessions += 1;
      warmInjects += wakes.length - 1;
    }

    let carriedReadTokens = 0;
    let peakCacheReadTokens = 0;
    let totalSessionCost = 0;
    for (let i = 0; i < wakes.length; i++) {
      const w = wakes[i];
      totalInputTokens += w.inputTokens;
      totalCacheReadTokens += w.cacheReadTokens;
      totalCacheCreationTokens += w.cacheCreationTokens;
      totalOutputTokens += w.outputTokens;
      totalCostUsd += w.costUsd ?? 0;
      totalSessionCost += w.costUsd ?? 0;
      if (w.cacheReadTokens > peakCacheReadTokens) peakCacheReadTokens = w.cacheReadTokens;
      if (i > 0) carriedReadTokens += w.cacheReadTokens; // the resumed-context reads
    }
    totalCarriedReadTokens += carriedReadTokens;
    const carryGrowthTokens = wakes[wakes.length - 1].cacheReadTokens - wakes[0].cacheReadTokens;

    perSession.push({
      sessionId: wakes[0].sessionId as string,
      wakes,
      carriedReadTokens,
      carryGrowthTokens,
      peakCacheReadTokens,
      totalCostUsd: totalSessionCost,
    });
  }

  // Newest-session-first by the session's latest wake.
  perSession.sort((a, b) => b.wakes[b.wakes.length - 1].tsMs - a.wakes[a.wakes.length - 1].tsMs);

  const promptTokens = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;
  return {
    sessions: bySession.size,
    totalWakes,
    multiWakeSessions,
    avgWakesPerMultiSession:
      multiWakeSessions > 0
        ? perSession.filter((s) => s.wakes.length > 1).reduce((n, s) => n + s.wakes.length, 0) / multiWakeSessions
        : null,
    totalCarriedReadTokens,
    avgCarriedPerWarmInject: warmInjects > 0 ? totalCarriedReadTokens / warmInjects : null,
    carryShareOfPrompt: promptTokens > 0 ? totalCarriedReadTokens / promptTokens : 0,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    totalCostUsd,
    perSession,
  };
}
