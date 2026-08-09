/**
 * P-007 — the dead-derived-signal probe's predicates.
 *
 * Every case pins a distinction whose loss produces a green detector over a dead
 * signal. The two most valuable are the vacuous-pass controls: a probe that cannot
 * enumerate its subjects, and a probe reading an empty census window, must BOTH
 * refuse to report a clean run — those are the exact shapes that let a real dead
 * signal read as healthy.
 */
// prettier-ignore — ENFORCES the "ONE line" rule below rather than merely documenting it:
// prettier wants to reflow this import into a multi-line list, which is exactly what unguards
// the specifier. It sits above the pair because @ts-ignore must own the slot nearest the import.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS gate script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { CENSUS_KEY, FAILING_VERDICTS, FIRING_VERDICTS, RELATIONS_SOURCE, RULINGS, formatReport, isPastReview, judgeSignalFiring, parseDeclaredRelations, rollupFirings } from '../../../scripts/check-derived-signal-firings.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DERIVED_COUPLING_RELATIONS } from './coord/couplings';

/**
 * Resolved through `RELATIONS_SOURCE` itself rather than a second hand-written
 * path, so a constant that stops pointing at the real file fails HERE instead of
 * degrading the shipped probe into a silent no-subjects run.
 */
const relationsSourceText = () => readFileSync(new URL(`../../../${RELATIONS_SOURCE}`, import.meta.url), 'utf8');
const now = new Date('2026-08-09T00:00:00Z');

const counts = (o: Partial<Record<string, number | boolean>> = {}) => ({
  runs: 10,
  armedRuns: 10,
  inputRuns: 10,
  edges: 0,
  windowHadCensus: true,
  ...o,
});

describe('judgeSignalFiring — the six-way split', () => {
  it('edges delivered is firing', () => {
    expect(judgeSignalFiring(counts({ edges: 3 }))).toBe('firing');
  });

  /** D-088's defect: runs happened, the input was never wired in. */
  it('runs with the input never wired in is never-armed, not merely silent', () => {
    expect(judgeSignalFiring(counts({ armedRuns: 0, inputRuns: 0 }))).toBe('never-armed');
  });

  /** `current_files`'s shape: wired and consulted, input empty every run. */
  it('wired but never given input is starved, not never-armed', () => {
    expect(judgeSignalFiring(counts({ inputRuns: 0 }))).toBe('starved');
  });

  it('wired, fed, and still emitting nothing is armed-silent (usually honest scarcity)', () => {
    expect(judgeSignalFiring(counts())).toBe('armed-silent');
  });

  /**
   * The census contract is to emit EVERY relation including zeros, so a relation
   * absent from every census row means the DETECTOR has gone blind — a new relation
   * added without coverage, or a schema drift. Collapsing it into `no-data` would
   * hide a hole in the thing doing the detecting.
   */
  it('a relation the census never mentioned is unobserved, not no-data', () => {
    expect(judgeSignalFiring(counts({ runs: 0, armedRuns: 0, inputRuns: 0 }))).toBe('unobserved');
  });

  /**
   * ⚠ THE VACUOUS-PASS CONTROL. An empty window (fresh DB, pruned table, code not
   * yet deployed) makes every relation look dead. Reporting that as a finding is a
   * confident wrong answer shaped exactly like a real one.
   */
  it('an empty census window is no-data — never a finding, never a pass', () => {
    expect(judgeSignalFiring(counts({ windowHadCensus: false }))).toBe('no-data');
    // ...even when the per-relation counters would otherwise look damning.
    expect(judgeSignalFiring(counts({ windowHadCensus: false, runs: 0, armedRuns: 0, inputRuns: 0 }))).toBe(
      'no-data',
    );
  });

  /**
   * ORDER IS LOAD-BEARING. Delivered output settles the question; letting arming
   * bookkeeping override it would make the detector deny real, observed firings.
   */
  it('delivered edges win over a disagreeing armed count', () => {
    expect(judgeSignalFiring(counts({ edges: 2, armedRuns: 0, inputRuns: 0 }))).toBe('firing');
  });

  it('coerces junk counters instead of emitting a verdict outside the vocabulary', () => {
    const v = judgeSignalFiring({
      runs: 'x',
      armedRuns: null,
      inputRuns: undefined,
      edges: NaN,
      windowHadCensus: true,
    });
    expect(FIRING_VERDICTS).toContain(v);
    expect(v).toBe('unobserved');
  });
});

describe('only decidable defects can fail the gate', () => {
  it('fails on never-armed and unobserved, and on nothing else', () => {
    expect([...FAILING_VERDICTS].sort()).toEqual(['never-armed', 'unobserved']);
  });

  /**
   * `starved` and `armed-silent` are judgement calls — a week with no overlapping
   * locks is indistinguishable from a dead relation without a human. A gate that
   * failed on them would red-pin the fleet on quiet traffic.
   */
  it('never fails on the two verdicts that have a benign reading', () => {
    expect(FAILING_VERDICTS).not.toContain('starved');
    expect(FAILING_VERDICTS).not.toContain('armed-silent');
    expect(FAILING_VERDICTS).not.toContain('no-data');
  });
});

