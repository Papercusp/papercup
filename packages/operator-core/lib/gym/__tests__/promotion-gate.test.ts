/**
 * P-002 / D-004(3) — the promotion gate, unit-level.
 *
 * The property under test is fail-closed-ness, and the interesting cases are all
 * ABSENCES: no verdict, no real-anchor gate, a gate that ran but measured nothing. Each
 * one is a way for a challenger to reach the live prompt without ever having been shown
 * to hold the real-anchor pool, which is precisely what D-004 ruled out — and each one
 * is easy to write a gate that silently treats as "fine".
 */
import { describe, it, expect } from 'vitest';
import { realAnchorHeld, REAL_ANCHOR_GATE } from '../promotion-gate';
import type { CandidateVersionVerdict } from '../loop';
import type { GateResult, GateStatus } from '../gates';

const OVERLAY = { promptOverrides: {} } as CandidateVersionVerdict['variant'];

function verdict(gateResults: GateResult[]): CandidateVersionVerdict {
  return {
    schemaVersion: 1,
    candidateId: 'cand-1',
    parentId: 'baseline',
    variant: OVERLAY,
    parent: OVERLAY,
    hashes: { variantHash: 'v', parentHash: 'p', evaluatorHash: 'e', rubricHash: 'r', taskHash: 't', codeHash: 'c' },
    gateResults,
    verdict: 'accept',
    recordedAt: 0,
  };
}

function gate(name: string, status: GateStatus, detail = 'd'): GateResult {
  return { gate: name, pass: status === 'pass', status, detail };
}

describe('realAnchorHeld — P-002 / D-004(3) install gate', () => {
  it('holds only on an affirmative measured pass', () => {
    const res = realAnchorHeld(verdict([gate('improvement', 'pass'), gate(REAL_ANCHOR_GATE, 'pass')]));
    expect(res).toEqual({ held: true, reason: null, detail: null });
  });

  it('refuses a MEASURED regression as real_anchor_regressed', () => {
    const res = realAnchorHeld(verdict([gate(REAL_ANCHOR_GATE, 'fail', 'margin -0.4')]));
    expect(res.held).toBe(false);
    expect(res.reason).toBe('real_anchor_regressed');
    expect(res.detail).toBe('margin -0.4'); // the gate's own detail survives to the caller
  });

  /**
   * The three absences. They are separated from the failure above because they call for
   * the opposite response — run the pool, rather than abandon the candidate — and a gate
   * that collapsed them would make "we never scored it" indistinguishable from "it got
   * worse" in the one record that later has to explain why the live prompt is what it is.
   */
  it.each([
    ['no verdict at all', null],
    ['a verdict with no gates', verdict([])],
    ['a verdict whose gates predate P-002', verdict([gate('improvement', 'pass'), gate('cost', 'pass')])],
    ['a real-anchor gate that ran but measured nothing', verdict([gate(REAL_ANCHOR_GATE, 'not-measured')])],
  ])('refuses %s as real_anchor_unproven', (_label, candidate) => {
    const res = realAnchorHeld(candidate as CandidateVersionVerdict | null);
    expect(res.held).toBe(false);
    expect(res.reason).toBe('real_anchor_unproven');
  });

  it('refuses undefined and a structurally broken verdict rather than throwing', () => {
    expect(realAnchorHeld(undefined).held).toBe(false);
    // A row read back from jsonb can be any shape; the gate must not crash the accept
    // path into a 500 that a caller could mistake for infrastructure flakiness.
    expect(realAnchorHeld({ gateResults: 'not-an-array' } as unknown as CandidateVersionVerdict).held).toBe(false);
  });

  /**
   * CONTROL — a deliberately-wrong gate kept permanently in the test file (never a
   * mutation of the shipped module, which this shared tree would sweep into a commit).
   * It is the implementation you write if you think about it for ten seconds: read the
   * derived `pass` boolean, and treat a gate that isn't there as nothing to object to.
   *
   * Note WHERE it is wrong, because it is narrower than it first looks. It is correct on
   * `not-measured` — `pass` is derived from `status`, so an unmeasured gate already reads
   * false — which is exactly what makes the shape plausible enough to ship. It is wrong
   * only when the gate is ABSENT, and absent is the state every pre-P-002 proposal in the
   * table is in. The bug is in the default, not the comparison.
   */
  const permissive = (c: CandidateVersionVerdict | null): boolean => {
    const g = c?.gateResults?.find((x) => x.gate === REAL_ANCHOR_GATE);
    return g ? g.pass : true;
  };

  it('control: the permissive implementation agrees wherever the gate is PRESENT, and installs wherever it is absent', () => {
    // Calibration — on a present gate the two agree in both directions, so the absence
    // cases below isolate the default rather than some unrelated disagreement.
    for (const status of ['pass', 'fail', 'not-measured'] as const) {
      const v = verdict([gate(REAL_ANCHOR_GATE, status)]);
      expect(permissive(v)).toBe(realAnchorHeld(v).held);
    }

    // The divergence: a verdict with no real-anchor gate at all — no verdict, no gates,
    // or a pre-P-002 gate set. Every proposal recorded before P-002 is one of these.
    for (const absent of [null, verdict([]), verdict([gate('cost', 'pass'), gate('improvement', 'pass')])]) {
      expect(permissive(absent)).toBe(true); // the wrong answer: install it …
      expect(realAnchorHeld(absent).held).toBe(false); // … and the one we ship
    }
  });
});
