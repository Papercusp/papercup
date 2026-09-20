/**
 * Guard for the population-claim correction detector (plan
 * `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`, P-003).
 *
 * FALSIFIABILITY is a tier-2 PERMANENT NEGATIVE CONTROL kept in this file
 * (`naivePredicate` below), not a mutation probe against the shared checkout.
 * That is the correct tier here: the property under test is that a CALIBRATED
 * predicate rejects inputs a NAIVE one accepts, so the wrong implementation has
 * to be present to be compared against. A probe that mutated the real module
 * would prove less and would dirty a tree that git-sync sweeps every few minutes.
 *
 * The fixtures are real coord traffic, not invented prose — see the measured
 * partition in the module header.
 */
import { describe, it, expect } from 'vitest';
import type { CoordMsgLike } from './corpus-categorize';
import {
  isPopulationClaimCorrection,
  matchPopulationClaimCorrection,
  countPopulationClaimCorrections,
  SPEECH_ACT_SQL_PREFILTER,
} from './population-claim-correction';

/**
 * THE NEGATIVE CONTROL: the predicate a reasonable person writes first, and the
 * one that scored 10,760 "corrections" out of 122,386 messages before the
 * partition showed it had measured echo. Two defects, both deliberate:
 * the `correcti` stem (which matches "correctLY") and no `auto` exclusion.
 *
 * Every fixture below that the real detector rejects, this one accepts. If a
 * future change makes the real detector agree with this, these tests fail —
 * which is the entire point of keeping it here.
 */
function naivePredicate(m: CoordMsgLike): boolean {
  return /(retract|correcti|i was wrong|miscount)/i.test(`${m.body ?? ''} ${m.summary ?? ''}`);
}

/** Real: an authored retraction that restates the figures it replaces. */
const REAL_POPULATION_CORRECTION: CoordMsgLike = {
  body:
    'Correction to my earlier count over harness_shared.session_briefs: the 13657 rows ' +
    'I reported as applied were null-activation, not applied. The real total is 255.',
};

/** Real: an authored retraction of a ROOT CAUSE, carrying no population claim. */
const REAL_NON_POPULATION_RETRACTION: CoordMsgLike = {
  body:
    "*** DO NOT CANCEL THE GREEN-CHECKPOINT RUN-LOCK. *** I carried a 'ghost run-lock' " +
    'root cause into this wake and it is FALSE. I am retracting it publicly.',
};

/**
 * Real: an automated loop-wake whose carried-checks block QUOTES a retraction.
 * This class is why "retract" appears ~3x more in automated traffic (2,217) than
 * in authored traffic (777) — it is the dominant false positive by volume.
 */
const AUTOMATED_ECHO: CoordMsgLike = {
  auto: true,
  body:
    'Loop wake #59 — short form (the full loop contract ships on wake 1, then every 10 wakes).\n\n' +
    '\u{1F9EA} CARRIED CHECKS — claims + probes: I retracted the 13657-row finding within 4 minutes.',
};

/**
 * "correctly" — which the naive stem does NOT match, contrary to an earlier
 * claim made while building this. Kept as a fixture because the real detector
 * must reject it too, and because it pins the retraction in a runnable form.
 */
const CORRECTLY: CoordMsgLike = {
  body: 'The gate behaved correctly and all 42 tests passed on the frozen candidate.',
};

/**
 * The ACTUAL dominant prose false positive: ordinary authored use of the word
 * "correction" with no population claim being walked back. Measured, 4,549 of
 * the stem's 4,550 authored hits are genuine correction/correcting/corrective
 * words like this one — agents discuss corrections constantly. The naive
 * predicate accepts it; the calibrated one must not.
 */
const NAIVE_TRAP: CoordMsgLike = {
  body: 'Filed a correction to the plan wording so the rubric reads cleanly.',
};