describe('parseDeclaredRelations — the probe must not carry its own stale copy', () => {
  it('recovers the live vocabulary from the real source file', () => {
    expect(parseDeclaredRelations(relationsSourceText()).sort()).toEqual(
      [...DERIVED_COUPLING_RELATIONS].sort(),
    );
  });

  /**
   * ⚠ A REAL TRAP, NOT A HYPOTHETICAL. The array literal opens with a multi-line
   * tombstone for the retired `same-fleet` relation that quotes the owner verbatim
   * — quoted prose inside a comment, inside the array. Harvesting string literals
   * without stripping comments first resurrects a relation D-054 cut, and the probe
   * would then report a permanent `unobserved` for a signal that no longer exists.
   */
  it('does not resurrect a retired relation named in a comment', () => {
    expect(parseDeclaredRelations(relationsSourceText())).not.toContain('same-fleet');
    expect(
      parseDeclaredRelations(`
        export const DERIVED_COUPLING_RELATIONS = [
          // the owner cut 'same-fleet' — "FLEETS CAN HAVE 30 MEMBERS"
          /* and 'another-dead-one' went with it */
          'awaits',
        ] as const;
      `),
    ).toEqual(['awaits']);
  });

  /**
   * ⚠ THE SECOND VACUOUS-PASS CONTROL. [] means the probe has no subjects and has
   * therefore measured NOTHING; `main()` treats it as a hard error. If this ever
   * silently became "no relations to check", the probe would go permanently green
   * in exactly the way it exists to detect.
   */
  it('returns [] rather than guessing when the source shape changes', () => {
    expect(parseDeclaredRelations('export const SOMETHING_ELSE = [ ]')).toEqual([]);
    expect(parseDeclaredRelations('')).toEqual([]);
    expect(parseDeclaredRelations(null)).toEqual([]);
  });
});

describe('rollupFirings — review dates and rulings', () => {
  const row = (o: Record<string, unknown>) => ({
    relation: 'holds-a-lock-on',
    runs: 5,
    armedRuns: 0,
    inputRuns: 0,
    edges: 0,
    verdict: 'never-armed',
    reviewBy: '2026-09-13',
    ...o,
  });

  it('reports a dead signal before its review date without failing', () => {
    const roll = rollupFirings([row({})], now);
    expect(roll.failing).toHaveLength(0);
    expect(roll.pending).toHaveLength(1);
    expect(roll.neverArmed).toBe(1);
  });

  it('fails once the review date has arrived', () => {
    const roll = rollupFirings([row({ reviewBy: '2026-08-01' })], now);
    expect(roll.failing).toHaveLength(1);
    expect(roll.pending).toHaveLength(0);
  });

  it('a ruling suppresses failure permanently but never suppresses the report', () => {
    const roll = rollupFirings([row({ reviewBy: '2026-08-01', ruling: 'intended' })], now);
    expect(roll.failing).toHaveLength(0);
    expect(roll.ruled).toBe(1);
    expect(roll.neverArmed).toBe(1);
    expect(formatReport([row({ reviewBy: '2026-08-01', ruling: 'intended' })], roll, now)).toContain('RULED');
  });

  it('a starved relation never reaches the failing set even past review', () => {
    const roll = rollupFirings([row({ verdict: 'starved', reviewBy: '2026-08-01' })], now);
    expect(roll.failing).toHaveLength(0);
    expect(roll.starved).toBe(1);
  });

  it('isPastReview refuses to fail on an unparseable date', () => {
    expect(isPastReview('not-a-date', now)).toBe(false);
    expect(isPastReview('2026-08-01', now)).toBe(true);
    expect(isPastReview('2026-09-13', now)).toBe(false);
  });
});

describe('the report distinguishes "we looked and found nothing" from "we looked at nothing"', () => {
  const rows = DERIVED_COUPLING_RELATIONS.map((relation) => ({
    relation,
    runs: 0,
    armedRuns: 0,
    inputRuns: 0,
    edges: 0,
    verdict: 'no-data',
    reviewBy: '2026-09-13',
  }));

  it('says NO CENSUS DATA rather than claiming every relation is accounted for', () => {
    const out = formatReport(rows, rollupFirings(rows, now), now, { censusRows: 0 });
    expect(out).toContain('NO CENSUS DATA');
    expect(out).not.toContain('✓ every derived relation');
  });

  it('names the census key it read, so a schema drift is diagnosable from the report', () => {
    expect(CENSUS_KEY).toBe('derivedSignals');
    expect(formatReport(rows, rollupFirings(rows, now), now, { censusRows: 0 })).toContain(RELATIONS_SOURCE);
  });

  it('the shipped ruling set names only relations that still exist', () => {
    const declared = new Set<string>(DERIVED_COUPLING_RELATIONS);
    const stale = Object.keys(RULINGS).filter((r) => !declared.has(r));
    expect(stale, `rulings for retired relations: ${stale.join(', ')}`).toEqual([]);
  });
});
