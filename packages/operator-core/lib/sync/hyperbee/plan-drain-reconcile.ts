/**
 * plan-drain-reconcile — WI-254 (EI-1618 item 2): the PURE detection core of the
 * periodic federation-drain reconcile.
 *
 * EI-1618's on-READ surface (federation-status route + the desktop) flips a
 * harness off "healthy" when its `substrate_outbox` is undrained past threshold —
 * but only when something READS it. WI-254 adds the proactive half: a routine
 * tick reconciles the drain state of the LIVE booted harnesses and flags any that
 * are stalled, so a silent-federation stall (the EI-681 class: captured but not
 * federating) is caught without a reader, and is surfaced BEFORE the
 * substrate-outbox-backstop-GC drops the undrained-orphaned rows.
 *
 * This module is PURE (no PG, no registry, no side effects) so the stall logic is
 * unit-testable in isolation — the action wrapper (federation-drain-reconcile-
 * action.ts) feeds it `load-drain-stats` output over `listBootedHandles()` and
 * raises the deduped alert. Thresholds mirror `assessHarnessSubstrateHealth`'s
 * drain ladder (60s degraded / 5m unhealthy) so the routine and the on-read
 * verdict agree on what "stalled" means.
 */
import type { SubstrateDrainStat } from './load-drain-stats';

/** Oldest-undrained age (ms) past which an outbox counts as stalled (≥ this →
 *  degraded). Mirrors `assessHarnessSubstrateHealth`'s drainStalledThresholdMs. */
export const DRAIN_STALLED_MS = 60_000;
/** Oldest-undrained age (ms) past which a stall is unhealthy (≥ this → unhealthy).
 *  Mirrors `assessHarnessSubstrateHealth`'s drainUnhealthyThresholdMs. */
export const DRAIN_UNHEALTHY_MS = 5 * 60_000;

/** One booted harness's drain state, as the action gathers it. */
export interface DrainReconcileInput {
  workspaceId: string;
  harnessSlug: string;
  drain: SubstrateDrainStat;
}

/** A flagged stall — one booted harness whose outbox is captured-but-not-federating. */
export interface DrainStallFlag {
  workspaceId: string;
  harnessSlug: string;
  undrainedCount: number;
  /** Non-null + ≥ DRAIN_STALLED_MS by construction. */
  oldestUndrainedAgeMs: number;
  severity: 'degraded' | 'unhealthy';
}

export interface PlanDrainReconcileOpts {
  stalledMs?: number;
  unhealthyMs?: number;
}

/**
 * Pure tick planning: which booted harnesses are stalled (undrained rows whose
 * oldest age ≥ the stall threshold). Only flags a harness with `undrainedCount > 0`
 * AND a measured `oldestUndrainedAgeMs ≥ stalledMs` — a harness with a
 * briefly-undrained outbox (rows between the capture and the next drain tick) or a
 * fully-drained outbox is NOT flagged. Severity escalates to `unhealthy` at the
 * 5-minute mark, matching the on-read verdict.
 *
 * NB the input is expected to cover only LIVE booted harnesses (the action maps
 * over listBootedHandles) — dead/test hive slugs are never booted, so they never
 * reach here; their undrained debris is the GC's concern (infra-fail-fast C2), not
 * a federation-stall alert. That is the natural detection/remediation seam.
 */
export function planDrainReconcile(
  inputs: DrainReconcileInput[],
  opts: PlanDrainReconcileOpts = {},
): DrainStallFlag[] {
  const stalledMs = opts.stalledMs ?? DRAIN_STALLED_MS;
  const unhealthyMs = opts.unhealthyMs ?? DRAIN_UNHEALTHY_MS;
  const flags: DrainStallFlag[] = [];
  for (const i of inputs) {
    const { undrainedCount, oldestUndrainedAgeMs } = i.drain;
    if (
      undrainedCount > 0 &&
      oldestUndrainedAgeMs != null &&
      oldestUndrainedAgeMs >= stalledMs
    ) {
      flags.push({
        workspaceId: i.workspaceId,
        harnessSlug: i.harnessSlug,
        undrainedCount,
        oldestUndrainedAgeMs,
        severity: oldestUndrainedAgeMs >= unhealthyMs ? 'unhealthy' : 'degraded',
      });
    }
  }
  return flags;
}

/** Stable dedup key for one harness's stall — one captureImprovement per stalled
 *  harness (refiled only when it clears + recurs), never one alert per tick. */
export function drainStallWatchdogKey(workspaceId: string, harnessSlug: string): string {
  return `federation-drain-stall:${workspaceId}:${harnessSlug}`;
}
