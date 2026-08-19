/**
 * Tests for unservable-critical-watchdog (EI-19919820196426791 half 2).
 *
 * The two constants under test — the severity set and the age floor — decide this
 * watchdog's ENTIRE alert volume, and getting either wrong reproduces the failure
 * it exists to prevent (a 57-alert first tick trains every reader to ignore it).
 * So the severity narrowing is pinned by a CONTROL that shows the filed
 * critical-OR-major rule cannot separate the populations, and by a CALIBRATION
 * case proving the guard still fires on the thing it is for.
 */
import { describe, it, expect } from 'vitest';
import {
  scanUnservableCritical,
  runUnservableCriticalSweepOnce,
  UNSERVABLE_CRITICAL_MIN_AGE_MS,
  UNSERVABLE_REPORTED_SEVERITIES,
  type UnservableItemRow,
} from './unservable-critical-watchdog';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

function row(over: Partial<UnservableItemRow> & Pick<UnservableItemRow, 'itemId'>): UnservableItemRow {
  return {
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    title: 'a stranded thing',
    severity: 'critical',
    floor: 'needs-human',
    createdAtMs: NOW - 30 * DAY,
    ...over,
  };
}

describe('scanUnservableCritical — what is reported', () => {
  it('flags an aged critical in the needs-human floor', () => {
    const alerts = scanUnservableCritical([row({ itemId: 'WI-1' })], NOW);
    expect(alerts.map((a) => a.itemId)).toEqual(['WI-1']);
    expect(alerts[0].floor).toBe('needs-human');
    expect(alerts[0].ageMs).toBe(30 * DAY);
  });

  it('flags an aged critical in the observation lane', () => {
    const alerts = scanUnservableCritical(
      [row({ itemId: 'EI-2', floor: 'observation-lane' })],
      NOW,
    );
    expect(alerts.map((a) => a.itemId)).toEqual(['EI-2']);
    expect(alerts[0].floor).toBe('observation-lane');
  });

  it('reports oldest first — the longest-stranded item is the likeliest real blocker', () => {
    const alerts = scanUnservableCritical(
      [
        row({ itemId: 'newer', createdAtMs: NOW - 8 * DAY }),
        row({ itemId: 'oldest', createdAtMs: NOW - 60 * DAY }),
        row({ itemId: 'middle', createdAtMs: NOW - 20 * DAY }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.itemId)).toEqual(['oldest', 'middle', 'newer']);
  });

  it('CALIBRATION: a critical YOUNGER than the age floor is not reported', () => {
    const justUnder = row({
      itemId: 'fresh',
      createdAtMs: NOW - (UNSERVABLE_CRITICAL_MIN_AGE_MS - 1),
    });
    expect(scanUnservableCritical([justUnder], NOW)).toEqual([]);
    // ...and the SAME row one millisecond older is reported, so the empty result
    // above is the age floor working rather than the classifier being inert.
    const justOver = row({
      itemId: 'fresh',
      createdAtMs: NOW - UNSERVABLE_CRITICAL_MIN_AGE_MS,
    });
    expect(scanUnservableCritical([justOver], NOW).map((a) => a.itemId)).toEqual(['fresh']);
  });

  it('does NOT report major — the filed critical-OR-major spec was measured as noise', () => {
    // 2026-08-19, live papercusp backlog, non-terminal, past 7 days:
    //   critical only .....  5 rows
    //   critical OR major .. 57 rows
    // 57 open escalations is a backlog listing, and the reader stops looking —
    // which IS the failure this watchdog exists to prevent. If you widen this,
    // widen it against a FRESH measurement, not against the filed prose.
    const majors = [
      row({ itemId: 'M-1', severity: 'major' }),
      row({ itemId: 'M-2', severity: 'major', floor: 'observation-lane' }),
    ];
    expect(scanUnservableCritical(majors, NOW)).toEqual([]);
    expect(UNSERVABLE_REPORTED_SEVERITIES).toEqual(['critical']);
  });

  it('CONTROL: the filed critical-OR-major rule provably cannot separate the two populations', () => {
    const mixed = [
      row({ itemId: 'crit', severity: 'critical' }),
      row({ itemId: 'maj', severity: 'major' }),
    ];
    // The shipped rule separates them...
    expect(scanUnservableCritical(mixed, NOW).map((a) => a.itemId)).toEqual(['crit']);
    // ...while the rule as FILED admits both, which is the 57-row outcome.
    const asFiled = scanUnservableCritical(mixed, NOW, { severities: ['critical', 'major'] });
    expect(asFiled.map((a) => a.itemId).sort()).toEqual(['crit', 'maj']);
  });

  it('ANTI-VACUITY: the shipped thresholds are non-degenerate', () => {
    // A severity set that matched nothing, or an age floor beyond any real item,
    // would make every assertion above pass while the watchdog never fired in
    // production. Pin both against a row that MUST be reported.
    expect(UNSERVABLE_REPORTED_SEVERITIES.length).toBeGreaterThan(0);
    expect(UNSERVABLE_CRITICAL_MIN_AGE_MS).toBeGreaterThan(0);
    expect(UNSERVABLE_CRITICAL_MIN_AGE_MS).toBeLessThan(30 * DAY);
    const realistic = row({ itemId: 'real', createdAtMs: NOW - 19 * DAY });
    expect(scanUnservableCritical([realistic], NOW)).toHaveLength(1);
  });
});

describe('runUnservableCriticalSweepOnce', () => {
  const sql = {} as never;

  it('is a REAL kill-switch when the flag is off — it does not even read rows', async () => {
    let read = 0;
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => false,
      readRows: async () => {
        read += 1;
        return [row({ itemId: 'WI-1' })];
      },
      escalate: async () => {
        throw new Error('must not escalate while disabled');
      },
      now: () => NOW,
    });
    expect(res).toEqual({ scanned: 0, escalated: 0, failed: 0, skipped: true });
    expect(read).toBe(0);
  });

  it('escalates each stranded item', async () => {
    const seen: string[] = [];
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [row({ itemId: 'WI-1' }), row({ itemId: 'WI-2' })],
      escalate: async (a) => {
        seen.push(a.itemId);
      },
      now: () => NOW,
    });
    expect(seen).toEqual(['WI-1', 'WI-2']);
    expect(res).toMatchObject({ scanned: 2, escalated: 2, failed: 0, skipped: false });
  });

  it('one failing escalate does not abort the batch — the rest still report, and the failure is logged not swallowed', async () => {
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [
        row({ itemId: 'bad', createdAtMs: NOW - 60 * DAY }),
        row({ itemId: 'good', createdAtMs: NOW - 20 * DAY }),
      ],
      escalate: async (a) => {
        if (a.itemId === 'bad') throw new Error('escalation surface down');
        seen.push(a.itemId);
      },
      now: () => NOW,
    });
    expect(seen).toEqual(['good']);
    expect(res).toMatchObject({ scanned: 2, escalated: 1, failed: 1, skipped: false });
    // A silently-dropped escalation would leave the stranded item invisible AND
    // leave no trace that it was meant to be reported — assert the warning names
    // the item, so a future refactor cannot quietly swallow it.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('bad');
    warn.mockRestore();
  });

  it('rows that do not meet the thresholds are scanned but not escalated', async () => {
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [
        row({ itemId: 'young', createdAtMs: NOW - 1 * DAY }),
        row({ itemId: 'major', severity: 'major' }),
      ],
      escalate: async () => {
        throw new Error('must not escalate a row below threshold');
      },
      now: () => NOW,
    });
    expect(res).toMatchObject({ scanned: 2, escalated: 0, failed: 0, skipped: false });
  });
});
