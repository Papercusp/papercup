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
  renderWallLine,
  parseWallLine,
  splitCarryNoteWalls,
  withCarryNoteWalls,
  normalizeWallEntries,
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
  CARRY_NOTE_MAX_WALLS,
  type WallEntry,
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

describe('walls — commitments as rows (compaction-continuity-hardening P-006)', () => {
  const WALL: WallEntry = {
    claim: '3 zombie PIDs await owner OK to kill',
    recheck: 'ps -o pid,rss -p 95902,200903,220406',
    sinceMs: Date.parse('2026-07-07T12:00:00.000Z'),
  };

  it('a wall line round-trips through render + parse', () => {
    expect(parseWallLine(renderWallLine(WALL))).toEqual(WALL);
    // Minimal wall (claim only) round-trips too.
    expect(parseWallLine(renderWallLine({ claim: 'just a claim' }))).toEqual({ claim: 'just a claim' });
    // recheck-less but dated.
    expect(parseWallLine(renderWallLine({ claim: 'c', sinceMs: 1751892000000 }))).toEqual({
      claim: 'c',
      sinceMs: 1751892000000,
    });
  });

  it('parseWallLine rejects non-row lines', () => {
    expect(parseWallLine('')).toBeNull();
    expect(parseWallLine('prose without a dash')).toBeNull();
    expect(parseWallLine('- ')).toBeNull();
  });

  it('renderCarryNote appends a ## Walls section LAST; parseCarryNote structures it back', () => {
    const fields = { did: 'a', next: 'b', walls: [WALL] };
    const out = renderCarryNote(fields);
    expect(out.indexOf('## Walls')).toBeGreaterThan(out.indexOf('## Next action'));
    expect(parseCarryNote(out)).toEqual(fields);
  });

  it('a walls-only note renders and round-trips (commitments survive a body clear)', () => {
    const out = renderCarryNote({ walls: [WALL] });
    expect(out).toBe(`## Walls\n${renderWallLine(WALL)}`);
    expect(parseCarryNote(out)).toEqual({ walls: [WALL] });
  });

  it('splitCarryNoteWalls separates rows from the body; a section mid-note does not eat later sections', () => {
    const note = ['## Did', 'x', '', '## Walls', renderWallLine(WALL), 'stray prose in the section', '', '## Next action', 'go'].join('\n');
    const { body, walls } = splitCarryNoteWalls(note);
    expect(walls).toEqual([WALL]);
    expect(body).toContain('## Did');
    expect(body).toContain('## Next action');
    expect(body).not.toContain('## Walls');
    expect(body).not.toContain('stray prose');
    expect(splitCarryNoteWalls(null)).toEqual({ body: '', walls: [] });
  });

  it('withCarryNoteWalls replaces an existing section, and yields a walls-only note for a blank body', () => {
    const prior = renderCarryNote({ next: 'go', walls: [{ claim: 'old wall' }] });
    const swapped = withCarryNoteWalls(prior, [WALL]);
    expect(swapped).not.toContain('old wall');
    expect(splitCarryNoteWalls(swapped).walls).toEqual([WALL]);
    expect(withCarryNoteWalls('', [WALL])).toBe(`## Walls\n${renderWallLine(WALL)}`);
    expect(withCarryNoteWalls('body only', [])).toBe('body only');
  });

  it('normalizeWallEntries preserves the ORIGINAL sinceMs for a standing claim, stamps now on new ones, dedups + caps', () => {
    const prior: WallEntry[] = [{ claim: 'standing', recheck: 'old-cmd', sinceMs: 1000 }];
    const out = normalizeWallEntries(
      [
        { claim: '  standing  ' },
        { claim: 'standing' }, // dupe — dropped
        { claim: 'brand new', recheck: 'check-it' },
        { claim: '   ' }, // blank — dropped
      ],
      prior,
      5000,
    );
    expect(out).toEqual([
      { claim: 'standing', recheck: 'old-cmd', sinceMs: 1000 }, // age + recheck inherited
      { claim: 'brand new', recheck: 'check-it', sinceMs: 5000 },
    ]);
    const flood = normalizeWallEntries(
      Array.from({ length: 30 }, (_, i) => ({ claim: `w${i}` })),
      [],
      1,
    );
    expect(flood).toHaveLength(CARRY_NOTE_MAX_WALLS);
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
