/**
 * inbox-supersede-annotation.test.ts — annotateSuperseded, the coord:inbox half of
 * P-004's supersession marker (WI-7222, plan agent-epistemics-2026-08-02).
 *
 * WI-7214 fixed readCoordFeed (coord:feed + coord:catch-up). coord:inbox is a
 * SEPARATE read path and is arguably the more consequential one: catch-up is a
 * deliberate history read, while the inbox is what an agent reads every wake and
 * acts on immediately — and its entries are also folded into coord:orient's
 * `recent`. A correction the sender already issued must not read as live there.
 *
 * The contract pinned here, same as the feed's: MARK, never suppress; forward
 * pointer; and — specific to this seam — NON-MUTATING, because readInbox's slow
 * path returns objects straight from an in-memory coord log BY REFERENCE.
 */
import { describe, it, expect } from 'vitest';
import { annotateSuperseded } from './inbox';

type Mark = { supersededBy: string; supersededAt: string | null };
const marks = (m: Record<string, Mark>) => new Map<string, Mark>(Object.entries(m));

const rows = [
  { msg_id: 'a', summary: 'the gate is red because of your change' },
  { msg_id: 'b', summary: 'unrelated status' },
  { msg_id: 'c', summary: 'another claim' },
];

describe('annotateSuperseded (WI-7222)', () => {
  it('marks a superseded entry with a FORWARD pointer to the correction', () => {
    const out = annotateSuperseded(rows, marks({ a: { supersededBy: 'correction-1', supersededAt: '2026-08-02T23:30:00.000Z' } }));

    expect(out[0]).toMatchObject({
      msg_id: 'a',
      superseded_by: 'correction-1',
      superseded_at: '2026-08-02T23:30:00.000Z',
    });
  });

  it('does NOT suppress the superseded entry — every row survives, marked', () => {
    // Deliberately the opposite of coord:retract. Migration 732: "a retraction that
    // does not say what REPLACES it strands the reader."
    const out = annotateSuperseded(rows, marks({ a: { supersededBy: 'correction-1', supersededAt: null } }));

    expect(out).toHaveLength(3);
    expect(out.map((r) => r['msg_id'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves uncorrected entries unmarked, so absence of the field means "not corrected"', () => {
    const out = annotateSuperseded(rows, marks({ a: { supersededBy: 'correction-1', supersededAt: null } }));

    expect(out[1]?.['superseded_by']).toBeUndefined();
    expect(out[2]?.['superseded_by']).toBeUndefined();
  });

  it('DOES NOT MUTATE the input entries — readInbox can hand back live coord-log references', () => {
    // The load-bearing difference from readCoordFeed, which annotates spread COPIES.
    // Mutating here would write the marker into the log's own objects.
    const original = { msg_id: 'a', summary: 'original' };
    const input = [original];

    const out = annotateSuperseded(input, marks({ a: { supersededBy: 'correction-1', supersededAt: null } }));

    expect(original).not.toHaveProperty('superseded_by');
    expect(out[0]).not.toBe(original);
    expect(out[0]).toMatchObject({ superseded_by: 'correction-1' });
  });

  it('returns untouched (same reference) when nothing is superseded — the overwhelmingly common case', () => {
    expect(annotateSuperseded(rows, marks({}))).toBe(rows);
  });

  it('ignores an entry with no usable msg_id instead of throwing', () => {
    const odd = [{ summary: 'no id' }, { msg_id: 42, summary: 'numeric id' }];

    expect(() => annotateSuperseded(odd, marks({ a: { supersededBy: 'x', supersededAt: null } }))).not.toThrow();
    expect(annotateSuperseded(odd, marks({ a: { supersededBy: 'x', supersededAt: null } }))).toHaveLength(2);
  });

  it('marks several superseded entries in one pass', () => {
    const out = annotateSuperseded(
      rows,
      marks({
        a: { supersededBy: 'correction-1', supersededAt: null },
        c: { supersededBy: 'correction-2', supersededAt: '2026-08-02T23:40:00.000Z' },
      }),
    );

    expect(out[0]?.['superseded_by']).toBe('correction-1');
    expect(out[1]?.['superseded_by']).toBeUndefined();
    expect(out[2]?.['superseded_by']).toBe('correction-2');
  });
});
