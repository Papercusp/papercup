import { describe, expect, it } from 'vitest';

import { SPEC_ADEQUACY_ATTESTATION_GUIDANCE } from './agent-tools/work_items/spec-test-adequacy-gate';

/**
 * WI-10002335 — recurrence guard for a class, not an instance.
 *
 * THE CLASS: a refusal message that PRESCRIBES a remedy must prescribe one that works.
 * A refusal is read at exactly the moment the caller is most willing to comply, so a
 * laborious remedy named there is obeyed — and if the gate already does that work itself,
 * every complying caller pays for nothing.
 *
 * THE INSTANCE: this message used to end "with `classRef` and current evidence
 * fingerprints". The gate resolves every fingerprint dimension ITSELF; `classRef` alone
 * closes an item whose evidence is green. Measured cost on plan
 * turn-start-memory-two-class-2026-09-21: the wording was promoted into plan Decision
 * D-038 ("fingerprints you COPY from the evaluator") and cost several agents a rebind
 * cycle each before a one-key close disproved it.
 *
 * FALSIFIABILITY: the pre-fix text is kept verbatim below as a PERMANENT in-test control
 * and is asserted to FAIL both checks. Nothing in the shared tree is mutated to prove this
 * — git-sync sweeps the whole working tree on a schedule, so a probe that mutates a
 * tracked file can have its mutant committed even when nothing goes wrong.
 */

/** The verbatim remedy this message carried BEFORE the fix. Do not "tidy" it — it is the control. */
const HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS =
  'pass a TOP-LEVEL `specAdequacy` argument to work_items:complete — a SIBLING of ' +
  '`completion`, never nested inside it (`completion.specAdequacy` is rejected) — ' +
  'with `classRef` and current evidence fingerprints';

/** Clauses are the unit of prescription: one sentence can demand and the next exonerate. */
function clausesMentioningFingerprints(text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+|\s+—\s+/)
    .filter((clause) => /fingerprint/i.test(clause));
}

/**
 * Does this clause ask the CALLER to produce fingerprints, rather than telling them the
 * gate produces them? Keyed on the demand/exoneration pairing rather than one fixed
 * spelling, so a reworded prescription is still caught.
 */
function prescribesCallerAuthoredFingerprints(clause: string): boolean {
  const exonerates =
    /\b(?:do not|don't|never)\b[^.]*\b(?:hand-author|author|supply|provide|pass|include)\b/i.test(clause) ||
    /\bgate\b[^.]*\bresolves\b/i.test(clause) ||
    /\bitself\b/i.test(clause);
  const demands = /\b(?:pass|supply|provide|include|author|populate|attach|with|and)\b/i.test(clause);
  return demands && !exonerates;
}

/** Does the remedy state that `classRef` on its own is enough? */
function assertsClassRefSufficiency(text: string): boolean {
  return /\bclassRef\b[^.]*\b(?:only|alone|sufficient|suffices|on its own)\b/i.test(text);
}

describe('spec-adequacy refusal prescribes a remedy the caller can actually follow', () => {
  it('does not instruct the caller to hand-author evidence fingerprints', () => {
    const prescribing = clausesMentioningFingerprints(SPEC_ADEQUACY_ATTESTATION_GUIDANCE).filter(
      prescribesCallerAuthoredFingerprints,
    );
    expect(prescribing).toEqual([]);
  });

  it('states that classRef alone is sufficient', () => {
    expect(assertsClassRefSufficiency(SPEC_ADEQUACY_ATTESTATION_GUIDANCE)).toBe(true);
  });

  describe('control: the pre-fix remedy must FAIL both checks', () => {
    // Calibration first. If a later edit hollows the control out, these fail loudly rather
    // than letting the control pass vacuously and report a guard that cannot fail.
    it('is still detector-shaped (mentions both fingerprints and classRef)', () => {
      expect(HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS).toMatch(/fingerprint/i);
      expect(HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS).toMatch(/classRef/);
      expect(clausesMentioningFingerprints(HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS).length).toBeGreaterThan(0);
    });

    it('is caught by the fingerprint-prescription check', () => {
      const prescribing = clausesMentioningFingerprints(HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS).filter(
        prescribesCallerAuthoredFingerprints,
      );
      expect(prescribing.length).toBeGreaterThan(0);
    });

    it('is caught by the classRef-sufficiency check', () => {
      expect(assertsClassRefSufficiency(HISTORICAL_REMEDY_THAT_PRESCRIBED_FINGERPRINTS)).toBe(false);
    });
  });
});
