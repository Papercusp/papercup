import { describe, expect, it } from 'vitest';
import {
  FEATURE_QUEUE_ROW_SCHEMA_VERSION,
  activeForUser,
  buildFreshQueueEntry,
  composeQueueEntryKey,
  isActiveQueueEntry,
  isFeatureQueueRow,
  isSameQueueEntry,
  markQueueEntryRemoved,
  type FeatureQueueRow,
} from './feature-queue-row-types';

function makeRow(over: Partial<FeatureQueueRow> = {}): FeatureQueueRow {
  return {
    harness_slug: 'papercup',
    github_user_id: 12345,
    feature_id: 'F-001',
    queued_at: 1716_000_000_000,
    removed_at: null,
    schema_version: 1,
    ...over,
  };
}

describe('FEATURE_QUEUE_ROW_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(FEATURE_QUEUE_ROW_SCHEMA_VERSION).toBe(1);
  });
});

describe('isFeatureQueueRow', () => {
  it('accepts a well-formed active row', () => {
    expect(isFeatureQueueRow(makeRow())).toBe(true);
  });

  it('accepts a soft-deleted row', () => {
    expect(isFeatureQueueRow(makeRow({ removed_at: 1716_000_001_000 }))).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isFeatureQueueRow(makeRow({ harness_slug: '' }))).toBe(false);
    expect(isFeatureQueueRow(makeRow({ feature_id: '' }))).toBe(false);
  });

  it('rejects non-positive github_user_id', () => {
    expect(isFeatureQueueRow(makeRow({ github_user_id: 0 }))).toBe(false);
    expect(isFeatureQueueRow(makeRow({ github_user_id: -1 }))).toBe(false);
    expect(isFeatureQueueRow(makeRow({ github_user_id: 1.5 }))).toBe(false);
  });

  it('rejects non-finite queued_at', () => {
    expect(isFeatureQueueRow(makeRow({ queued_at: 0 }))).toBe(false);
    expect(isFeatureQueueRow(makeRow({ queued_at: Number.NaN }))).toBe(false);
  });

  it('rejects negative removed_at', () => {
    expect(isFeatureQueueRow(makeRow({ removed_at: -1 }))).toBe(false);
    expect(isFeatureQueueRow(makeRow({ removed_at: 0 }))).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isFeatureQueueRow({ ...makeRow(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isFeatureQueueRow(null)).toBe(false);
    expect(isFeatureQueueRow('x')).toBe(false);
  });
});

describe('isActiveQueueEntry', () => {
  it('true when removed_at is null', () => {
    expect(isActiveQueueEntry(makeRow({ removed_at: null }))).toBe(true);
  });

  it('false when removed_at is set', () => {
    expect(isActiveQueueEntry(makeRow({ removed_at: 1 }))).toBe(false);
  });
});

describe('buildFreshQueueEntry', () => {
  it('builds an active row at now', () => {
    const row = buildFreshQueueEntry({
      harness_slug: 'papercup',
      github_user_id: 12345,
      feature_id: 'F-001',
      now: 1716_000_000_000,
    });
    expect(row.queued_at).toBe(1716_000_000_000);
    expect(row.removed_at).toBeNull();
    expect(row.schema_version).toBe(1);
  });

  it('rejects bad inputs', () => {
    expect(() =>
      buildFreshQueueEntry({ harness_slug: '', github_user_id: 1, feature_id: 'F-1', now: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildFreshQueueEntry({ harness_slug: 'h', github_user_id: 0, feature_id: 'F-1', now: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildFreshQueueEntry({ harness_slug: 'h', github_user_id: 1, feature_id: '', now: 1 }),
    ).toThrow(TypeError);
  });

  it('round-trips through isFeatureQueueRow', () => {
    const row = buildFreshQueueEntry({
      harness_slug: 'h',
      github_user_id: 1,
      feature_id: 'F-1',
      now: 1,
    });
    expect(isFeatureQueueRow(row)).toBe(true);
  });
});

describe('markQueueEntryRemoved', () => {
  it('stamps removed_at on active row', () => {
    const row = makeRow({ removed_at: null });
    const removed = markQueueEntryRemoved(row, 999);
    expect(removed.removed_at).toBe(999);
  });

  it('idempotent on already-removed row', () => {
    const row = makeRow({ removed_at: 500 });
    const removed = markQueueEntryRemoved(row, 999);
    expect(removed).toBe(row);
  });

  it('does not mutate input', () => {
    const row = makeRow({ removed_at: null });
    markQueueEntryRemoved(row, 999);
    expect(row.removed_at).toBeNull();
  });
});

describe('isSameQueueEntry', () => {
  it('keys on (harness_slug, github_user_id, feature_id)', () => {
    expect(
      isSameQueueEntry(
        { harness_slug: 'h', github_user_id: 1, feature_id: 'F-1' },
        { harness_slug: 'h', github_user_id: 1, feature_id: 'F-1' },
      ),
    ).toBe(true);
  });

  it('false when any component differs', () => {
    const base = { harness_slug: 'h', github_user_id: 1, feature_id: 'F-1' };
    expect(isSameQueueEntry(base, { ...base, harness_slug: 'x' })).toBe(false);
    expect(isSameQueueEntry(base, { ...base, github_user_id: 2 })).toBe(false);
    expect(isSameQueueEntry(base, { ...base, feature_id: 'F-2' })).toBe(false);
  });
});

describe('activeForUser', () => {
  it('filters to user + non-removed', () => {
    const rows = [
      makeRow({ github_user_id: 1, removed_at: null }),
      makeRow({ github_user_id: 1, removed_at: 1, feature_id: 'F-2' }),
      makeRow({ github_user_id: 2, removed_at: null }),
      makeRow({ github_user_id: 1, removed_at: null, feature_id: 'F-3' }),
    ];
    const out = activeForUser(rows, 1);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.github_user_id === 1 && r.removed_at === null)).toBe(true);
  });

  it('returns empty when no matches', () => {
    expect(activeForUser([], 1)).toEqual([]);
    expect(activeForUser([makeRow({ removed_at: 1 })], 12345)).toEqual([]);
  });
});

describe('composeQueueEntryKey', () => {
  it('builds slash-joined key', () => {
    expect(
      composeQueueEntryKey({ harness_slug: 'papercup', github_user_id: 12345, feature_id: 'F-001' }),
    ).toBe('papercup/12345/F-001');
  });
});
