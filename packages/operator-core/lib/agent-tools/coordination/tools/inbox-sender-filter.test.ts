/**
 * inbox-sender-filter.test.ts — filterInboxBySender, the coord:inbox strict `from`
 * sender filter (EI-7018). A `from` arg used to be silently STRIPPED by the Zod schema
 * (unknown key) → an unfiltered read that LOOKED like a hit-less filtered one. This pins
 * the honored-not-ignored behavior: keep only entries whose `from` equals the arg.
 */
import { describe, it, expect } from 'vitest';
import { filterInboxBySender } from './inbox';

type E = { msg_id: string; from?: unknown };
const rows: E[] = [
  { msg_id: 'a', from: 'leader' },
  { msg_id: 'b', from: 'system:doc-freshness' },
  { msg_id: 'c', from: 'leader' },
  { msg_id: 'd', from: 'peer' },
  { msg_id: 'e' }, // no from at all
];

describe('filterInboxBySender (EI-7018)', () => {
  it('keeps only entries SENT BY the given ownerId', () => {
    expect(filterInboxBySender(rows, 'leader').map((r) => r.msg_id)).toEqual(['a', 'c']);
  });

  it('filters out broadcast/system noise when scoping to a human sender (the real use case)', () => {
    expect(filterInboxBySender(rows, 'peer').map((r) => r.msg_id)).toEqual(['d']);
  });

  it('a nullish/empty `from` is a NO-OP — returns the input unchanged (same reference)', () => {
    expect(filterInboxBySender(rows, undefined)).toBe(rows);
    expect(filterInboxBySender(rows, null)).toBe(rows);
    expect(filterInboxBySender(rows, '')).toBe(rows);
  });

  it('an unknown sender yields an empty result (a real filtered miss, not a silent unfiltered read)', () => {
    expect(filterInboxBySender(rows, 'nobody')).toEqual([]);
  });

  it('does not match an entry with a missing `from` field', () => {
    expect(filterInboxBySender(rows, 'leader').some((r) => r.msg_id === 'e')).toBe(false);
  });
});
