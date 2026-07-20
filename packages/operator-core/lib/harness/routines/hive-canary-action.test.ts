/**
 * hive-canary-action.test.ts — tests for deadline tracking and enforcement
 */
import { describe, it, expect } from 'vitest';
import { planCanaryTick, planCanarySlaCheck, isCanaryTerminal, canaryIdFor } from './hive-canary-action';
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

describe('isCanaryTerminal (EI-18170: post-status-unify terminal set)', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();
  it('treats the unified work-item terminal states (done/dropped) as terminal', () => {
    // The pre-fix bug: a cup now COMPLETES a canary to `done`, but `done`/`dropped`
    // were absent from the terminal set, so a SUCCEEDED canary read as non-terminal
    // and the daily 6h check would falsely re-report + deprecate every completed
    // canary older than the deadline.
    expect(isCanaryTerminal('done')).toBe(true);
    expect(isCanaryTerminal('dropped')).toBe(true);
  });

  it('still treats the legacy feature terminal spellings as terminal', () => {
    for (const s of ['passed', 'failed', 'deprecated', 'resolved', 'closed']) {
      expect(isCanaryTerminal(s)).toBe(true);
    }
  });

  it('treats in-flight states as non-terminal', () => {
    for (const s of ['open', 'todo', 'wip', 'blocked']) {
      expect(isCanaryTerminal(s)).toBe(false);
    }
  });

  it('a done canary is NOT overdue for the daily check (regression guard for the false-deprecate bug)', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260611',
        status: 'done', // completed by a cup, well past any deadline
        created_ts: now - 25 * 3600 * 1000,
        payload: { canary: true },
      },
    ];
    const plan = planCanaryTick(rows, { deadlineHours: 6, nowMs: now });
    expect(plan.overdue).toEqual([]);
  });
});

describe('planCanarySlaCheck (EI-18170: fast completion-SLA sweep)', () => {
  const now = new Date('2026-06-12T15:00:00Z').getTime();

  it('returns empty when no canaries exist', () => {
    const plan = planCanarySlaCheck([], { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
    expect(plan.suppressed).toEqual([]);
  });

  it('flags a canary older than the SLA that is still non-terminal', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 45 * 60 * 1000, // 45 min ago — past a 30-min SLA
        payload: { canary: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual(['F-CANARY-20260612']);
  });

  it('does NOT flag a canary still inside its SLA window', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 20 * 60 * 1000, // 20 min ago — inside a 30-min SLA
        payload: { canary: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('excludes terminal canaries — including the unified `done` (a completed canary never alarms)', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-DONE', status: 'done', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
      { feature_id: 'F-DEP', status: 'deprecated', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('excludes canaries already SLA-reported (idempotent — one alarm per canary)', () => {
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 90 * 60 * 1000,
        payload: { canary: true, canary_sla_reported: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('is INDEPENDENT of the daily canary_reported stamp — still alarms when only canary_reported is set', () => {
    // Proves the two detectors dedup on separate stamps: a canary the daily check
    // already flagged (canary_reported) but that is somehow still open + un-SLA-
    // reported must still fire the fast alarm.
    const rows: CanaryFeatureRow[] = [
      {
        feature_id: 'F-CANARY-20260612',
        status: 'open',
        created_ts: now - 90 * 60 * 1000,
        payload: { canary: true, canary_reported: true },
      },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual(['F-CANARY-20260612']);
  });

  it('excludes canaries with null payload', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-CANARY-20260612', status: 'open', created_ts: now - 90 * 60 * 1000, payload: null },
    ];
    const plan = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now });
    expect(plan.breaching).toEqual([]);
  });

  it('defaults to a 30-minute SLA when slaMinutes is omitted', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-IN', status: 'open', created_ts: now - 25 * 60 * 1000, payload: { canary: true } },
      { feature_id: 'F-OUT', status: 'open', created_ts: now - 35 * 60 * 1000, payload: { canary: true } },
    ];
    const plan = planCanarySlaCheck(rows, { nowMs: now });
    expect(plan.breaching).toEqual(['F-OUT']);
  });

  it('EI-7420: suppresses SLA breaches (never breaching) when isPaused — an owner pause is not a broken loop', () => {
    const rows: CanaryFeatureRow[] = [
      { feature_id: 'F-CANARY-20260612', status: 'open', created_ts: now - 90 * 60 * 1000, payload: { canary: true } },
    ];
    const paused = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now, isPaused: true });
    expect(paused.breaching).toEqual([]);
    expect(paused.suppressed).toEqual(['F-CANARY-20260612']);

    const unpaused = planCanarySlaCheck(rows, { slaMinutes: 30, nowMs: now, isPaused: false });
    expect(unpaused.breaching).toEqual(['F-CANARY-20260612']);
    expect(unpaused.suppressed).toEqual([]);
  });
});
