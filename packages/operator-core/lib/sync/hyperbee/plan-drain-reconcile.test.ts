/**
 * plan-drain-reconcile.test.ts — WI-254 (EI-1618 item 2).
 *
 * The pure detection core of the periodic federation-drain reconcile: which LIVE
 * booted harnesses are stalled (outbox captured-but-not-federating). Assertions
 * are teeth-shaped — neuter the threshold or the undrained guard and a case goes
 * RED. Thresholds mirror assessHarnessSubstrateHealth (60s degraded / 5m unhealthy)
 * so the routine and the on-read federation-status verdict agree.
 */
import { describe, it, expect } from 'vitest';
import {
  planDrainReconcile,
  drainStallWatchdogKey,
  DRAIN_STALLED_MS,
  DRAIN_UNHEALTHY_MS,
  type DrainReconcileInput,
} from './plan-drain-reconcile';

const inp = (
  harnessSlug: string,
  undrainedCount: number,
  oldestUndrainedAgeMs: number | null,
  workspaceId = 'ws',
): DrainReconcileInput => ({
  workspaceId,
  harnessSlug,
  drain: { undrainedCount, oldestUndrainedAgeMs },
});

describe('planDrainReconcile', () => {
  it('flags a stalled harness (undrained > 0, oldest age ≥ 60s) as degraded', () => {
    const flags = planDrainReconcile([inp('a', 4, 90_000)]);
    expect(flags).toEqual([
      { workspaceId: 'ws', harnessSlug: 'a', undrainedCount: 4, oldestUndrainedAgeMs: 90_000, severity: 'degraded' },
    ]);
  });

  it('escalates to unhealthy at the 5-minute mark', () => {
    const flags = planDrainReconcile([inp('b', 12, 6 * 60_000)]);
    expect(flags[0].severity).toBe('unhealthy');
  });

  it('does NOT flag a briefly-undrained outbox (< 60s) — transient drain, not a stall', () => {
    expect(planDrainReconcile([inp('fresh', 3, 5_000)])).toEqual([]);
  });

  it('does NOT flag a fully-drained outbox (0 undrained)', () => {
    expect(planDrainReconcile([inp('clean', 0, null)])).toEqual([]);
  });

  it('does NOT flag when age is unmeasured (null) even with undrained rows', () => {
    expect(planDrainReconcile([inp('n', 5, null)])).toEqual([]);
  });

  it('returns only the stalled harnesses from a mixed list', () => {
    const flags = planDrainReconcile([
      inp('clean', 0, null),
      inp('fresh', 2, 10_000),
      inp('stalled', 7, 120_000),
      inp('dead', 99, 9 * 60_000),
    ]);
    expect(flags.map((f) => f.harnessSlug)).toEqual(['stalled', 'dead']);
    expect(flags.find((f) => f.harnessSlug === 'dead')?.severity).toBe('unhealthy');
  });

  it('threshold boundary is inclusive at exactly DRAIN_STALLED_MS, exclusive just below', () => {
    expect(planDrainReconcile([inp('edge', 1, DRAIN_STALLED_MS)])).toHaveLength(1); // ≥ → flagged
    expect(planDrainReconcile([inp('under', 1, DRAIN_STALLED_MS - 1)])).toEqual([]); // < → not
  });

  it('unhealthy boundary is inclusive at exactly DRAIN_UNHEALTHY_MS', () => {
    expect(planDrainReconcile([inp('u', 1, DRAIN_UNHEALTHY_MS)])[0].severity).toBe('unhealthy');
    expect(planDrainReconcile([inp('d', 1, DRAIN_UNHEALTHY_MS - 1)])[0].severity).toBe('degraded');
  });

  it('honours overridden thresholds', () => {
    expect(planDrainReconcile([inp('x', 1, 30_000)], { stalledMs: 20_000 })).toHaveLength(1);
    expect(planDrainReconcile([inp('x', 1, 30_000)], { stalledMs: 40_000 })).toEqual([]);
  });
});

describe('drainStallWatchdogKey', () => {
  it('is stable per (workspace, harness) — one captureImprovement per stall, not per tick', () => {
    expect(drainStallWatchdogKey('ws-1', 'papercup')).toBe('federation-drain-stall:ws-1:papercup');
    expect(drainStallWatchdogKey('ws-1', 'papercup')).toBe(drainStallWatchdogKey('ws-1', 'papercup'));
    expect(drainStallWatchdogKey('ws-1', 'a')).not.toBe(drainStallWatchdogKey('ws-1', 'b'));
  });
});
