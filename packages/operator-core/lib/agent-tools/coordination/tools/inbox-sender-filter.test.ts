/**
 * inbox-sender-filter.test.ts — filterInboxBySender, the coord:inbox strict `from`
 * sender filter (EI-7018). A `from` arg used to be silently STRIPPED by the Zod schema
 * (unknown key) → an unfiltered read that LOOKED like a hit-less filtered one. This pins
 * the honored-not-ignored behavior: keep only entries whose `from` equals the arg.
 */
import { describe, it, expect } from 'vitest';
import { filterInboxBySender, classifyInboxFromFilter } from './inbox';

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

/**
 * classifyInboxFromFilter (EI-12930) — a SHORT `from` (`su-b0fbf`, the label rosters +
 * [coord+N] lines DISPLAY) used to strict-equal against the FULL id and return total:0,
 * byte-identical to a genuinely silent peer. This pins: resolve the short prefix/substring
 * to the FULL ownerId via the same resolver coord:send uses, and flag `unmatched` (a LOUD
 * signal) when it matches no known agent — so a mistyped filter is distinguishable from
 * "no reply". Fail-open on an empty roster.
 */
describe('classifyInboxFromFilter (EI-12930)', () => {
  const roster = [
    'su-b0fbfa98-0594-4a46-909f-3ca16622101d',
    'su-93a3872a-1111-2222-3333-444455556666',
    'bee-cafef00d-0000-0000-0000-000000000000',
  ];

  it('resolves a SHORT prefix to the FULL ownerId (the form an agent has to hand)', () => {
    // The reported repro: `coord:inbox { from: "su-b0fbf" }` must NOT return total:0.
    expect(classifyInboxFromFilter('su-b0fbf', roster)).toEqual({
      resolvedFrom: 'su-b0fbfa98-0594-4a46-909f-3ca16622101d',
      unmatched: false,
    });
  });

  it('resolves a mid-uuid SUBSTRING (the short handle, not a prefix)', () => {
    expect(classifyInboxFromFilter('93a3872a', roster)).toEqual({
      resolvedFrom: 'su-93a3872a-1111-2222-3333-444455556666',
      unmatched: false,
    });
  });

  it('an already-full known ownerId passes through unchanged and matched', () => {
    expect(
      classifyInboxFromFilter('bee-cafef00d-0000-0000-0000-000000000000', roster),
    ).toEqual({
      resolvedFrom: 'bee-cafef00d-0000-0000-0000-000000000000',
      unmatched: false,
    });
  });

  it('a `from` matching NO known agent is flagged unmatched (the loud signal, not a silent miss)', () => {
    const out = classifyInboxFromFilter('su-typo99', roster);
    expect(out.unmatched).toBe(true);
    // resolvedFrom is left unchanged so the (empty) filtered read is still consistent.
    expect(out.resolvedFrom).toBe('su-typo99');
  });

  it('an AMBIGUOUS prefix (>1 match) is left unresolved AND flagged unmatched', () => {
    // Both su- ids share the `su-` prefix; resolveBestEffort refuses to guess, so the raw
    // string cannot match any full id → unmatched (a "your filter is not specific" signal).
    expect(classifyInboxFromFilter('su-', roster)).toEqual({
      resolvedFrom: 'su-',
      unmatched: true,
    });
  });

  it('fail-OPEN on an empty/unavailable roster — never a false loud fail', () => {
    expect(classifyInboxFromFilter('su-b0fbf', [])).toEqual({
      resolvedFrom: 'su-b0fbf',
      unmatched: false,
    });
  });

  it('a nullish/empty `from` is a no-op', () => {
    expect(classifyInboxFromFilter(undefined, roster)).toEqual({
      resolvedFrom: undefined,
      unmatched: false,
    });
    expect(classifyInboxFromFilter('', roster)).toEqual({
      resolvedFrom: undefined,
      unmatched: false,
    });
  });
});
