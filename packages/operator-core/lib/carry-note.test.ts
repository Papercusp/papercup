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
  renderCheckLine,
  parseCheckLine,
  splitCarryNoteWalls,
  splitCarryNoteChecks,
  withCarryNoteWalls,
  withCarryNoteChecks,
  normalizeWallEntries,
  normalizeCheckEntries,
  lintUncheckedExternalClaims,
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
  CARRY_NOTE_MAX_WALLS,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_CHECKS_LEGEND,
  type WallEntry,
  type CheckEntry,
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

describe('checks — external-state claims with probes (cold-carry-system-hardening-2026-07-19 P-001/P-010)', () => {
  const VERIFIED: CheckEntry = {
    claim: 'post-restart ticks stamp hash b01b01128a38273c',
    recheck: "dev:pg_query newest scout_ticks detail->>'scoutCodeHash'",
    verified: 'tick 1944 @02:38:36Z, pg read',
    sinceMs: Date.parse('2026-07-19T03:00:00.000Z'),
  };
  const PREDICTED: CheckEntry = {
    claim: 'the hash will roll at the next bg-host restart',
    recheck: 'compare tick_at of the newest hash-bearing tick vs ExecMainStartTimestamp',
    sinceMs: Date.parse('2026-07-19T03:05:00.000Z'),
  };

  it('a verified check renders ✓ + evidence and round-trips; a predicted one renders ? and round-trips', () => {
    const v = renderCheckLine(VERIFIED);
    expect(v).toContain('- ✓ ');
    expect(v).toContain(' — evidence: tick 1944');
    expect(parseCheckLine(v)).toEqual(VERIFIED);
    const p = renderCheckLine(PREDICTED);
    expect(p).toContain('- ? ');
    expect(p).not.toContain(' — evidence:');
    expect(parseCheckLine(p)).toEqual(PREDICTED);
    // Minimal check (claim only).
    expect(parseCheckLine(renderCheckLine({ claim: 'just a claim' }))).toEqual({ claim: 'just a claim' });
  });

  it('parseCheckLine rejects non-row lines including the legend', () => {
    expect(parseCheckLine('')).toBeNull();
    expect(parseCheckLine(CARRY_NOTE_CHECKS_LEGEND)).toBeNull();
    expect(parseCheckLine('prose')).toBeNull();
  });

  it('a marker-less (walls-syntax) row parses as PREDICTED instead of being dropped (fold #6)', () => {
    expect(parseCheckLine('- hand-written claim — re-check: run the probe')).toEqual({
      claim: 'hand-written claim',
      recheck: 'run the probe',
    });
  });

  it('newly-supplied verified evidence gets an instant stamped; inherited evidence keeps its own (fold #5)', () => {
    const now = Date.parse('2026-07-19T05:00:00.000Z');
    const fresh = normalizeCheckEntries(
      [{ claim: 'c', verified: 'observed live in pg' }],
      [],
      now,
    );
    expect(fresh[0].verified).toBe('observed live in pg @2026-07-19T05:00:00.000Z');
    // Evidence that already embeds an ISO instant is not double-stamped.
    const stamped = normalizeCheckEntries(
      [{ claim: 'c', verified: 'tick 1944 @ 2026-07-19T02:38:36Z' }],
      [],
      now,
    );
    expect(stamped[0].verified).toBe('tick 1944 @ 2026-07-19T02:38:36Z');
    // Inheritance carries the original stamp unchanged.
    const inherited = normalizeCheckEntries([{ claim: 'c' }], fresh, now + 3_600_000);
    expect(inherited[0].verified).toBe(fresh[0].verified);
  });

  it('renderCarryNote places ## Checks after the narrative and BEFORE ## Walls; parseCarryNote structures both back', () => {
    const fields = { did: 'a', next: 'b', checks: [VERIFIED, PREDICTED], walls: [{ claim: 'owner gate' } as WallEntry] };
    const out = renderCarryNote(fields);
    expect(out.indexOf('## Checks')).toBeGreaterThan(out.indexOf('## Next action'));
    expect(out.indexOf('## Walls')).toBeGreaterThan(out.indexOf('## Checks'));
    expect(out).toContain(CARRY_NOTE_CHECKS_LEGEND);
    expect(parseCarryNote(out)).toEqual(fields);
  });

  it('splitCarryNoteChecks separates rows from the body and drops the legend with the section', () => {
    const note = renderCarryNote({ did: 'x', checks: [VERIFIED], next: 'go' });
    const { body, checks } = splitCarryNoteChecks(note);
    expect(checks).toEqual([VERIFIED]);
    expect(body).toContain('## Did');
    expect(body).toContain('## Next action');
    expect(body).not.toContain('## Checks');
    expect(body).not.toContain(CARRY_NOTE_CHECKS_LEGEND);
    expect(splitCarryNoteChecks(null)).toEqual({ body: '', checks: [] });
  });

  it('withCarryNoteChecks replaces an existing section and keeps a Walls section LAST', () => {
    const prior = renderCarryNote({
      next: 'go',
      checks: [{ claim: 'old check' }],
      walls: [{ claim: 'standing wall' }],
    });
    const swapped = withCarryNoteChecks(prior, [VERIFIED]);
    expect(swapped).not.toContain('old check');
    expect(splitCarryNoteChecks(swapped).checks).toEqual([VERIFIED]);
    expect(splitCarryNoteWalls(swapped).walls).toEqual([{ claim: 'standing wall', sinceMs: undefined }].map((w) => ({ claim: w.claim })));
    expect(swapped.indexOf('## Walls')).toBeGreaterThan(swapped.indexOf('## Checks'));
    // Empty checks set yields body+walls only.
    expect(withCarryNoteChecks(prior, [])).not.toContain('## Checks');
  });

  it('normalizeCheckEntries preserves sinceMs AND inherits verified/recheck for a standing claim, dedups + caps', () => {
    const now = Date.parse('2026-07-19T04:00:00.000Z');
    const prior = [VERIFIED];
    // Re-write of the same claim WITHOUT verified/recheck inherits both (evidence never silently dropped).
    const out = normalizeCheckEntries([{ claim: VERIFIED.claim }, { claim: 'new one' }], prior, now);
    expect(out[0]).toEqual(VERIFIED);
    expect(out[1]).toEqual({ claim: 'new one', sinceMs: now });
    // Dedup by claim.
    expect(normalizeCheckEntries([{ claim: 'x' }, { claim: 'x' }], [], now)).toHaveLength(1);
    // Cap.
    const many = Array.from({ length: CARRY_NOTE_MAX_CHECKS + 3 }, (_, i) => ({ claim: `c${i}` }));
    expect(normalizeCheckEntries(many, [], now)).toHaveLength(CARRY_NOTE_MAX_CHECKS);
  });
});

