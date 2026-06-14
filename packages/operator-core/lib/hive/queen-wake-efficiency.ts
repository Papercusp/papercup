/**
 * queen-wake-efficiency — the per-wake cache/token metric for the Queen
 * (queen-brief-cache-assembly-2026-06-13 B-06 P-010, feeding P-003 + P-011).
 *
 * Each Queen wake is one governed subprocess run, so `harness_shared.agent_usage_samples`
 * already carries the per-wake token + cache breakdown (recordUsageSamplePg writes
 * input/output/cache_read/cache_creation/cost per run, tagged role='queen'). This
 * reader projects those rows into the cache-efficiency view the plan asks for:
 * per-wake cache-read ratio + the "caching is real" signal (cachedWakes > 0 — P-003's
 * non-zero `cache_read_input_tokens` assertion, now queryable rather than eyeballed).
 *
 * Pure aggregation over an injectable row source (`deps.fetchSamples`) so it
 * unit-tests with no DB; the default reads PG via getOrgPg.
 *
 * NOT YET CAPTURED: per-wake TURN COUNT (the round-trip-elimination metric, Win-2).
 * RunUsage/agent_usage_samples has no turn-count column; adding it needs a schema
 * migration (deferred — see the plan's remaining-work decision). The cache-ratio
 * here measures Win-1 (the frozen-prefix cache); turn-count will measure Win-2.
 */
import { getOrgPg } from '@papercusp/db-org';

/** One Queen wake's token + cache sample (one agent_usage_samples row). */
export interface QueenWakeSample {
  runId: string | null;
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

export interface QueenWakeEfficiency {
  /** Wakes (runs) considered. */
  wakes: number;
  /** Wakes with non-zero cache_read — the "the cache is actually being read" signal (P-003). */
  cachedWakes: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /**
   * Share of PROMPT tokens served from cache across the window:
   * cache_read / (cache_read + cache_creation + uncached input). 0 when no prompt
   * tokens were seen. Higher = the frozen prefix is paying off (Win-1).
   */
  cacheHitRatio: number;
  /** The per-wake samples, newest-first. */
  samples: QueenWakeSample[];
}

export interface QueenWakeEfficiencyDeps {
  /** Fetch the raw Queen usage rows (newest-first, capped). Injected for tests. */
  fetchSamples: (input: { workspaceId: string; harnessSlug?: string; limit: number }) => Promise<
    {
      run_id: string | null;
      ts: number | string;
      input_tokens: number | string | null;
      output_tokens: number | string | null;
      cache_read_tokens: number | string | null;
      cache_creation_tokens: number | string | null;
      cost_usd: number | string | null;
    }[]
  >;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function defaultDeps(): QueenWakeEfficiencyDeps {
  return {
    fetchSamples: async ({ workspaceId, harnessSlug, limit }) => {
      const { sql } = getOrgPg();
      return sql`
        SELECT run_id, ts, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
          FROM harness_shared.agent_usage_samples
         WHERE workspace_id = ${workspaceId}
           AND role = 'queen'
           ${harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``}
         ORDER BY ts DESC
         LIMIT ${limit}`;
    },
  };
}

/**
 * Aggregate the Queen's recent per-wake cache/token efficiency. `harnessSlug`
 * scopes to one hive home (omit for all of the workspace's Queen wakes).
 */
export async function queenWakeEfficiency(
  workspaceId: string,
  opts: { harnessSlug?: string; limit?: number; deps?: Partial<QueenWakeEfficiencyDeps> } = {},
): Promise<QueenWakeEfficiency> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const rows = await deps.fetchSamples({ workspaceId, harnessSlug: opts.harnessSlug, limit: opts.limit ?? 50 });

  const samples: QueenWakeSample[] = rows.map((r) => ({
    runId: r.run_id,
    tsMs: num(r.ts),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheCreationTokens: num(r.cache_creation_tokens),
    costUsd: r.cost_usd == null ? null : num(r.cost_usd),
  }));

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let cachedWakes = 0;
  for (const s of samples) {
    totalInputTokens += s.inputTokens;
    totalCacheReadTokens += s.cacheReadTokens;
    totalCacheCreationTokens += s.cacheCreationTokens;
    totalOutputTokens += s.outputTokens;
    totalCostUsd += s.costUsd ?? 0;
    if (s.cacheReadTokens > 0) cachedWakes += 1;
  }
  const promptTokens = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;
  const cacheHitRatio = promptTokens > 0 ? totalCacheReadTokens / promptTokens : 0;

  return {
    wakes: samples.length,
    cachedWakes,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    totalCostUsd,
    cacheHitRatio,
    samples,
  };
}
