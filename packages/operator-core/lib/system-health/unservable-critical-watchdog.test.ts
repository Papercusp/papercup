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
import { describe, it, expect, vi } from 'vitest';
import {
  scanUnservableCritical,
  runUnservableCriticalSweepOnce,
  UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS,
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
    // An oracle `refusedBy` label, not a locally-invented name (WI-2141964).
    floor: 'needs-owner-action',
    createdAtMs: NOW - 30 * DAY,
    lastWriteAtMs: NOW - 30 * DAY,
    ...over,
  };
}

describe('scanUnservableCritical — what is reported', () => {
  it('flags a stranded, untouched critical and reports both clocks', () => {
    const alerts = scanUnservableCritical([row({ itemId: 'WI-1' })], NOW);
    expect(alerts.map((a) => a.itemId)).toEqual(['WI-1']);
    expect(alerts[0].floor).toBe('needs-owner-action');
    expect(alerts[0].untouchedMs).toBe(30 * DAY);
    expect(alerts[0].itemAgeMs).toBe(30 * DAY);
  });

  it('flags a stranded critical on any structural floor, not just the two once hard-coded', () => {
    // The whole of WI-2141964: `claim-hold` and `not-claimable-status` were invisible to
    // the old `lane='observation' OR state='needs-human'` predicate, and accounted for
    // most of the 26 genuinely-stranded aged criticals it could not see.
    const alerts = scanUnservableCritical(
      [
        row({ itemId: 'EI-2', floor: 'observation-lane' }),
        row({ itemId: 'EI-3', floor: 'claim-hold' }),
        row({ itemId: 'EI-4', floor: 'not-claimable-status' }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.floor).sort()).toEqual([
      'claim-hold',
      'not-claimable-status',
      'observation-lane',
    ]);
  });

  it('reports longest-UNTOUCHED first — the most abandoned item is the likeliest real blocker', () => {
    const alerts = scanUnservableCritical(
      [
        row({ itemId: 'newer', lastWriteAtMs: NOW - 8 * DAY }),
        row({ itemId: 'stalest', lastWriteAtMs: NOW - 60 * DAY }),
        row({ itemId: 'middle', lastWriteAtMs: NOW - 20 * DAY }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.itemId)).toEqual(['stalest', 'middle', 'newer']);
  });

  it('REGRESSION (WI-2141964): an ANCIENT item written to recently is NOT reported', () => {
    // The creation basis this replaced would alarm on this row — it is 200 days old — even
    // though somebody wrote to it yesterday, i.e. it is actively being handled. That false
    // positive is half of why the live alert volume had drifted to 24 from the 5 this
    // watchdog was tuned for. The stranding signal is ABANDONMENT, which is what this
    // file's own header always claimed ("NOBODY EVER WROTE TO IT AGAIN").
    const ancientButActive = row({
      itemId: 'being-worked',
      createdAtMs: NOW - 200 * DAY,
      lastWriteAtMs: NOW - 1 * DAY,
    });
    expect(scanUnservableCritical([ancientButActive], NOW)).toEqual([]);

    // CALIBRATION: the same row, abandoned, IS reported — so the empty result above is the
    // last-write basis discriminating, not the classifier being inert.
    const ancientAndAbandoned = row({
      itemId: 'being-worked',
      createdAtMs: NOW - 200 * DAY,
      lastWriteAtMs: NOW - 30 * DAY,
    });
    expect(scanUnservableCritical([ancientAndAbandoned], NOW).map((a) => a.itemId)).toEqual([
      'being-worked',
    ]);
  });

  it('CALIBRATION: a critical touched more recently than the floor is not reported', () => {
    const justUnder = row({
      itemId: 'fresh',
      lastWriteAtMs: NOW - (UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS - 1),
    });
    expect(scanUnservableCritical([justUnder], NOW)).toEqual([]);
    // ...and the SAME row one millisecond staler is reported, so the empty result
    // above is the threshold working rather than the classifier being inert.
    const justOver = row({
      itemId: 'fresh',
      lastWriteAtMs: NOW - UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS,
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
    expect(UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS).toBeGreaterThan(0);
    expect(UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS).toBeLessThan(30 * DAY);
    // 19 days untouched — the filed instance's own shape (cup:spawn, hidden 19 days).
    const realistic = row({
      itemId: 'real',
      createdAtMs: NOW - 19 * DAY,
      lastWriteAtMs: NOW - 19 * DAY,
    });
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
        row({ itemId: 'recently-touched', createdAtMs: NOW - 1 * DAY, lastWriteAtMs: NOW - 1 * DAY }),
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
