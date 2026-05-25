/**
 * assessHarnessSubstrateHealth — pure-logic combined health verdict.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 + papercusp-dogfood-phase5a-
 *       hyperbee-plumbing-2026-05-24.
 *
 * Aggregates the diagnostic surfaces into one verdict for monitoring,
 * alerts, and the admin / chrome surfaces:
 *
 *   {
 *     verdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy',
 *     reasons: string[],
 *   }
 *
 * Verdict ladder (worst wins):
 *   - 'disabled'  — substrate flag off, nothing to assess. Not an error.
 *   - 'booting'   — flag on but handle missing from boot map.
 *   - 'healthy'   — flag on, handle present, claim error rate < 5%.
 *   - 'degraded'  — flag on, handle present, claim error rate 5-25%.
 *   - 'unhealthy' — flag on, handle present, claim error rate > 25%
 *                   OR handle present but bootstrap-progress idle for
 *                   > staleThresholdMs with mergedOps still < highestSeen.
 *
 * Pure logic — every input is passed in. No fetch, no PG.
 */

export type SubstrateHealthVerdict =
  | 'disabled'
  | 'booting'
  | 'healthy'
  | 'degraded'
  | 'unhealthy';

export interface SubstrateHealthInputs {
  flagEnabled: boolean;
  /** Is the handle in the boot map for this (workspace, harness)? */
  handlePresent: boolean;
  claimStats?: {
    total: number;
    won: number;
    lost: number;
    error: number;
  };
  bootstrapProgress?: {
    mergedOps: number;
    highestSeen: number;
    lastChangeMs: number;
    caughtUp: boolean;
  } | null;
  /** Override for tests; defaults to Date.now(). */
  nowMs?: number;
  /** mergedOps lagging highestSeen for this long → unhealthy. Default 5m. */
  staleThresholdMs?: number;
  /** Error rate ≥ this → unhealthy. Default 0.25. */
  unhealthyErrorRate?: number;
  /** Error rate ≥ this (and < unhealthyErrorRate) → degraded. Default 0.05. */
  degradedErrorRate?: number;
}

export interface SubstrateHealthVerdictResult {
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

export function assessHarnessSubstrateHealth(
  inputs: SubstrateHealthInputs,
): SubstrateHealthVerdictResult {
  const reasons: string[] = [];
  if (!inputs.flagEnabled) {
    return { verdict: 'disabled', reasons: ['flag off'] };
  }
  if (!inputs.handlePresent) {
    return {
      verdict: 'booting',
      reasons: ['substrate handle missing from boot map'],
    };
  }

  const stale = inputs.staleThresholdMs ?? 5 * 60 * 1_000;
  const unhealthy = inputs.unhealthyErrorRate ?? 0.25;
  const degraded = inputs.degradedErrorRate ?? 0.05;
  const now = inputs.nowMs ?? Date.now();

  let verdict: SubstrateHealthVerdict = 'healthy';

  if (inputs.claimStats && inputs.claimStats.total > 0) {
    const rate = inputs.claimStats.error / inputs.claimStats.total;
    if (rate >= unhealthy) {
      verdict = 'unhealthy';
      reasons.push(
        `claim error rate ${(rate * 100).toFixed(1)}% ≥ ${(unhealthy * 100).toFixed(0)}%`,
      );
    } else if (rate >= degraded) {
      verdict = 'degraded';
      reasons.push(
        `claim error rate ${(rate * 100).toFixed(1)}% ≥ ${(degraded * 100).toFixed(0)}%`,
      );
    }
  }

  if (inputs.bootstrapProgress) {
    const { mergedOps, highestSeen, lastChangeMs, caughtUp } =
      inputs.bootstrapProgress;
    if (
      !caughtUp &&
      mergedOps < highestSeen &&
      now - lastChangeMs > stale
    ) {
      verdict = 'unhealthy';
      reasons.push(
        `bootstrap-progress stalled (${mergedOps}/${highestSeen}, idle ${Math.round(
          (now - lastChangeMs) / 1000,
        )}s)`,
      );
    }
  }

  if (verdict === 'healthy' && reasons.length === 0) {
    reasons.push('no issues detected');
  }
  return { verdict, reasons };
}
