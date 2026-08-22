import { describe, expect, it } from 'vitest';
import {
  WORK_ITEMS_CURSOR_PAGE_LIMIT,
  buildWorkItemsPredicate,
  decodeWorkItemsCursor,
  encodeWorkItemsCursor,
  normalizeWorkItemsListArgs,
  workItemsSummarySelection,
} from './work-items-list-query';

describe('work-items normalized companion predicate', () => {
  it('canonicalizes multi-selects, clamps bounded reads, and keeps fair slices separate', () => {
    const args = normalizeWorkItemsListArgs({
      harnessSlug: ' papercusp ',
      harnessSlugs: ['ignored'],
      q: '  needle  ',
      kind: 'bug',
      filters: {
        kinds: ['change', 'bug', 'change'],
        states: ['open', 'blocked', 'open'],
        priorityMin: 2,
      },
      states: ['needs-human', 'open', 'open'],
      perState: 999,
      limit: 50_000,
    });
    expect(args).toMatchObject({
      harnessSlug: 'papercusp',
      harnessSlugs: [],
      q: 'needle',
      limit: WORK_ITEMS_CURSOR_PAGE_LIMIT,
      fairStates: ['needs-human', 'open'],
      perState: 200,
      filters: {
        kinds: ['bug', 'change'],
        states: ['blocked', 'open'],
        priorityMin: 2,
      },
    });
    expect(buildWorkItemsPredicate(args).fingerprint).toBe(JSON.stringify(args));
  });

  it('round-trips an opaque composite cursor and rejects malformed input', () => {
    const cursor = { updatedTs: 1_787_364_000_123, id: 'WI-31153' };
    expect(decodeWorkItemsCursor(encodeWorkItemsCursor(cursor))).toEqual(cursor);
    expect(decodeWorkItemsCursor('{"updatedTs":"wrong","id":"WI-1"}')).toBeNull();
    expect(decodeWorkItemsCursor('not-json')).toBeNull();
  });

  it('projects only enum dimensions into drill-down selection', () => {
    const args = normalizeWorkItemsListArgs({
      harnessSlug: 'h',
      filters: {
        kinds: ['bug', 'change'],
        states: ['open'],
        priorityMin: 3,
      },
    });
    expect([...workItemsSummarySelection(args)].map(([key, values]) => [key, [...values]])).toEqual([
      ['kind', ['bug', 'change']],
      ['state', ['open']],
    ]);
  });
});
