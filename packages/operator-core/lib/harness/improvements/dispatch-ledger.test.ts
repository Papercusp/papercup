/**
 * dispatch-ledger.test.ts — the PURE half of the dispatch ledger (consume-edges
 * P-010 / B-04): the stats rollup the watchdog-status tool + flow strip render,
 * and the overdue-threshold tunable. The PG halves (insert / fire-result /
 * close / orphan / read) are dispatch-ledger.integration.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  computeDispatchStats,
  dispatchOverdueAfterMs,
  type ImprovementDispatchRow,
} from './dispatch-ledger';

const NOW = Date.parse('2026-06-12T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
function row(p: Partial<ImprovementDispatchRow>): ImprovementDispatchRow {
  seq += 1;
  return {
    id: `d-${seq}`,
    workspaceId: 'ws-1',
    itemId: p.itemId ?? `EI-${seq}`,
    attempt: 1,
    runnerHarness: 'runner',
    firedAt: new Date(NOW - HOUR).toISOString(),
    fireResult: 'ok',
    fireError: null,
    spawnedRunId: null,
    outcome: null,
    resolvedAt: null,
    resolvedBy: null,
    ...p,
  };
}

describe('computeDispatchStats — disjoint buckets over the ledger', () => {
  it('classifies every row into exactly one bucket', () => {
    const rows = [
      row({}), // open, fresh, fired ok → inProgress
      row({ fireResult: 'pending' }), // open, fresh, fire not returned → firing
      row({ firedAt: new Date(NOW - 3 * HOUR).toISOString() }), // open past 2h default → overdue
      row({ outcome: 'fire-failed', fireResult: 'error', fireError: 'boom', resolvedAt: new Date(NOW - HOUR).toISOString() }),
      row({ outcome: 'orphaned', resolvedAt: new Date(NOW - HOUR).toISOString() }),
      row({ outcome: 'fixed', resolvedAt: new Date(NOW - HOUR).toISOString() }),
      row({ outcome: 'could-not-fix', resolvedAt: new Date(NOW - HOUR).toISOString() }),
      row({ outcome: 'needs-human', resolvedAt: new Date(NOW - HOUR).toISOString() }),
    ];
    const s = computeDispatchStats(rows, { nowMs: NOW });
    expect(s.total).toBe(8);
    expect(s.inProgress).toBe(1);
    expect(s.firing).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.fireFailed).toBe(1);
    expect(s.orphaned).toBe(1);
    expect(s.resolved).toEqual({ fixed: 1, couldNotFix: 1, needsHuman: 1 });
    const bucketSum =
      s.inProgress + s.firing + s.overdue + s.fireFailed + s.orphaned + s.resolved.fixed + s.resolved.couldNotFix + s.resolved.needsHuman;
    expect(bucketSum).toBe(s.total); // disjoint and exhaustive
  });

  it('an OLD pending row is overdue, not firing — a dispatcher that died mid-fire must not look in-flight forever', () => {
    const s = computeDispatchStats([row({ fireResult: 'pending', firedAt: new Date(NOW - 5 * HOUR).toISOString() })], {
      nowMs: NOW,
    });
    expect(s.overdue).toBe(1);
    expect(s.firing).toBe(0);
  });

  it('honors a custom overdue threshold', () => {
    const rows = [row({ firedAt: new Date(NOW - 30 * 60_000).toISOString() })];
    expect(computeDispatchStats(rows, { nowMs: NOW, overdueAfterMs: 60 * 60_000 }).inProgress).toBe(1);
    expect(computeDispatchStats(rows, { nowMs: NOW, overdueAfterMs: 15 * 60_000 }).overdue).toBe(1);
  });

  it('7d flows: fired7d counts recent fires; fixed7d counts recent fixes (by resolved_at) — older ones are stock, not flow', () => {
    const s = computeDispatchStats(
      [
        row({ firedAt: new Date(NOW - 2 * DAY).toISOString(), outcome: 'fixed', resolvedAt: new Date(NOW - 2 * DAY).toISOString() }),
        row({ firedAt: new Date(NOW - 10 * DAY).toISOString(), outcome: 'fixed', resolvedAt: new Date(NOW - 9 * DAY).toISOString() }),
        row({ firedAt: new Date(NOW - 8 * DAY).toISOString(), outcome: 'fixed', resolvedAt: new Date(NOW - DAY).toISOString() }),
      ],
      { nowMs: NOW },
    );
    expect(s.fired7d).toBe(1);
    expect(s.resolved.fixed).toBe(3); // stock
    expect(s.fixed7d).toBe(2); // the 9d-old resolve is outside the window
  });

  it('tracks the newest dispatch and the newest terminal transition', () => {
    const s = computeDispatchStats(
      [
        row({ firedAt: '2026-06-12T10:00:00.000Z' }),
        row({ firedAt: '2026-06-12T08:00:00.000Z', outcome: 'fixed', resolvedAt: '2026-06-12T11:00:00.000Z' }),
      ],
      { nowMs: NOW },
    );
    expect(s.lastDispatchAt).toBe('2026-06-12T10:00:00.000Z');
    expect(s.lastOutcomeAt).toBe('2026-06-12T11:00:00.000Z');
  });

  it('empty ledger → all-zero stats with null timestamps', () => {
    const s = computeDispatchStats([], { nowMs: NOW });
    expect(s.total).toBe(0);
    expect(s.lastDispatchAt).toBeNull();
    expect(s.lastOutcomeAt).toBeNull();
  });
});

describe('dispatchOverdueAfterMs — the overdue tunable', () => {
  const VAR = 'PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS';
  afterEach(() => {
    delete process.env[VAR];
    vi.restoreAllMocks();
  });

  it('defaults to 2h (aligned with the stale-claim window and the P-011 orphan threshold)', () => {
    expect(dispatchOverdueAfterMs()).toBe(7_200_000);
  });

  it('honors a valid override; rejects garbage and sub-minute values back to the default', () => {
    process.env[VAR] = '5400000';
    expect(dispatchOverdueAfterMs()).toBe(5_400_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[VAR] = 'soon';
    expect(dispatchOverdueAfterMs()).toBe(7_200_000);
    process.env[VAR] = '5';
    expect(dispatchOverdueAfterMs()).toBe(7_200_000);
  });
});
