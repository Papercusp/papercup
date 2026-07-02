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
  /**
   * Substrate-outbox DRAIN health (EI-1618). `undrainedCount` = rows with
   * `drained_at IS NULL` for this scope; `oldestUndrainedAgeMs` = age of the
   * oldest such row. A long-undrained outbox means content was CAPTURED but is
   * NOT federating — the silent-stall class (EI-681: harness booted but its
   * outbox never drains / it never joins the topic). Boot-health alone reports
   * such a harness as "healthy"; this input is what makes the stall visible.
   * Absent / null age = not measured (pure in-process callers without PG).
   */
  drainStats?: {
    undrainedCount: number;
    oldestUndrainedAgeMs: number | null;
  };
  /** oldest-undrained age ≥ this → at least `degraded`. Default 60s. */
  drainStalledThresholdMs?: number;
  /** oldest-undrained age ≥ this → `unhealthy`. Default 5m. */
  drainUnhealthyThresholdMs?: number;
  /**
   * WI-899 (A): SUBSTRATE_SIDECAR process liveness (from `probeSubstrateSidecar` in
   * service-health.ts), process-wide (NOT per-harness — one sidecar owns every
   * booted harness's engine). `true` = healthz answered; `false` = the sidecar is
   * DOWN — every harness's `handlePresent: true` (still the cached boot-time proxy)
   * is a LIE, so this forces `unhealthy` regardless of any other signal (worst-wins,
   * and the strongest possible override — a dead sidecar means NOTHING downstream of
   * it can be trusted). `undefined`/`null` = not measured / sidecar mode off — no
   * effect (never fabricates a verdict for a harness that boots in-process).
   */
  sidecarLive?: boolean | null;
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

  // EI-1618: a stuck outbox (captured-but-not-draining) means content silently
  // isn't federating. Boot-health alone reports such a harness "healthy"; surface
  // the stall here. Worst-wins (never upgrades an already-worse verdict).
  if (
    inputs.drainStats &&
    inputs.drainStats.undrainedCount > 0 &&
    inputs.drainStats.oldestUndrainedAgeMs != null
  ) {
    const drainStalled = inputs.drainStalledThresholdMs ?? 60 * 1_000;
    const drainUnhealthy = inputs.drainUnhealthyThresholdMs ?? 5 * 60 * 1_000;
    const ageMs = inputs.drainStats.oldestUndrainedAgeMs;
    const ageS = Math.round(ageMs / 1000);
    const n = inputs.drainStats.undrainedCount;
    if (ageMs >= drainUnhealthy) {
      verdict = 'unhealthy';
      reasons.push(
        `outbox STALLED: ${n} row(s) undrained for ${ageS}s — captured but not federating (EI-681 class)`,
      );
    } else if (ageMs >= drainStalled) {
      if (verdict === 'healthy') verdict = 'degraded';
      reasons.push(`outbox lagging: ${n} row(s) undrained for ${ageS}s`);
    }
  }

  // WI-899 (A): a confirmed-dead sidecar overrides every other signal — nothing
  // computed above (claim stats, bootstrap progress, drain) is trustworthy once the
  // process that actually owns replication is gone; the boot map still holding a
  // proxy handle for it is exactly the "reads healthy while dead" bug this closes.
  if (inputs.sidecarLive === false) {
    verdict = 'unhealthy';
    reasons.push('substrate sidecar is DOWN (healthz unreachable) — boot-time handle is stale');
  }

  if (verdict === 'healthy' && reasons.length === 0) {
    reasons.push('no issues detected');
  }
  return { verdict, reasons };
}
