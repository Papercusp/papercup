/**
 * loadHarnessSpend — Insights SpendCard data source (Tier D).
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073f real-data follow-up).
 *
 * Reads harness_shared.tool_invocations for the harness and computes:
 *   - harnessTotalUsdThisWeek (sum across all contributors)
 *   - viewerUsdThisWeek        (sum for viewer's github_user_id)
 *
 * Pure logic — injectable runQuery. Defensive: missing table yields
 * zeros so the card renders the empty state rather than 500-ing.
 *
 * Cost units: tool_invocations stores `cost_microcents` (1/1_000_000
 * of a dollar). Divide by 1_000_000 to get USD.
 */

import type { SpendCardProps } from '../../app/harness/insights/SpendCard';

export interface LoadHarnessSpendOpts {
  harness_slug: string;
  viewer_github_user_id: number;
  windowMs?: number;
  /** Optional href for the proxy-witness deferral explainer. */
  proxyWitnessExplainerHref?: string | null;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface SumRow {
  sum: string | number | null;
}

async function sumMicrocents(
  runQuery: LoadHarnessSpendOpts['runQuery'],
  query: string,
  params: unknown[],
): Promise<number> {
  try {
    const rows = await runQuery<SumRow>(query, params);
    const v = rows[0]?.sum;
    if (v == null) return 0;
    const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function loadHarnessSpend(
  opts: LoadHarnessSpendOpts,
): Promise<SpendCardProps> {
  const { harness_slug, viewer_github_user_id, runQuery } = opts;
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const windowStart = Date.now() - windowMs;

  const totalMicro = await sumMicrocents(
    runQuery,
    `SELECT COALESCE(SUM(cost_microcents), 0) AS sum
       FROM harness_shared.tool_invocations
      WHERE harness_slug = $1
        AND ts >= $2`,
    [harness_slug, windowStart],
  );
  const viewerMicro = await sumMicrocents(
    runQuery,
    `SELECT COALESCE(SUM(cost_microcents), 0) AS sum
       FROM harness_shared.tool_invocations
      WHERE harness_slug = $1
        AND user_id_text = $2
        AND ts >= $3`,
    [harness_slug, String(viewer_github_user_id), windowStart],
  );

  return {
    harnessTotalUsdThisWeek: totalMicro / 1_000_000,
    viewerUsdThisWeek: viewerMicro / 1_000_000,
    proxyWitnessExplainerHref: opts.proxyWitnessExplainerHref ?? null,
  };
}
