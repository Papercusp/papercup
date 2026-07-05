/**
 * hive-canary-action.test.ts — tests for deadline tracking and enforcement
 */
import { describe, it, expect } from 'vitest';
import { planCanaryTick, canaryIdFor } from './hive-canary-action';
import type { CanaryFeatureRow } from './hive-canary-action';

describe('canaryIdFor', () => {
  it('generates correct date-based canary IDs', () => {
    const june11_2026 = new Date('2026-06-11').getTime();
    expect(canaryIdFor(june11_2026)).toBe('F-CANARY-20260611');

    const june12_2026 = new Date('2026-06-12').getTime();
    expect(canaryIdFor(june12_2026)).toBe('F-CANARY-20260612');
  });
});

describe('planCanaryTick', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();

  it('returns empty overdue list when no canaries exist', () => {
    const rows: CanaryFeatureRow[] = [];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
    expect(plan.queueId).toBe('F-CANARY-20260612');
  });

  it('excludes canaries with null payload', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago
        payload: null,
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('excludes canaries with canary_reported flag set', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago
        payload: { canary: true, canary_reported: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('excludes terminal canaries', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'passed',
        created_ts: now - 7 * 3600 * 1000,
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260610',
        status: 'failed',
        created_ts: now - 24 * 3600 * 1000,
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260609',
        status: 'deprecated',
        created_ts: now - 48 * 3600 * 1000,
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });

  it('identifies overdue canaries that are non-terminal and unreported', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 7 * 3600 * 1000, // 7 hours ago (overdue by 1h)
        payload: { canary: true },
      },
      {
        feature_id: 'F-CANARY-20260610',
        status: 'todo',
        created_ts: now - 25 * 3600 * 1000, // 25 hours ago (overdue by 19h)
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual(['F-CANARY-20260611', 'F-CANARY-20260610']);
  });

  it('respects deadline hours parameter', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 5 * 3600 * 1000, // 5 hours ago
        payload: { canary: true },
      },
    ];
    // With 6-hour deadline, should be overdue
    let plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]); // Not yet overdue

    // With 4-hour deadline, should be overdue
    plan = planCanaryTick(rows, { deadlineHours: 4, nowMs: now });
    expect(plan.overdue).toEqual(['F-CANARY-20260611']);
  });

  it('generates correct queue ID for today', () => {
    const rows: CanaryFeatureRow[] = [];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.queueId).toBe('F-CANARY-20260612');
  });

  it('EI-7420: suppresses overdue reports (never overdue) when isPaused — the Hive is owner-paused, not broken', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'todo',
        created_ts: now - 25 * 3600 * 1000, // 25 hours ago (overdue by 19h)
        payload: { canary: true },
      },
    ];
    const paused = planCanaryTick(rows, { deadlineHours: 6, nowMs: now, isPaused: true });
    expect(paused.overdue).toEqual([]);
    expect(paused.suppressed).toEqual(['F-CANARY-20260611']);

    // Same rows, unpaused, still reports as genuinely overdue.
    const unpaused = planCanaryTick(rows, { deadlineHours: 6, nowMs: now, isPaused: false });
    expect(unpaused.overdue).toEqual(['F-CANARY-20260611']);
    expect(unpaused.suppressed).toEqual([]);
  });

  it('caps overdue list at input array size', () => {
    const rows: CanaryFeatureRow[] = Array.from({ length: 10 }, (_, i) => ({
      feature_id: `F-CANARY-${String(20260601 + i).padStart(8, '0')}`,
      status: 'todo',
      created_ts: now - (8 + i) * 3600 * 1000,
      payload: { canary: true },
    }));
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue.length).toBeLessThanOrEqual(rows.length);
  });
});
