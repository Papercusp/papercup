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
  lintUncheckedImperativeActions,
  rescueTaggedCarryNoteBlob,
  mergeCarryRows,
  carryRowKey,
  sanitizeCarryRowId,
  CARRY_ROW_ID_MAX,
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
  CARRY_NOTE_MAX_WALLS,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_CHECKS_LEGEND,
  coerceCarryRowShape,
  type WallEntry,
  type CheckEntry,
  type CarryArgRepair,
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

  it('downgrades contradictory verification evidence to CONTESTED and preserves it visibly', () => {
    const now = Date.parse('2026-07-19T05:00:00.000Z');
    const downgraded = normalizeCheckEntries(
      [{ claim: 'the suite is green', recheck: 'run the suite', verified: 'STILL RUNNING at compaction' }],
      [],
      now,
    );
    expect(downgraded[0]).toMatchObject({
      claim: 'the suite is green',
      recheck: 'run the suite',
      contested: expect.stringContaining('STILL RUNNING'),
    });
    expect(downgraded[0]).not.toHaveProperty('verified');

    const rendered = renderCheckLine(downgraded[0]!);
    expect(rendered).toContain('- ⚠ ');
    expect(rendered).toContain('STILL RUNNING');
    expect(parseCheckLine(rendered)).toEqual(downgraded[0]);
  });

  it('renders an explicitly contested row with ⚠ and never upgrades it to ✓', () => {
    const row: CheckEntry = {
      claim: 'the suite is green',
      recheck: 'run the suite',
      contested: 'pending final verdict',
    };
    const rendered = renderCheckLine(row);
    expect(rendered).toContain('- ⚠ ');
    expect(rendered).not.toContain('- ✓ ');
    expect(parseCheckLine(rendered)).toEqual(row);
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

  it('maps descriptive label/name aliases to claim, while an explicit claim wins', () => {
    // Typed as the REAL exported CarryArgRepair, not a structural stand-in: a
    // hand-rolled `{ field: string; kind: string; detail: string }` silently
    // drifted when `kind` was narrowed to 'truncated' | 'renamed', which is what
    // put 3 committed type errors in this file (EI-20278756030495608).
    const labelRepairs: CarryArgRepair[] = [];
    expect(coerceCarryRowShape({ label: 'labelled claim' }, 'checks[0]', labelRepairs)).toEqual({
      claim: 'labelled claim',
    });
    expect(labelRepairs).toEqual([
      expect.objectContaining({ field: 'checks[0].label', kind: 'renamed' }),
    ]);

    const nameRepairs: CarryArgRepair[] = [];
    expect(coerceCarryRowShape({ name: 'named claim' }, 'checks[1]', nameRepairs)).toEqual({
      claim: 'named claim',
    });

    const canonicalRepairs: CarryArgRepair[] = [];
    expect(
      coerceCarryRowShape(
        { claim: 'canonical claim', label: 'ignored label', name: 'ignored name' },
        'checks[2]',
        canonicalRepairs,
      ),
    ).toEqual({ claim: 'canonical claim' });
    expect(canonicalRepairs[0]?.detail).toContain('canonical claim value was kept');
  });

  /**
   * The claim-bearing aliases beyond label/name, and the `key`->`id` alias. Each
   * shape here is a REAL rejected row from the 14-day census of
   * `checks.N.claim: expected string, received undefined` — the schema strips
   * these keys, so before this repair the caller's own claim text was destroyed
   * and the row then failed validation for the field it had just lost.
   */
  it('maps the measured text/body/summary claim aliases and the key->id alias', () => {
    for (const alias of ['text', 'body', 'summary'] as const) {
      const repairs: CarryArgRepair[] = [];
      expect(coerceCarryRowShape({ [alias]: 'aliased claim', status: 'verified' }, 'checks[0]', repairs)).toEqual({
        claim: 'aliased claim',
        verified: 'verified',
      });
      expect(repairs.some((r) => r.field === `checks[0].${alias}` && r.kind === 'renamed')).toBe(true);
    }

    // `key` is an IDENTITY alias, not a claim alias: it must land on `id` and
    // leave the claim text alone.
    const keyRepairs: CarryArgRepair[] = [];
    expect(coerceCarryRowShape({ key: 'gate-green', recheck: 'git rev-parse main', status: 'pending', text: 'main is green' }, 'checks[1]', keyRepairs)).toEqual({
      claim: 'main is green',
      id: 'gate-green',
      recheck: 'git rev-parse main',
    });
    expect(keyRepairs.some((r) => r.field === 'checks[1].key')).toBe(true);

    // An explicit canonical value always wins over its alias.
    const bothRepairs: CarryArgRepair[] = [];
    expect(coerceCarryRowShape({ id: 'canonical', key: 'ignored' }, 'checks[2]', bothRepairs)).toEqual({
      claim: 'canonical',
      id: 'canonical',
    });
    expect(bothRepairs.some((r) => r.detail.includes('canonical id was kept'))).toBe(true);
  });

  /**
   * The failure this whole coercion exists to prevent, at its sharpest: `claim`
   * is the ONE required field, so a single under-specified row used to reject the
   * entire write — discarding did/left/insight/next and every sibling row, and
   * leaving a cold wake with no note at all. A row that named itself falls back
   * to that identity instead.
   */
  it('falls back to the row id as the claim rather than rejecting the whole note', () => {
    const repairs: CarryArgRepair[] = [];
    // The exact filed shape (EI-20283352640488384): {id, status, evidence}.
    const coerced = coerceCarryRowShape(
      { id: 'tsc-clean', status: 'verified', evidence: 'TSC_EXIT=0 at 21:40Z' },
      'checks[0]',
      repairs,
    ) as Record<string, unknown>;
    expect(coerced).toEqual({ id: 'tsc-clean', claim: 'tsc-clean', verified: 'TSC_EXIT=0 at 21:40Z' });
    // Degraded, but REPORTED — the silent-drop failure (EI-18723223344390510) is
    // exactly what must not recur here.
    expect(repairs.some((r) => r.field === 'checks[0].claim' && r.detail.includes('no claim text was supplied'))).toBe(
      true,
    );

    // …and the identity may itself arrive under the `key` alias.
    expect(coerceCarryRowShape({ key: 'deploy-live', evidence: 'sha matches' }, 'checks[1]', [])).toEqual({
      id: 'deploy-live',
      claim: 'deploy-live',
      verified: 'sha matches',
    });
  });

  /**
   * The guard on the repair: a row with NO claim text and NO identity has nothing
   * to fall back to, so it must still fail validation loudly. Inventing a claim
   * there would turn a caller's mistake into a silently fabricated carried claim.
   */
  it('does not invent a claim for a row carrying neither claim text nor an identity', () => {
    const repairs: CarryArgRepair[] = [];
    const coerced = coerceCarryRowShape({ status: 'verified', evidence: 'some evidence' }, 'checks[0]', repairs) as Record<
      string,
      unknown
    >;
    expect(coerced.claim).toBeUndefined();
    expect(coerced).toEqual({ verified: 'some evidence' });

    // A row already in the canonical shape is returned untouched, with no repairs.
    const untouched: CarryArgRepair[] = [];
    const canonical = { claim: 'already correct', recheck: 'run it', verified: 'saw it' };
    expect(coerceCarryRowShape(canonical, 'checks[1]', untouched)).toBe(canonical);
    expect(untouched).toEqual([]);
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
    expect(CARRY_NOTE_CHECKS_LEGEND).toContain('⚠');
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

describe('lintUncheckedImperativeActions — singleton mutators need a runnable precondition', () => {
  it('flags an imperative singleton invocation with no corresponding check', () => {
    const matches = lintUncheckedImperativeActions(
      "If no objection has arrived, FIRE IT NOW: tools:invoke { name:'release:checkpoint-run' }",
      [],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ target: 'release:checkpoint-run' });
    expect(matches[0]?.line).toContain('FIRE IT NOW');
  });

  it('requires both correspondence and a runnable recheck to clear the warning', () => {
    const prose = 'run release:checkpoint-run only after the active-run precondition is checked';
    expect(lintUncheckedImperativeActions(prose, [{ claim: 'checkpoint run is safe' }])).toHaveLength(1);
    expect(
      lintUncheckedImperativeActions(prose, [
        { claim: 'checkpoint run is safe', recheck: 'systemctl --user list-units --all | grep green-checkpoint' },
      ]),
    ).toEqual([]);
  });

  it('does not warn for read-only commands or explicit prohibitions', () => {
    expect(lintUncheckedImperativeActions('run the focused tests and inspect state:read', [])).toEqual([]);
    expect(lintUncheckedImperativeActions('Do NOT fire release:checkpoint-run while one is active', [])).toEqual([]);
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

// ── EI-18833865002636933: rescue-by-parse of a tag-serialized structured write ──
//
// The observed live failure (cold-wake #85's own carry-note): an agent serialized the
// ENTIRE structured write as one XML-tagged string into `did`, so the note reached the
// next cold wake as a single `## Did` section with literal `</did><left>…<checks>[…]`
// text in it — demoting typed `checks` rows to inert JSON prose and losing the
// verified/PREDICTED badges that tell a successor which claims to re-probe.
//
// This module never RENDERS that tag shape; the vocabulary exists only to recognize the
// mistake. The rescue follows the file's established precedent for "right content, wrong
// shape" (checkpoint.ts's `checks` z.preprocess, which PARSES a JSON-string array rather
// than rejecting the write) — rejecting instead would have produced a FOURTH consecutive
// failed checkpoint and possibly no note at all for the cold wake.
describe('rescueTaggedCarryNoteBlob — recovering a tag-serialized structured write', () => {
  const BLOB = [
    'Closed two gate threats.</did>',
    '<left>Nothing claimed, nothing half-landed.</left>',
    '<insight>A gate verdict is a timestamped snapshot.</insight>',
    '<next>Confirm the gate outcome; do not force it.</next>',
    '<checks>[{"claim":"main is green","recheck":"git rev-parse main","verified":"21:05Z verdict green"}]</checks>',
  ].join('\n');

  it('splits the blob back into the four narrative fields', () => {
    expect(rescueTaggedCarryNoteBlob(BLOB)).toMatchObject({
      did: 'Closed two gate threats.',
      left: 'Nothing claimed, nothing half-landed.',
      insight: 'A gate verdict is a timestamped snapshot.',
      next: 'Confirm the gate outcome; do not force it.',
    });
  });

  it('recovers a <checks> JSON payload as TYPED rows (the whole point — the badges survive)', () => {
    expect(rescueTaggedCarryNoteBlob(BLOB)?.checks).toEqual([
      { claim: 'main is green', recheck: 'git rev-parse main', verified: '21:05Z verdict green' },
    ]);
  });

  it('recovers a <checks>/<walls> block written as RENDERED rows, not JSON', () => {
    const f = rescueTaggedCarryNoteBlob(
      [
        'did text</did>',
        '<next>go</next>',
        '<checks>\n- ✓ gate green — re-check: git rev-parse main — evidence: 21:05Z\n</checks>',
        '<walls>\n- owner must arm capital — re-check: ask the owner\n</walls>',
      ].join('\n'),
    );
    expect(f?.checks).toEqual([{ claim: 'gate green', recheck: 'git rev-parse main', verified: '21:05Z' }]);
    expect(f?.walls).toEqual([{ claim: 'owner must arm capital', recheck: 'ask the owner' }]);
  });

  it('tolerates a leading <did> opener (the caller may or may not have emitted one)', () => {
    expect(rescueTaggedCarryNoteBlob('<did>alpha</did>\n<next>beta</next>')).toMatchObject({
      did: 'alpha',
      next: 'beta',
    });
  });

  // ── NEGATIVE CONTROLS — these matter MORE than the positive assertions above.
  // Notes routinely quote code, shell and JSX, so an over-eager matcher would silently
  // mangle most real carry-notes. Only the FULL signature (a literal `</did>` close tag
  // PLUS at least one sibling close tag) may trigger the rescue — never a bare '<'.
  it('NEGATIVE: honest prose with angle brackets, JSX, shell redirects and fenced code is NOT rescued', () => {
    const honest = [
      'Fixed the `cmd 2>&1 > /tmp/x.log` idiom and the `a < b && c > d` guard.',
      '```jsx',
      '<div className="x"><span/></div>',
      '```',
      'Also touched </footer> in the retired template.',
    ].join('\n');
    expect(rescueTaggedCarryNoteBlob(honest)).toBeNull();
  });

  it('NEGATIVE: a lone </did> with NO sibling section tag is NOT rescued (half a signature is not one)', () => {
    expect(rescueTaggedCarryNoteBlob('I documented the </did> tag in the runbook.')).toBeNull();
  });

  it('NEGATIVE: an empty / absent blob is NOT rescued', () => {
    expect(rescueTaggedCarryNoteBlob('')).toBeNull();
    expect(rescueTaggedCarryNoteBlob(null)).toBeNull();
    expect(rescueTaggedCarryNoteBlob(undefined)).toBeNull();
  });

  it('a malformed <checks> payload degrades to no checks rather than failing the whole rescue', () => {
    const f = rescueTaggedCarryNoteBlob('did</did>\n<left>l</left>\n<checks>{not json at all</checks>');
    expect(f).toMatchObject({ did: 'did', left: 'l' });
    expect(f?.checks).toBeUndefined();
  });

  it('a rescued note round-trips through renderCarryNote into real headings + typed rows', () => {
    const rendered = renderCarryNote(rescueTaggedCarryNoteBlob(BLOB)!);
    expect(rendered).toContain('## Did');
    expect(rendered).toContain('## Left');
    expect(rendered).toContain('## Key insight'); // NB: tag name `insight` ≠ heading 'Key insight'
    expect(rendered).toContain('## Next action'); // NB: tag name `next` ≠ heading 'Next action'
    expect(rendered).toContain('- ✓ main is green — re-check: git rev-parse main');
    expect(rendered).not.toContain('</did>');
  });
});

/**
 * EI-19463731740128181 — an explicit `checks`/`walls` list REPLACES the carried set,
 * and that loss used to be SILENT: the reply carried only a post-merge COUNT, which
 * reveals a drop only to a caller who recorded the prior count first.
 *
 * These cases are a DISCRIMINATING PAIR by construction: the carry-forward path must
 * report NOTHING dropped while the replace path must name exactly the missing claims.
 * An implementation that ignores its inputs — returning [] always, or the prior set
 * always — fails one direction or the other, so neither can pass by accident. The
 * assertions are on claim CONTENT, not just length, so a constant cannot satisfy them.
 */
describe('mergeCarryRows — dropped rows are reported, never silent (EI-19463731740128181)', () => {
  const check = (n: number) => ({ claim: `claim ${n}`, recheck: `probe ${n}`, verified: `ok ${n}` });
  const wall = (n: number) => ({ claim: `wall ${n}`, recheck: `probe ${n}` });

  /** A prior note carrying the given rows, built through the same renderer the store uses. */
  const priorNoteWith = (checks: ReturnType<typeof check>[], walls: ReturnType<typeof wall>[] = []) =>
    mergeCarryRows({ priorNote: null, baseNote: 'body', checks, walls, hasNoteWrite: true }).note;

  it('names every carried check a supplied list leaves out (the measured 6 -> 1 shape)', () => {
    const priorNote = priorNoteWith([1, 2, 3, 4, 5, 6].map(check));
    const merged = mergeCarryRows({
      priorNote,
      baseNote: 'body',
      checks: [{ claim: 'a brand new claim' }],
      hasNoteWrite: true,
    });
    expect(merged.checks).toHaveLength(1);
    // The whole defect: six verified rows vanished behind an ok:true.
    expect(merged.droppedChecks).toEqual(['claim 1', 'claim 2', 'claim 3', 'claim 4', 'claim 5', 'claim 6']);
  });

  it('reports NOTHING dropped on the carry-forward path (omitted preserves every row)', () => {
    const priorNote = priorNoteWith([1, 2, 3].map(check), [1].map(wall));
    const merged = mergeCarryRows({ priorNote, baseNote: 'new body', hasNoteWrite: true });
    expect(merged.checks.map((c) => c.claim)).toEqual(['claim 1', 'claim 2', 'claim 3']);
    expect(merged.droppedChecks).toEqual([]);
    expect(merged.droppedWalls).toEqual([]);
  });

  it('does not report a re-sent claim as dropped, and reports only its omitted siblings', () => {
    const prior = mergeCarryRows({
      priorNote: null,
      baseNote: 'body',
      checks: [1, 2, 3].map(check),
      hasNoteWrite: true,
    });
    const merged = mergeCarryRows({
      priorNote: prior.note,
      baseNote: 'body',
      // claim 2 is re-sent with NO evidence — it must inherit, not read as dropped.
      checks: [{ claim: 'claim 2' }],
      hasNoteWrite: true,
    });
    expect(merged.droppedChecks).toEqual(['claim 1', 'claim 3']);
    expect(merged.checks).toHaveLength(1);
    // Inherited evidence keeps its ORIGINAL verification stamp — a ✓ observed long ago
    // must not be re-dated to now just because its row was re-sent (review fold #5).
    const priorVerified = prior.checks.find((c) => c.claim === 'claim 2')?.verified;
    expect(priorVerified).toMatch(/^ok 2 @\d{4}-\d{2}-\d{2}T/);
    expect(merged.checks[0]?.verified).toBe(priorVerified);
  });

  it('compares on the trimmed key, so whitespace drift is not a phantom drop', () => {
    const priorNote = priorNoteWith([1].map(check));
    const merged = mergeCarryRows({
      priorNote,
      baseNote: 'body',
      checks: [{ claim: '  claim 1  ' }],
      hasNoteWrite: true,
    });
    expect(merged.droppedChecks).toEqual([]);
  });

  it('reports an explicit [] clear too — deliberate, but still visible', () => {
    const priorNote = priorNoteWith([1, 2].map(check));
    const merged = mergeCarryRows({ priorNote, baseNote: 'body', checks: [], hasNoteWrite: true });
    expect(merged.checks).toEqual([]);
    expect(merged.droppedChecks).toEqual(['claim 1', 'claim 2']);
  });

  it('reports dropped WALLS — an owner-gated commitment lost silently un-blocks work', () => {
    const priorNote = priorNoteWith([], [1, 2].map(wall));
    const merged = mergeCarryRows({
      priorNote,
      baseNote: 'body',
      walls: [wall(2)],
      hasNoteWrite: true,
    });
    expect(merged.walls.map((w) => w.claim)).toEqual(['wall 2']);
    expect(merged.droppedWalls).toEqual(['wall 1']);
    // walls and checks are independent axes — one must not report the other's rows.
    expect(merged.droppedChecks).toEqual([]);
  });

  /**
   * FALSIFIABILITY CONTROL (tier 1 — the subject is an imported module, so the control
   * lives here permanently rather than being probed by mutating the shared tree).
   *
   * The two ways this report can regress are both CONSTANTS: report nothing (the silent
   * loss returns) or report the prior set unconditionally (a false alarm on every safe
   * write). This case pins the real subject's output against BOTH constants at once and
   * shows each equals what the OTHER scenario legitimately produces — so neither constant
   * can satisfy the pair, and a green here cannot be an artifact of a vacuous assertion.
   */
  it('the drop report DISCRIMINATES — neither constant implementation could pass', () => {
    const priorNote = priorNoteWith([1, 2, 3].map(check));
    const onReplace = mergeCarryRows({
      priorNote,
      baseNote: 'body',
      checks: [{ claim: 'a brand new claim' }],
      hasNoteWrite: true,
    }).droppedChecks;
    const onCarryForward = mergeCarryRows({ priorNote, baseNote: 'body', hasNoteWrite: true }).droppedChecks;

    const ALWAYS_EMPTY: string[] = [];
    const ALWAYS_PRIOR = ['claim 1', 'claim 2', 'claim 3'];

    // A "report nothing" regression reinstates the silent loss...
    expect(onReplace).not.toEqual(ALWAYS_EMPTY);
    expect(onReplace).toEqual(ALWAYS_PRIOR);
    // ...and a "report everything" regression cries wolf on the safe path.
    expect(onCarryForward).not.toEqual(ALWAYS_PRIOR);
    expect(onCarryForward).toEqual(ALWAYS_EMPTY);
    // The pair is only meaningful because the two scenarios genuinely diverge.
    expect(onReplace).not.toEqual(onCarryForward);
  });

  it('reports rows lost to the row cap rather than letting the cap drop them silently', () => {
    const prior = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => check(i + 1));
    const priorNote = priorNoteWith(prior);
    // Re-send every carried row PLUS one more: the cap keeps the first N, so the
    // last carried row falls off the end — and that must not read as a preserved set.
    const merged = mergeCarryRows({
      priorNote,
      baseNote: 'body',
      checks: [{ claim: 'one row past the cap' }, ...prior],
      hasNoteWrite: true,
    });
    expect(merged.checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
    expect(merged.droppedChecks).toEqual([`claim ${CARRY_NOTE_MAX_CHECKS}`]);
  });
});

describe('row identity + merge mode — a loss made VISIBLE is not yet a loss AVOIDED (P-013)', () => {
  const check = (n: number) => ({ claim: `claim ${n}`, recheck: `probe ${n}`, verified: `ok ${n}` });
  const wall = (n: number) => ({ claim: `wall ${n}`, recheck: `probe ${n}` });
  const priorNoteWith = (
    checks: Array<{ id?: string; claim: string; recheck?: string; verified?: string }>,
    walls: Array<{ id?: string; claim: string; recheck?: string }> = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'body', checks, walls, hasNoteWrite: true }).note;

  describe('sanitizeCarryRowId / carryRowKey', () => {
    it('repairs an out-of-charset id instead of rejecting the row', () => {
      // Repair-don't-refuse: the id rides attached to a multi-KB note.
      expect(sanitizeCarryRowId('Gate Green!')).toBe('gate-green');
      expect(sanitizeCarryRowId('  --wi-37459--  ')).toBe('wi-37459');
      expect(sanitizeCarryRowId('x'.repeat(CARRY_ROW_ID_MAX + 20))).toHaveLength(CARRY_ROW_ID_MAX);
    });

    it('yields null for input that cannot be an id, so such a row falls back to claim identity', () => {
      for (const bad of ['', '   ', '!!!', 42, null, undefined]) expect(sanitizeCarryRowId(bad)).toBeNull();
      expect(carryRowKey({ id: '!!!', claim: 'the claim' })).toBe(carryRowKey({ claim: 'the claim' }));
    });

    it('TAGS the two namespaces apart so a claim can never collide with another row id', () => {
      expect(carryRowKey({ id: 'gate' })).not.toBe(carryRowKey({ claim: 'gate' }));
    });
  });

  describe('the id survives render -> parse (an id that does not round-trip is no identity at all)', () => {
    it('round-trips through a check line, with and without evidence', () => {
      for (const row of [
        { id: 'gate-green', claim: 'the gate is green at tip', recheck: 'run it', verified: 'seen 13:0xZ' },
        { id: 'gate-green', claim: 'the gate is green at tip', recheck: 'run it' },
      ]) {
        expect(parseCheckLine(renderCheckLine(row))).toMatchObject(row);
      }
    });

    it('round-trips through a wall line', () => {
      const row = { id: 'owner-ok', claim: 'awaiting owner OK to kill 3 PIDs', recheck: 'ps' };
      expect(parseWallLine(renderWallLine(row))).toMatchObject(row);
    });

    it('leaves an id-less row byte-identical — no `[#…]` noise on rows that do not use it', () => {
      expect(renderCheckLine({ claim: 'plain', recheck: 'p' })).toBe('- ? plain — re-check: p');
      expect(renderWallLine({ claim: 'plain' })).toBe('- plain');
    });

    it('survives a FULL note round-trip, which is the path a cold wake actually reads', () => {
      const note = priorNoteWith([{ id: 'k', claim: 'claim 1', recheck: 'probe 1', verified: 'ok 1' }]);
      expect(splitCarryNoteChecks(note).checks[0]).toMatchObject({ id: 'k', claim: 'claim 1' });
    });
  });

  describe('upsert-by-id — identity independent of WORDING', () => {
    it('re-wording a claim under a stable id keeps its evidence and age, and is NOT a drop', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([{ id: 'k', claim: 'the old wording', recheck: 'probe', verified: 'ok' }]),
        baseNote: 'body',
        checks: [{ id: 'k', claim: 'a tightened wording' }],
        hasNoteWrite: true,
      });
      expect(merged.checks).toHaveLength(1);
      expect(merged.checks[0]).toMatchObject({ id: 'k', claim: 'a tightened wording', recheck: 'probe' });
      expect(merged.checks[0]?.verified).toContain('ok');
      // The point: the row was UPDATED, so nothing was lost and nothing is reported lost.
      expect(merged.droppedChecks).toEqual([]);
    });

    it('CONTROL — the same reword WITHOUT an id loses the evidence and reads as a drop', () => {
      // Calibration: without this, the case above would also pass for an implementation
      // that simply never drops anything.
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([{ claim: 'the old wording', recheck: 'probe', verified: 'ok' }]),
        baseNote: 'body',
        checks: [{ claim: 'a tightened wording' }],
        hasNoteWrite: true,
      });
      expect(merged.checks[0]?.verified).toBeUndefined();
      expect(merged.droppedChecks).toEqual(['the old wording']);
    });

    it('preserves sinceMs across a reword — age is evidence and must not reset', () => {
      const t0 = Date.parse('2026-08-01T00:00:00.000Z');
      const first = mergeCarryRows({
        priorNote: null,
        baseNote: 'body',
        checks: [{ id: 'k', claim: 'original' }],
        hasNoteWrite: true,
        nowMs: t0,
      });
      const second = mergeCarryRows({
        priorNote: first.note,
        baseNote: 'body',
        checks: [{ id: 'k', claim: 'reworded' }],
        hasNoteWrite: true,
        nowMs: t0 + 86_400_000,
      });
      expect(second.checks[0]?.sinceMs).toBe(t0);
    });
  });

  describe("rowsMode 'merge' — the rows you did not mention SURVIVE", () => {
    it('adding ONE row keeps the other five (the measured loss shape, now averted)', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2, 3, 4, 5].map(check)),
        baseNote: 'body',
        checks: [{ claim: 'a brand new claim' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.checks.map((c) => c.claim)).toEqual([
        'claim 1',
        'claim 2',
        'claim 3',
        'claim 4',
        'claim 5',
        'a brand new claim',
      ]);
      expect(merged.droppedChecks).toEqual([]);
      // Carried EVIDENCE survives, not merely the claim text (it keeps its original
      // verification stamp — inherited evidence is never re-stamped as fresh).
      expect(merged.checks[0]?.verified).toContain('ok 1');
    });

    it('CONTROL — the identical write under the default replace mode DOES drop them', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2, 3, 4, 5].map(check)),
        baseNote: 'body',
        checks: [{ claim: 'a brand new claim' }],
        hasNoteWrite: true,
      });
      expect(merged.checks).toHaveLength(1);
      expect(merged.droppedChecks).toHaveLength(5);
    });

    it('updates a mentioned row IN PLACE, keeping its position so the note does not reshuffle', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2, 3].map(check)),
        baseNote: 'body',
        checks: [{ claim: 'claim 2', verified: 'freshly re-verified' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.checks.map((c) => c.claim)).toEqual(['claim 1', 'claim 2', 'claim 3']);
      expect(merged.checks[1]?.verified).toContain('freshly re-verified');
    });

    it('merges WALLS by the same contract — an owner-gated commitment is the worst row to drop', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([], [1, 2].map(wall)),
        baseNote: 'body',
        walls: [{ claim: 'wall 3' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.walls.map((w) => w.claim)).toEqual(['wall 1', 'wall 2', 'wall 3']);
      expect(merged.droppedWalls).toEqual([]);
    });

    it('treats [] as a NO-OP, never a clear — a clear must stay deliberate', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2].map(check), [1].map(wall)),
        baseNote: 'body',
        checks: [],
        walls: [],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.checks.map((c) => c.claim)).toEqual(['claim 1', 'claim 2']);
      expect(merged.walls.map((w) => w.claim)).toEqual(['wall 1']);
      expect(merged.droppedChecks).toEqual([]);
    });

    it('CONTROL — replace + [] still clears, so merge did not make clearing impossible', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2].map(check)),
        baseNote: 'body',
        checks: [],
        hasNoteWrite: true,
      });
      expect(merged.checks).toEqual([]);
      expect(merged.droppedChecks).toEqual(['claim 1', 'claim 2']);
    });
  });

  describe('merge-cap eviction — supplied rows win only when the union overflows', () => {
    it('keeps the supplied row and evicts the carried tail', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => check(i + 1))),
        baseNote: 'body',
        checks: [{ claim: 'one row past the cap' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      // Supplied rows move first only because the union exceeds the cap.
      expect(merged.checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);
      expect(merged.checks.map((c) => c.claim)).toContain('one row past the cap');
      expect(merged.droppedChecks).toEqual([`claim ${CARRY_NOTE_MAX_CHECKS}`]);
      expect(merged.overflowChecks).toEqual([]);
    });

    it('keeps a supplied WALL and evicts the carried tail', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([], Array.from({ length: CARRY_NOTE_MAX_WALLS }, (_, i) => wall(i + 1))),
        baseNote: 'body',
        walls: [{ claim: 'one wall past the cap' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.walls.map((w) => w.claim)).toContain('one wall past the cap');
      expect(merged.droppedWalls).toEqual([`wall ${CARRY_NOTE_MAX_WALLS}`]);
      expect(merged.overflowWalls).toEqual([]);
    });

    it('is EMPTY on an ordinary write — it must not cry wolf on every checkpoint', () => {
      const merged = mergeCarryRows({
        priorNote: priorNoteWith([1, 2].map(check)),
        baseNote: 'body',
        checks: [{ claim: 'claim 3' }],
        hasNoteWrite: true,
        mode: 'merge',
      });
      expect(merged.overflowChecks).toEqual([]);
      expect(merged.overflowWalls).toEqual([]);
      // ...and on the carry-forward path, where nothing was supplied at all.
      const carried = mergeCarryRows({ priorNote: priorNoteWith([1].map(check)), baseNote: 'b', hasNoteWrite: true });
      expect(carried.overflowChecks).toEqual([]);
    });
  });
});
