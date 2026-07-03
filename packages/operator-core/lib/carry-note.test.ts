/**
 * carry-note.test.ts — the PURE half of the shared carry-note substrate
 * (su-cold-auto-mode-2026-07-03 P-001): the structured shape (render/parse), the
 * scope-key constructors, and the journal ring bounds. No DB — the store
 * round-trip is proven against real PG in carry-note.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  hiveScope,
  workItemScope,
  loopScope,
  renderCarryNote,
  parseCarryNote,
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
} from './carry-note';

describe('scope constructors — the convergence axis', () => {
  it('are stable, role-discriminated keys', () => {
    expect(hiveScope()).toBe('hive');
    expect(workItemScope('papercusp', 'WI-1')).toBe('workitem:papercusp:WI-1');
    expect(loopScope('papercusp', 'su-94b69')).toBe('loop:papercusp:su-94b69');
  });

  it('do not collide across roles or ids', () => {
    const keys = [
      hiveScope(),
      workItemScope('h1', 'X'),
      workItemScope('h2', 'X'),
      workItemScope('h1', 'Y'),
      loopScope('h1', 'X'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('renderCarryNote — the structured shape (did / left / insight / next)', () => {
  it('renders the canonical template, in order', () => {
    const out = renderCarryNote({
      did: 'landed the substrate',
      left: 'wire the loop',
      insight: 'bee + queen share the store',
      next: 'run the round-trip test',
    });
    expect(out).toBe(
      [
        '## Did\nlanded the substrate',
        '## Left\nwire the loop',
        '## Key insight\nbee + queen share the store',
        '## Next action\nrun the round-trip test',
      ].join('\n\n'),
    );
  });

  it('skips blank / omitted sections', () => {
    expect(renderCarryNote({ next: 'just the next step' })).toBe('## Next action\njust the next step');
    expect(renderCarryNote({ did: '   ', left: '' })).toBe(''); // all blank ⇒ '' (a clear)
    expect(renderCarryNote({})).toBe('');
  });

  it('round-trips through parseCarryNote', () => {
    const fields = { did: 'a', left: 'b\nb2', insight: 'c', next: 'd' };
    expect(parseCarryNote(renderCarryNote(fields))).toEqual(fields);
  });

  it('parseCarryNote returns {} for free text with no known headings', () => {
    expect(parseCarryNote('just a blob of prose, no headings')).toEqual({});
    expect(parseCarryNote('## Unknown\nbody')).toEqual({});
  });

  it('parseCarryNote is case-insensitive on headings and captures multi-line bodies', () => {
    expect(parseCarryNote('## did\nline1\nline2\n\n## NEXT ACTION\ngo')).toEqual({
      did: 'line1\nline2',
      next: 'go',
    });
  });
});

describe('appendCarryJournal — the bounded trajectory ring', () => {
  it('appends newest-last and caps a long note to the per-note char bound', () => {
    const long = 'z'.repeat(CARRY_JOURNAL_NOTE_MAX_CHARS + 500);
    const ring = appendCarryJournal([], long, 1000);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toEqual({ at: 1000, note: 'z'.repeat(CARRY_JOURNAL_NOTE_MAX_CHARS) });
  });

  it('a blank note appends nothing (returns the ring unchanged)', () => {
    const seed = [{ at: 1, note: 'a' }];
    expect(appendCarryJournal(seed, '   ', 2)).toEqual(seed);
    expect(appendCarryJournal(undefined, '', 2)).toEqual([]);
  });

  it('drops the oldest past the entry-count bound', () => {
    let ring: { at: number; note: string }[] = [];
    for (let i = 0; i < CARRY_JOURNAL_MAX_ENTRIES + 5; i++) ring = appendCarryJournal(ring, `n${i}`, i);
    expect(ring).toHaveLength(CARRY_JOURNAL_MAX_ENTRIES);
    expect(ring[0].note).toBe(`n5`); // first 5 dropped
    expect(ring[ring.length - 1].note).toBe(`n${CARRY_JOURNAL_MAX_ENTRIES + 4}`);
  });

  it('drops oldest past the total-chars bound (keeps at least one)', () => {
    // Each note ~ half the per-note cap; a handful blows the total budget.
    const big = 'x'.repeat(CARRY_JOURNAL_NOTE_MAX_CHARS);
    let ring: { at: number; note: string }[] = [];
    for (let i = 0; i < 20; i++) ring = appendCarryJournal(ring, big, i);
    const total = ring.reduce((n, e) => n + e.note.length, 0);
    expect(total).toBeLessThanOrEqual(CARRY_JOURNAL_TOTAL_MAX_CHARS);
    expect(ring.length).toBeGreaterThanOrEqual(1);
  });
});
