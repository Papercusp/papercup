/**
 * summariseWorkspaceSubstrate — pure-logic workspace rollup.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reduces per-harness verdicts into a single workspace summary used by
 * tray badges, dashboard tiles, monitoring scripts, and the chrome
 * one-pill mode:
 *
 *   {
 *     enabled: boolean,
 *     totalHarnesses: number,
 *     healthy / degraded / unhealthy / booting / disabled counts,
 *     worstVerdict: SubstrateHealthVerdict,
 *   }
 *
 * The worst-verdict ranking matches SubstrateHealthPillClient so the
 * tray / chrome / dashboard show the same color the row-level pill
 * would.
 *
 * Pure logic — every input passed in. No PG, no FS, no fetch.
 */

import type { SubstrateHealthVerdict } from './health';

export interface HarnessHealthInput {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
}

export interface WorkspaceSubstrateSummary {
  enabled: boolean;
  totalHarnesses: number;
  healthy: number;
  booting: number;
  degraded: number;
  unhealthy: number;
  disabled: number;
  /**
   * Worst observed verdict across rows. When `enabled` is false and
   * no rows are present, the summary is `'disabled'`.
   */
  worstVerdict: SubstrateHealthVerdict;
}

const RANK: Record<SubstrateHealthVerdict, number> = {
  disabled: 0,
  healthy: 1,
  booting: 2,
  degraded: 3,
  unhealthy: 4,
};

const ZERO_COUNTS = {
  healthy: 0,
  booting: 0,
  degraded: 0,
  unhealthy: 0,
  disabled: 0,
} as const;

export function summariseWorkspaceSubstrate(
  flagEnabled: boolean,
  rows: ReadonlyArray<HarnessHealthInput>,
): WorkspaceSubstrateSummary {
  const counts = { ...ZERO_COUNTS };
  let worst: SubstrateHealthVerdict = flagEnabled ? 'healthy' : 'disabled';
  for (const r of rows) {
    counts[r.verdict] += 1;
    if (RANK[r.verdict] > RANK[worst]) worst = r.verdict;
  }
  if (rows.length === 0) {
    worst = flagEnabled ? 'booting' : 'disabled';
  }
  return {
    enabled: flagEnabled,
    totalHarnesses: rows.length,
    healthy: counts.healthy,
    booting: counts.booting,
    degraded: counts.degraded,
    unhealthy: counts.unhealthy,
    disabled: counts.disabled,
    worstVerdict: worst,
  };
}