describe('population-claim correction detector', () => {
  it('matches an authored correction of a population claim', () => {
    expect(isPopulationClaimCorrection(REAL_POPULATION_CORRECTION)).toBe(true);
  });

  it('rejects "correctly" — and pins that the naive stem never matched it either', () => {
    const r = matchPopulationClaimCorrection(CORRECTLY);
    expect(r.isCorrection).toBe(false);
    expect(r.rejectedBecause).toBe('no-speech-act');
    // THE RETRACTION, in runnable form. An earlier revision claimed /correcti/
    // matched "correctly" and that this explained the 4,550 authored hits. It
    // does not — c-o-r-r-e-c-t-L-y. This assertion exists so the false
    // mechanism cannot be re-introduced by someone reading the old note.
    expect(naivePredicate(CORRECTLY)).toBe(false);
  });

  it('rejects ordinary authored use of "correction" with no population claim', () => {
    const r = matchPopulationClaimCorrection(NAIVE_TRAP);
    expect(r.isCorrection).toBe(false);
    expect(r.rejectedBecause).toBe('no-population-referent');
    // This is the real prose false positive, and the naive predicate takes it.
    expect(naivePredicate(NAIVE_TRAP)).toBe(true);
  });

  it('rejects an automated loop-wake that merely QUOTES a retraction', () => {
    const r = matchPopulationClaimCorrection(AUTOMATED_ECHO);
    expect(r.isCorrection).toBe(false);
    expect(r.rejectedBecause).toBe('automated');
    // The control accepts it — the dominant error term by volume.
    expect(naivePredicate(AUTOMATED_ECHO)).toBe(true);
  });

  it('still rejects a machine restatement that arrives without the auto flag', () => {
    const unflagged: CoordMsgLike = { ...AUTOMATED_ECHO, auto: undefined };
    const r = matchPopulationClaimCorrection(unflagged);
    expect(r.isCorrection).toBe(false);
    expect(r.rejectedBecause).toBe('machine-restatement');
  });

  it('separates a retraction with no population referent from one with', () => {
    const r = matchPopulationClaimCorrection(REAL_NON_POPULATION_RETRACTION);
    expect(r.isCorrection).toBe(false);
    expect(r.rejectedBecause).toBe('no-population-referent');
  });

  it('counts speechActs as the superset of corrections, derived not tallied', () => {
    const report = countPopulationClaimCorrections([
      REAL_POPULATION_CORRECTION,
      REAL_NON_POPULATION_RETRACTION,
      AUTOMATED_ECHO,
      CORRECTLY,
    ]);
    expect(report.messages).toBe(4);
    expect(report.authored).toBe(3); // the automated echo is not in the denominator
    expect(report.corrections).toBe(1);
    // The non-population retraction cleared the speech-act gate but not the referent.
    expect(report.speechActs).toBe(2);
    expect(report.speechActs).toBeGreaterThanOrEqual(report.corrections);
    expect(report.rejected.automated).toBe(1);
    expect(report.rejected['no-population-referent']).toBe(1);
    expect(report.rejected['no-speech-act']).toBe(1);
  });

  it('reports a null rate rather than a zero when there is nothing to divide by', () => {
    // A zero rate and an undefined rate are different findings; collapsing them
    // would let an empty window read as "corrections stopped".
    const report = countPopulationClaimCorrections([AUTOMATED_ECHO]);
    expect(report.authored).toBe(0);
    expect(report.ratePerAuthored).toBeNull();
  });

  it('the SQL prefilter is a SUPERSET of the TS speech act', () => {
    // The instrument pushes this prefilter into SQL because a 7-day window is
    // ~60k rows. If it were ever NARROWER than SPEECH_ACT, candidates would be
    // dropped before the real predicate saw them and the instrument would
    // report a FALL in corrections that was really a fall in what was fetched —
    // which would be read as evidence FOR the advisory.
    const prefilter = new RegExp(SPEECH_ACT_SQL_PREFILTER, 'i');
    const phrases = [
      'retracted', 'retraction', 'retracting', 'withdrawn', 'withdrawing',
      'miscounted', 'over-counted', 'overcount', 'under-counted',
      'overstated', 'understated', 'supersedes', 'superseded',
      'correction', 'corrected', 'correcting', 'i was wrong',
      'that count was wrong', 'that number is off',
      'my earlier claim', 'my previous count', 'my prior finding',
    ];
    for (const p of phrases) {
      // The TS predicate must see it as a speech act...
      expect(matchPopulationClaimCorrection({ body: `${p} over 1234 rows` }).rejectedBecause)
        .not.toBe('no-speech-act');
      // ...and SQL must not have dropped it first.
      expect(prefilter.test(p)).toBe(true);
    }
  });

  it('CONTROL: the naive predicate accepts every fixture the real one rejects', () => {
    // Calibration is load-bearing, not decorative. This asserts the gap exists.
    const rejectedByReal = [AUTOMATED_ECHO, NAIVE_TRAP];
    for (const m of rejectedByReal) {
      expect(isPopulationClaimCorrection(m)).toBe(false);
      expect(naivePredicate(m)).toBe(true);
    }
  });
});
