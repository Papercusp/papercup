import { describe, expect, it } from 'vitest';
import {
  aggregateOpCounts,
  countActiveAutoloops,
  tallyDirectiveStatuses,
} from './all-kpis-aggregate';

describe('tallyDirectiveStatuses', () => {
  it('counts pending as open and everything else as acknowledged', () => {
    expect(
      tallyDirectiveStatuses([
        { status: 'pending', n: 3 },
        { status: 'acked', n: 5 },
        { status: 'dismissed', n: 2 },
      ]),
    ).toEqual({ open: 3, acknowledged: 7 });
  });

  it('treats an unrecognized future status as acknowledged, not dropped', () => {
    expect(tallyDirectiveStatuses([{ status: 'snoozed', n: 4 }])).toEqual({
      open: 0,
      acknowledged: 4,
    });
  });

  it('returns zeros for no rows', () => {
    expect(tallyDirectiveStatuses([])).toEqual({ open: 0, acknowledged: 0 });
  });
});

describe('aggregateOpCounts', () => {
  it('sums per-op counts and computes a grand total', () => {
    expect(
      aggregateOpCounts([
        { op: 'create', n: 2 },
        { op: 'update', n: 5 },
        { op: 'create', n: 1 },
      ]),
    ).toEqual({ total: 8, byOp: { create: 3, update: 5 } });
  });

  it('returns an empty breakdown for no rows', () => {
    expect(aggregateOpCounts([])).toEqual({ total: 0, byOp: {} });
  });
});

describe('countActiveAutoloops', () => {
  it('counts ok and firing as active', () => {
    expect(
      countActiveAutoloops([
        { last_status: 'ok' },
        { last_status: 'firing' },
        { last_status: 'error: timeout' },
        { last_status: null },
      ]),
    ).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(countActiveAutoloops([])).toBe(0);
  });

  it('returns 0 when nothing is ok or firing', () => {
    expect(countActiveAutoloops([{ last_status: 'error' }, { last_status: null }])).toBe(0);
  });
});
