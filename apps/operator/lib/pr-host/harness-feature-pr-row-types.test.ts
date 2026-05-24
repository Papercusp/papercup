import { describe, expect, it } from 'vitest';
import {
  P_042_ADDED_COLUMNS,
  STALE_POLL_THRESHOLD_MS,
  defaultRowForNewPr,
  demoteRowToGone,
  hasBeenPolled,
  isHarnessFeaturePrRow,
  isPollStale,
  prToRow,
  type HarnessFeaturePrRow,
  type PrUpdateSlice,
} from './harness-feature-pr-row-types';

function makeRow(over: Partial<HarnessFeaturePrRow> = {}): HarnessFeaturePrRow {
  return {
    workspace_id: 'ws1',
    harness_slug: 'papercup',
    feature_id: 'F-001',
    pr_url: 'https://github.com/x/y/pull/1',
    pr_state: 'open',
    opened_ts: 1716_000_000_000,
    updated_ts: 1716_000_001_000,
    last_polled_at_ts: 1716_000_002_000,
    checks_status: 'success',
    mergeable_state: 'mergeable',
    review_decision: 'none',
    reviewers: [],
    ...over,
  };
}

function makePrSlice(over: Partial<PrUpdateSlice> = {}): PrUpdateSlice {
  return {
    ref: { remote: 'github.com/x/y', number: 1 },
    state: 'open',
    review_decision: 'approved',
    checks_state: 'success',
    mergeable_state: 'mergeable',
    reviewers_requested: [{ github_user_id: 200, github_login: 'bob' }],
    updated_at: 1716_000_010_000,
    url: 'https://github.com/x/y/pull/1',
    ...over,
  };
}

describe('prToRow', () => {
  it('builds a row from a Pr + identity', () => {
    const row = prToRow({
      workspace_id: 'ws1',
      harness_slug: 'papercup',
      feature_id: 'F-001',
      opened_ts: 1716_000_000_000,
      pr: makePrSlice(),
      now: 1716_000_020_000,
    });
    expect(row.pr_state).toBe('open');
    expect(row.review_decision).toBe('approved');
    expect(row.checks_status).toBe('success');
    expect(row.mergeable_state).toBe('mergeable');
    expect(row.reviewers).toEqual([{ github_user_id: 200, github_login: 'bob' }]);
    expect(row.last_polled_at_ts).toBe(1716_000_020_000);
    expect(row.opened_ts).toBe(1716_000_000_000);
    expect(row.updated_ts).toBe(1716_000_010_000);
  });

  it('preserves opened_ts across polls (caller is responsible)', () => {
    const row1 = prToRow({
      workspace_id: 'ws1',
      harness_slug: 'h',
      feature_id: 'F-1',
      opened_ts: 100,
      pr: makePrSlice({ updated_at: 200 }),
      now: 300,
    });
    const row2 = prToRow({
      workspace_id: 'ws1',
      harness_slug: 'h',
      feature_id: 'F-1',
      opened_ts: row1.opened_ts,
      pr: makePrSlice({ updated_at: 400 }),
      now: 500,
    });
    expect(row2.opened_ts).toBe(100);
    expect(row2.updated_ts).toBe(400);
    expect(row2.last_polled_at_ts).toBe(500);
  });

  it('defensive-copies the reviewers array', () => {
    const reviewers = [{ github_user_id: 1, github_login: 'a' }];
    const row = prToRow({
      workspace_id: 'w',
      harness_slug: 'h',
      feature_id: 'F-1',
      opened_ts: 1,
      pr: makePrSlice({ reviewers_requested: reviewers }),
      now: 2,
    });
    reviewers.push({ github_user_id: 2, github_login: 'b' });
    expect(row.reviewers).toHaveLength(1);
  });
});

describe('demoteRowToGone', () => {
  it('flips pr_state to gone + updates last_polled_at_ts', () => {
    const row = makeRow({ pr_state: 'open', last_polled_at_ts: 100 });
    const demoted = demoteRowToGone(row, 999);
    expect(demoted.pr_state).toBe('gone');
    expect(demoted.last_polled_at_ts).toBe(999);
  });

  it('preserves other columns', () => {
    const row = makeRow({
      checks_status: 'success',
      mergeable_state: 'mergeable',
      review_decision: 'approved',
      reviewers: [{ github_user_id: 5, github_login: 'x' }],
    });
    const demoted = demoteRowToGone(row, 999);
    expect(demoted.checks_status).toBe('success');
    expect(demoted.mergeable_state).toBe('mergeable');
    expect(demoted.review_decision).toBe('approved');
    expect(demoted.reviewers).toEqual([{ github_user_id: 5, github_login: 'x' }]);
  });

  it('is idempotent on already-gone rows', () => {
    const row = makeRow({ pr_state: 'gone', last_polled_at_ts: 100 });
    const demoted = demoteRowToGone(row, 999);
    expect(demoted).toBe(row); // same reference, no mutation
  });
});

