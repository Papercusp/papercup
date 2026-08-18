/**
 * GATE_HELD_BY completeness marker (WI-39807).
 *
 * The line is the canonical answer to "what held the release?", and triage reads it as
 * the WHOLE answer. It is only the whole answer when the post-suite legs actually ran.
 *
 * On a red suite `runGreen` takes the `legsNotRun(...)` branch, which returns
 * `failingSignatures: []` — empty because nothing was MEASURED, not because nothing
 * failed. The line then renders test files only while its own prose still claimed to be
 * "post-suite LEG signatures AND failing TEST files, combined", with `truncated=false`
 * asserting completeness. Measured on this box 2026-08-18: `lint:tsc:scripts` was the
 * SOLE gate holder at 10:26Z (`GATE_HELD_BY count=1 entries=["lint:tsc:scripts"]`), then
 * disappeared from the line for six consecutive runs — not fixed, just never re-run,
 * because the suite began failing first. Six triage passes could read those logs and
 * conclude the typecheck leg was clean.
 *
 * `truncated` cannot carry this: it answers only "was the entries LIST clipped at 40".
 * The repo rule is that a bounded measurement must say so on the AGGREGATE, because the
 * aggregate is what gets read as a verdict.
 */
import { describe, expect, it } from 'vitest';

import { formatGateHeldByNote } from './green-checkpoint';

/** The exact predicate `hasGateHeldByLine` uses to find the canonical line. */
const CANONICAL_LINE = /^GATE_HELD_BY count=\d+ /m;

const FAILING_TESTS = ['lib/a.test.ts', 'lib/b.test.ts'];

/**
 * CALIBRATION CONTROL — the pre-fix formatter, kept permanently so the assertions below
 * are proven capable of failing. A guard that has never failed is a guard nobody tested,
 * and mutating the real source to prove it is unsafe on this shared, swept tree.
 */
function legacyFormatGateHeldByNote(
  failingTests: readonly string[] | undefined,
  _opts: { postSuiteMeasured?: boolean } = {},
): string {
  const maxEntries = 40;
  const entries = failingTests ?? [];
  return (
    `\n\nGATE_HELD_BY count=${entries.length} ` +
    `attribution=${entries.length ? 'attributed' : 'unattributed'} ` +
    `truncated=${entries.length > maxEntries} ` +
    `entries=${JSON.stringify(entries.slice(0, maxEntries))}` +
    (entries.length
      ? `\n(post-suite LEG signatures AND failing TEST files, combined — this is the list the gate held the release on)`
      : `\n(the gate decided RED but produced NO attributable leg signature or failing test file)`)
  );
}

/** The property under test, applied to whichever implementation is passed in. */
function declaresUnmeasuredPostSuite(
  fmt: typeof formatGateHeldByNote,
  failingTests: readonly string[] | undefined,
): boolean {
  const line = fmt(failingTests, { postSuiteMeasured: false });
  return line.includes('postSuite=not-measured');
}

describe('formatGateHeldByNote — post-suite completeness', () => {
  it('marks the line when the post-suite legs were SKIPPED, and drops the combined-list claim', () => {
    const note = formatGateHeldByNote(FAILING_TESTS, { postSuiteMeasured: false });

    expect(note).toContain('postSuite=not-measured');
    // The false completeness claim must be gone — this is the sentence triage acted on.
    expect(note).not.toContain('combined — this is the list the gate held the release on');
    // And the reader must be told the empty leg half is UNMEASURED, not clean.
    expect(note).toMatch(/FLOOR, NOT THE FULL LIST/);
  });

  it('CALIBRATION: the pre-fix formatter FAILS that property (the assertion is not vacuous)', () => {
    expect(declaresUnmeasuredPostSuite(formatGateHeldByNote, FAILING_TESTS)).toBe(true);
    expect(declaresUnmeasuredPostSuite(legacyFormatGateHeldByNote, FAILING_TESTS)).toBe(false);
  });

  it('leaves the measured line byte-identical to the legacy line (no blast radius on a normal red)', () => {
    // A run whose legs DID execute must be unchanged, so existing log consumers,
    // dashboards and greps see exactly what they saw before.
    expect(formatGateHeldByNote(FAILING_TESTS, { postSuiteMeasured: true })).toBe(
      legacyFormatGateHeldByNote(FAILING_TESTS),
    );
  });

  it('treats an OMITTED flag as unknown and keeps the legacy line (never guesses "measured")', () => {
    // The early-preflight path cannot know. Reporting nothing beats asserting either way.
    expect(formatGateHeldByNote(FAILING_TESTS)).toBe(
      legacyFormatGateHeldByNote(FAILING_TESTS),
    );
    expect(formatGateHeldByNote(FAILING_TESTS)).not.toContain('postSuite=');
  });

  it('does not let an EMPTY unmeasured list read as "nothing held it"', () => {
    // The worst case: zero parsed failing tests AND no legs measured. The pre-existing
    // zero-entry prose says the gate produced no attributable signature — true, but it
    // invites "so it was a flake". The unmeasured warning has to win here.
    const note = formatGateHeldByNote([], { postSuiteMeasured: false });

    expect(note).toContain('count=0');
    expect(note).toContain('postSuite=not-measured');
    expect(note).toMatch(/FLOOR, NOT THE FULL LIST/);
    expect(note).toContain('does NOT mean the gate would go green');
  });

  it('keeps the machine-readable anchor intact in every mode', () => {
    // WI-37636: consumers grep this line; the `count=` anchor must stay adjacent so a
    // vitest test NAME echoed into the same log cannot impersonate it.
    for (const opts of [
      undefined,
      { postSuiteMeasured: true },
      { postSuiteMeasured: false },
    ]) {
      const note = formatGateHeldByNote(FAILING_TESTS, opts);
      expect(note, JSON.stringify(opts)).toMatch(CANONICAL_LINE);
      expect(note, JSON.stringify(opts)).toContain('entries=');
    }
  });
});
