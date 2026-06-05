/**
 * Agent usage telemetry (rate-limit-layer-v2 D-002) — one row per governed agent call into
 * `harness_shared.agent_usage_samples` (migration 161), and the aggregation the fleet read-model
 * surfaces. Extends cross-backend-cost-capture (which captured $ only) with token counts + the
 * `anthropic-ratelimit-*` snapshot.
 *
 * Captured at the TWO points usage is observable (D-002):
 *   1. the in-process meridian path (`recordUsageHeaders`) — real anthropic-ratelimit-* headers;
 *   2. the subprocess `{"type":"result", …usage}` JSONL event (`recordUsageTokens`) — token
 *      counts + $cost, visible even when the CLI hides the rate-limit headers.
 *
 * Honest limitation: a true "usage%" only exists when a provider exposes a ceiling (header-bearing
 * / API-key paths). The summary returns `usagePct: null` for subscription buckets rather than a
 * fabricated number — the surface shows throughput + $spend there instead.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface UsageSample {
  bucketKey: string;
  provider: string;
  modelClass: string;
  source: 'headers' | 'jsonl';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  rlRequestsLimit?: number;
  rlRequestsRemaining?: number;
  rlTokensLimit?: number;
  rlTokensRemaining?: number;
  rlResetAt?: number;
}

export interface UsageBucketSummary {
  key: string;
  provider: string;
  modelClass: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  spendUsd: number;
  /** (1 - remaining/limit) × 100 from the most-recent header sample; null when no ceiling known. */
  usagePct: number | null;
  rlResetAt: number | null;
}

export interface UsageSummary {
  windowMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  spendUsd: number;
  buckets: UsageBucketSummary[];
}

const TABLE = 'harness_shared.agent_usage_samples';

const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Persist one usage sample (best-effort — telemetry must never break the agent path). */
export async function recordUsageSample(sample: UsageSample): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    await sql`
      INSERT INTO ${sql(TABLE)}
        (workspace_id, ts, bucket_key, provider, model_class, source,
         input_tokens, output_tokens, cache_read_tokens, cost_usd,
         rl_requests_limit, rl_requests_remaining, rl_tokens_limit, rl_tokens_remaining, rl_reset_at)
      VALUES (
        ${ws}, ${Date.now()}, ${sample.bucketKey}, ${sample.provider}, ${sample.modelClass}, ${sample.source},
        ${n(sample.inputTokens)}, ${n(sample.outputTokens)}, ${n(sample.cacheReadTokens)}, ${n(sample.costUsd)},
        ${n(sample.rlRequestsLimit)}, ${n(sample.rlRequestsRemaining)}, ${n(sample.rlTokensLimit)}, ${n(sample.rlTokensRemaining)}, ${n(sample.rlResetAt)}
      )
    `;
  } catch {
    /* telemetry is best-effort; never throw into the agent path */
  }
}

/** Capture from an in-process response's headers (the meridian path). Parses anthropic-ratelimit-*
    + any usage tokens the caller passes. No-op if nothing useful is present. */
export async function recordUsageHeaders(
  bucketKey: string,
  provider: string,
  modelClass: string,
  headers: Record<string, string | undefined>,
  tokens?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number },
): Promise<void> {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const resetRaw = h['anthropic-ratelimit-tokens-reset'] ?? h['anthropic-ratelimit-requests-reset'];
  const resetAt = resetRaw ? Date.parse(resetRaw) : undefined;
  const sample: UsageSample = {
    bucketKey,
    provider,
    modelClass,
    source: 'headers',
    rlRequestsLimit: num(h['anthropic-ratelimit-requests-limit']),
    rlRequestsRemaining: num(h['anthropic-ratelimit-requests-remaining']),
    rlTokensLimit: num(h['anthropic-ratelimit-tokens-limit'] ?? h['anthropic-ratelimit-input-tokens-limit']),
    rlTokensRemaining: num(h['anthropic-ratelimit-tokens-remaining'] ?? h['anthropic-ratelimit-input-tokens-remaining']),
    rlResetAt: resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined,
    ...tokens,
  };
  // Skip a wholly-empty sample (no headers AND no tokens) to avoid noise.
  if (
    sample.rlRequestsLimit === undefined &&
    sample.rlTokensLimit === undefined &&
    sample.inputTokens === undefined &&
    sample.outputTokens === undefined &&
    sample.costUsd === undefined
  ) {
    return;
  }
  await recordUsageSample(sample);
}

/** Capture token usage from a subprocess result event (the JSONL `{"type":"result", …usage}`). */
export async function recordUsageTokens(
  bucketKey: string,
  provider: string,
  modelClass: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number },
): Promise<void> {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.costUsd === undefined
  ) {
    return;
  }
  await recordUsageSample({ bucketKey, provider, modelClass, source: 'jsonl', ...usage });
}

interface Row {
  bucket_key: string;
  provider: string;
  model_class: string;
  calls: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cost_usd: number | null;
  rl_tokens_limit: string | null;
  rl_tokens_remaining: string | null;
  rl_reset_at: string | null;
}

/** Aggregate the recent samples (last `windowMs`) into the fleet read-model usage summary. */
export async function summarizeUsage(windowMs = 60 * 60 * 1000): Promise<UsageSummary> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const since = Date.now() - windowMs;
  // Per-bucket aggregate + the most-recent header sample (for usage% / reset) via DISTINCT ON.
  const rows = await sql<Row[]>`
    WITH agg AS (
      SELECT bucket_key, provider, model_class,
             COUNT(*) AS calls,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cost_usd, 0)) AS cost_usd
        FROM ${sql(TABLE)}
       WHERE workspace_id = ${ws} AND ts >= ${since}
       GROUP BY bucket_key, provider, model_class
    ),
    latest AS (
      SELECT DISTINCT ON (bucket_key) bucket_key, rl_tokens_limit, rl_tokens_remaining, rl_reset_at
        FROM ${sql(TABLE)}
       WHERE workspace_id = ${ws} AND ts >= ${since} AND rl_tokens_limit IS NOT NULL
       ORDER BY bucket_key, ts DESC
    )
    SELECT agg.*, latest.rl_tokens_limit, latest.rl_tokens_remaining, latest.rl_reset_at
      FROM agg LEFT JOIN latest USING (bucket_key)
     ORDER BY agg.bucket_key
  `;

  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let spendUsd = 0;
  const buckets: UsageBucketSummary[] = rows.map((r) => {
    const c = Number(r.calls);
    const it = Number(r.input_tokens ?? 0);
    const ot = Number(r.output_tokens ?? 0);
    const crt = Number(r.cache_read_tokens ?? 0);
    const cost = Number(r.cost_usd ?? 0);
    calls += c;
    inputTokens += it;
    outputTokens += ot;
    cacheReadTokens += crt;
    spendUsd += cost;
    const limit = r.rl_tokens_limit !== null ? Number(r.rl_tokens_limit) : null;
    const remaining = r.rl_tokens_remaining !== null ? Number(r.rl_tokens_remaining) : null;
    const usagePct =
      limit !== null && limit > 0 && remaining !== null ? Math.max(0, Math.min(100, (1 - remaining / limit) * 100)) : null;
    return {
      key: r.bucket_key,
      provider: r.provider,
      modelClass: r.model_class,
      calls: c,
      inputTokens: it,
      outputTokens: ot,
      cacheReadTokens: crt,
      spendUsd: cost,
      usagePct,
      rlResetAt: r.rl_reset_at !== null ? Number(r.rl_reset_at) : null,
    };
  });

  return { windowMs, calls, inputTokens, outputTokens, cacheReadTokens, spendUsd, buckets };
}