describe('lintUncheckedExternalClaims — carried claims must carry their probe (P-009)', () => {
  it('catches its own ROOT INCIDENT: an assertion with an external-state noun but no concrete token', () => {
    // The exact line that caused the 2026-07-19 phantom re-anchor — verb, noun, NO token.
    const prose = 'expect the hash to ROLL, start counting only under the new hash';
    expect(lintUncheckedExternalClaims(prose, '')).toHaveLength(1);
    // Covered once a check row names the same noun.
    const probe = renderCheckLine({ claim: 'the hash rolls at the first post-restart tick', recheck: 'tick_at vs ExecMainStartTimestamp' });
    expect(lintUncheckedExternalClaims(prose, probe)).toHaveLength(0);
  });

  it('flags an assertion line whose distinctive token appears in no probe row', () => {
    const prose = 'Next wake: hostStartedAt MUST equal 2026-07-19T02:19:19Z or alarm.';
    const flags = lintUncheckedExternalClaims(prose, '');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('MUST');
  });

  it('sees 10-char short-shas (the form this fleet habitually quotes)', () => {
    expect(lintUncheckedExternalClaims('deploy 8655a22cf1 MUST land first', '')).toHaveLength(1);
    // …but a plain number is not a hash.
    expect(lintUncheckedExternalClaims('build 12345678 MUST finish', '')).toHaveLength(0);
  });

  it('does not flag when a check/wall row covers the token', () => {
    const prose = 'expect the next tick to stamp b01b01128a38273c';
    const probes = renderCheckLine({ claim: 'ticks stamp b01b01128a38273c', recheck: 'pg read' });
    expect(lintUncheckedExternalClaims(prose, probes)).toHaveLength(0);
  });

  it('ignores prose without assertion verbs or external-state content, and caps at 3', () => {
    expect(lintUncheckedExternalClaims('read the inbox, then build the patch', '')).toHaveLength(0);
    // Verb but neither a concrete token NOR an external-state noun — clean.
    expect(lintUncheckedExternalClaims('the answer MUST be correct', '')).toHaveLength(0);
    // Verb + external-state NOUN (no token) — flagged since the fold-#1 noun class
    // (this exact shape was the un-catchable root incident before it).
    expect(lintUncheckedExternalClaims('the hash MUST be correct', '')).toHaveLength(1);
    const many = Array.from({ length: 5 }, (_, i) => `line ${i}: WI-${1000 + i} MUST stay open`).join('\n');
    expect(lintUncheckedExternalClaims(many, '')).toHaveLength(3);
  });

  it('clips flagged lines to ~160 chars', () => {
    const long = `alarm if ${'x'.repeat(200)} WI-5391 changes`;
    const [flag] = lintUncheckedExternalClaims(long, '');
    expect(flag.length).toBeLessThanOrEqual(160);
    expect(flag.endsWith('…')).toBe(true);
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
