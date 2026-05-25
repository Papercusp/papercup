/**
 * assessHarnessSubstrateHealth tests.
 */

import { describe, expect, it } from 'vitest';
import { assessHarnessSubstrateHealth } from '../health';

describe('assessHarnessSubstrateHealth', () => {
  it('flag off → disabled', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: false,
      handlePresent: false,
    });
    expect(r.verdict).toBe('disabled');
    expect(r.reasons).toContain('flag off');
  });

  it('flag on, handle missing → booting', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: false,
    });
    expect(r.verdict).toBe('booting');
  });

  it('handle present, no stats → healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
    });
    expect(r.verdict).toBe('healthy');
    expect(r.reasons).toEqual(['no issues detected']);
  });

  it('low claim error rate (<5%) → healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 96, lost: 3, error: 1 },
    });
    expect(r.verdict).toBe('healthy');
  });

  it('claim error rate 5-25% → degraded', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 80, lost: 10, error: 10 },
    });
    expect(r.verdict).toBe('degraded');
    expect(r.reasons[0]).toContain('claim error rate');
  });

  it('claim error rate ≥25% → unhealthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 50, lost: 20, error: 30 },
    });
    expect(r.verdict).toBe('unhealthy');
  });

  it('bootstrap stalled past threshold → unhealthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 0,
        caughtUp: false,
      },
      nowMs: 600_000, // 10 minutes
      staleThresholdMs: 300_000, // 5 minutes
    });
    expect(r.verdict).toBe('unhealthy');
    expect(r.reasons.some((m) => m.includes('stalled'))).toBe(true);
  });

  it('bootstrap caught up doesnt trigger stall path', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 10,
        highestSeen: 10,
        lastChangeMs: 0,
        caughtUp: true,
      },
      nowMs: 10_000_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('healthy');
  });

  it('bootstrap recent activity not stalled', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 9_000_000,
        caughtUp: false,
      },
      nowMs: 9_010_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('healthy');
  });

  it('claim error rate beats bootstrap stall (worst wins)', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 60, lost: 5, error: 35 },
      bootstrapProgress: {
        mergedOps: 5,
        highestSeen: 10,
        lastChangeMs: 9_000_000,
        caughtUp: false,
      },
      nowMs: 9_100_000,
      staleThresholdMs: 300_000,
    });
    expect(r.verdict).toBe('unhealthy');
  });

  it('respects custom degraded threshold', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 100, won: 99, lost: 0, error: 1 },
      degradedErrorRate: 0.01,
      unhealthyErrorRate: 0.5,
    });
    expect(r.verdict).toBe('degraded');
  });

  it('claim stats with total=0 stays healthy', () => {
    const r = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      claimStats: { total: 0, won: 0, lost: 0, error: 0 },
    });
    expect(r.verdict).toBe('healthy');
  });
});