describe('defaultRowForNewPr', () => {
  it('returns an open row with unknown statuses + zero last_polled_at_ts', () => {
    const row = defaultRowForNewPr({
      workspace_id: 'w',
      harness_slug: 'h',
      feature_id: 'F-1',
      pr_url: 'https://github.com/x/y/pull/1',
      opened_ts: 100,
    });
    expect(row.pr_state).toBe('open');
    expect(row.checks_status).toBe('unknown');
    expect(row.mergeable_state).toBe('unknown');
    expect(row.review_decision).toBe('none');
    expect(row.reviewers).toEqual([]);
    expect(row.last_polled_at_ts).toBe(0);
    expect(row.opened_ts).toBe(100);
    expect(row.updated_ts).toBe(100);
  });
});

describe('isHarnessFeaturePrRow', () => {
  it('accepts a well-formed row', () => {
    expect(isHarnessFeaturePrRow(makeRow())).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(isHarnessFeaturePrRow(null)).toBe(false);
    expect(isHarnessFeaturePrRow('not a row')).toBe(false);
    expect(isHarnessFeaturePrRow(42)).toBe(false);
  });

  it('rejects empty harness_slug or feature_id', () => {
    expect(isHarnessFeaturePrRow(makeRow({ harness_slug: '' }))).toBe(false);
    expect(isHarnessFeaturePrRow(makeRow({ feature_id: '' }))).toBe(false);
  });

  it('rejects empty pr_url', () => {
    expect(isHarnessFeaturePrRow(makeRow({ pr_url: '' }))).toBe(false);
  });

  it('rejects unknown pr_state', () => {
    expect(
      isHarnessFeaturePrRow({ ...makeRow(), pr_state: 'in-orbit' } as unknown),
    ).toBe(false);
  });

  it('rejects unknown checks_status / mergeable_state / review_decision', () => {
    expect(
      isHarnessFeaturePrRow({ ...makeRow(), checks_status: 'green-ish' } as unknown),
    ).toBe(false);
    expect(
      isHarnessFeaturePrRow({ ...makeRow(), mergeable_state: 'maybe' } as unknown),
    ).toBe(false);
    expect(
      isHarnessFeaturePrRow({ ...makeRow(), review_decision: 'pending' } as unknown),
    ).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(isHarnessFeaturePrRow(makeRow({ opened_ts: Number.NaN }))).toBe(false);
    expect(isHarnessFeaturePrRow(makeRow({ last_polled_at_ts: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('rejects non-array reviewers', () => {
    expect(
      isHarnessFeaturePrRow({ ...makeRow(), reviewers: 'one' } as unknown),
    ).toBe(false);
  });

  it('accepts empty workspace_id (legacy default)', () => {
    expect(isHarnessFeaturePrRow(makeRow({ workspace_id: '' }))).toBe(true);
  });
});

describe('hasBeenPolled', () => {
  it('false when last_polled_at_ts === 0', () => {
    expect(hasBeenPolled(makeRow({ last_polled_at_ts: 0 }))).toBe(false);
  });

  it('true when last_polled_at_ts > 0', () => {
    expect(hasBeenPolled(makeRow({ last_polled_at_ts: 1 }))).toBe(true);
  });
});

describe('isPollStale', () => {
  const NOW = 1716_010_000_000;

  it('false for fresh rows that have never been polled', () => {
    expect(isPollStale(makeRow({ last_polled_at_ts: 0 }), NOW)).toBe(false);
  });

  it('false when polled within the threshold', () => {
    expect(
      isPollStale(makeRow({ last_polled_at_ts: NOW - 1000 }), NOW),
    ).toBe(false);
  });

  it('true when polled outside the threshold', () => {
    expect(
      isPollStale(
        makeRow({ last_polled_at_ts: NOW - STALE_POLL_THRESHOLD_MS - 1 }),
        NOW,
      ),
    ).toBe(true);
  });

  it('boundary: exactly threshold ms ago is NOT stale (strict greater-than)', () => {
    expect(
      isPollStale(makeRow({ last_polled_at_ts: NOW - STALE_POLL_THRESHOLD_MS }), NOW),
    ).toBe(false);
  });

  it('STALE_POLL_THRESHOLD_MS is 5 minutes per v5 P-043a', () => {
    expect(STALE_POLL_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});

describe('P_042_ADDED_COLUMNS', () => {
  it('lists the 5 new columns per v5 line 452', () => {
    expect([...P_042_ADDED_COLUMNS]).toEqual([
      'last_polled_at_ts',
      'checks_status',
      'mergeable_state',
      'review_decision',
      'reviewers',
    ]);
  });

  it('matches the row shape keys that prToRow writes (sanity check)', () => {
    const row = prToRow({
      workspace_id: 'w',
      harness_slug: 'h',
      feature_id: 'F-1',
      opened_ts: 1,
      pr: makePrSlice(),
      now: 2,
    });
    for (const col of P_042_ADDED_COLUMNS) {
      expect(row).toHaveProperty(col);
    }
  });
});
