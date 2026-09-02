/**
 * dispatch-adoption-falsifier.test.ts — P-013 (coordination-spec-adoption-2026-08-03).
 *
 * Pins the two properties D-101's correction turned on: the metric is a RATE (so
 * an idle fleet cannot manufacture a RETIRE verdict), and an unmeasurable window
 * returns UNDETERMINED rather than being resolved toward either answer.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_ADOPTION_FLOOR,
  DISPATCH_BASELINE,
  evaluateDispatchAdoption,
  type DispatchAdoptionSample,
} from './dispatch-adoption-falsifier';

/**
 * A day past the re-evaluation gate, DERIVED from the floor rather than pinned.
 *
 * These cases are about the rate and agent logic, so the default sample has to
 * clear the date guard first — and when it does not, `evaluateDispatchAdoption`
 * returns `undetermined` for the WRONG REASON. That is invisible in the two
 * cases that expect `undetermined` anyway: they keep passing while asserting
 * nothing about reachability. Measured 2026-09-02 (WI-2142095), when
 * `reEvaluateAfter` moved 09-08 -> 09-16 and this was a hardcoded 2026-09-10:
 * seven cases went red and one — "returns UNDETERMINED when it was NOT
 * reachable" — was only caught because it matches on the `why` TEXT rather than
 * the verdict alone. Deriving the date means a future move of the gate cannot
 * quietly hollow these out.
 */
const AFTER_REEVALUATION_GATE = new Date(
  new Date(`${DISPATCH_ADOPTION_FLOOR.reEvaluateAfter}T00:00:00Z`).getTime() + 86_400_000,
)
  .toISOString()
  .slice(0, 10);

const sample = (over: Partial<DispatchAdoptionSample> = {}): DispatchAdoptionSample => ({
  dispatchCalls: 40,
  dispatchAgents: 8,
  sendCalls: 4_000,
  windowDays: 30,
  asOf: AFTER_REEVALUATION_GATE,
  interventionReachable: true,
  ...over,
});

describe('the baseline is the measurement it claims to be', () => {
  it('ratePerThousand matches its own numerator/denominator', () => {
    const derived = (DISPATCH_BASELINE.dispatchCalls / DISPATCH_BASELINE.sendCalls) * 1_000;
    expect(derived).toBeCloseTo(DISPATCH_BASELINE.ratePerThousand, 4);
  });

  it('the floor is above the baseline, or the test cannot fail in either direction', () => {
    expect(DISPATCH_ADOPTION_FLOOR.ratePerThousand).toBeGreaterThan(
      DISPATCH_BASELINE.ratePerThousand,
    );
  });
});

describe('evaluateDispatchAdoption', () => {
  it('KEEPs when the rate and the agent floor are both cleared', () => {
    const v = evaluateDispatchAdoption(sample());
    expect(v.verdict).toBe('keep');
    expect((v as { ratePerThousand: number }).ratePerThousand).toBeCloseTo(10, 4);
    expect((v as { liftVsBaseline: number }).liftVsBaseline).toBeGreaterThan(30);
  });

  it('RETIREs when usage stayed at the baseline despite the interventions', () => {
    const v = evaluateDispatchAdoption(sample({ dispatchCalls: 1, dispatchAgents: 1 }));
    expect(v.verdict).toBe('retire');
    // D-102 folded coord:handoff into this same measurement — one result, both doors
    expect((v as { alsoRetires: readonly string[] }).alsoRetires).toEqual([
      'coord:dispatch',
      'coord:handoff',
    ]);
    expect((v as { finding: string }).finding).toMatch(/does not hand off lanes/);
  });

  it('RETIREs on a good rate carried by too few agents', () => {
    // 40 calls from one enthusiast is exactly what the raw-count test could not
    // distinguish from real adoption.
    const v = evaluateDispatchAdoption(sample({ dispatchAgents: 1 }));
    expect(v.verdict).toBe('retire');
    expect((v as { why: string }).why).toMatch(/1 agent\(s\) < 3/);
  });

  // ── the correction D-101 made, stated as a test ──────────────────────────
  it('an IDLE fleet is UNDETERMINED, never a retire — the bug the count-based test had', () => {
    const v = evaluateDispatchAdoption(
      sample({ dispatchCalls: 0, dispatchAgents: 0, sendCalls: 120 }),
    );
    expect(v.verdict).toBe('undetermined');
    expect((v as { why: string }).why).toMatch(/too quiet/);
  });

  it('the same zero-usage sample DOES retire once the denominator is real', () => {
    // The control for the case above: it is the DENOMINATOR that made it
    // unjudgeable, not the zero — otherwise the guard would be unfalsifiable.
    const v = evaluateDispatchAdoption(
      sample({ dispatchCalls: 0, dispatchAgents: 0, sendCalls: 4_000 }),
    );
    expect(v.verdict).toBe('retire');
  });

  it('refuses to judge before the interventions have had a full window', () => {
    const v = evaluateDispatchAdoption(sample({ asOf: '2026-08-20' }));
    expect(v.verdict).toBe('undetermined');
    expect((v as { why: string }).why).toMatch(/full window/);
  });

  it('always publishes its denominator, whatever the verdict (D-003)', () => {
    for (const s of [
      sample(),
      sample({ dispatchCalls: 1, dispatchAgents: 1 }),
      sample({ sendCalls: 10 }),
    ]) {
      const v = evaluateDispatchAdoption(s);
      expect(v.denominator).toEqual({ sendCalls: s.sendCalls, windowDays: s.windowDays });
    }
  });
});

/**
 * The retire branch asserts its OWN precondition — that the verb "was seeded onto
 * the live surface". Measured 2026-09-02 (WI-2142095) that was false: coord:dispatch
 * sits only in QUEEN_MCP_TOOL_NAMES, the retired mug tier. Firing RETIRE on such a
 * window would read a DELIVERY gap as falsified DEMAND — the precise conflation this
 * falsifier was built to prevent, committed by the falsifier itself.
 */
describe('an unreachable intervention cannot produce a RETIRE verdict', () => {
  const failing = { dispatchCalls: 0, dispatchAgents: 0 };

  it('RETIREs on a failing sample when the intervention WAS reachable', () => {
    // Calibration: without this, the test below passes for the wrong reason.
    const v = evaluateDispatchAdoption(sample({ ...failing, interventionReachable: true }));
    expect(v.verdict).toBe('retire');
  });

  it('returns UNDETERMINED instead when it was NOT reachable', () => {
    const v = evaluateDispatchAdoption(sample({ ...failing, interventionReachable: false }));
    expect(v.verdict).toBe('undetermined');
    expect((v as { why: string }).why).toMatch(/NOT REACHABLE/);
    expect((v as { why: string }).why).toMatch(/WI-2142095/);
  });

  it('still publishes its denominator when the precondition fires (D-003)', () => {
    const s = sample({ ...failing, interventionReachable: false });
    const v = evaluateDispatchAdoption(s);
    expect(v.denominator).toEqual({ sendCalls: s.sendCalls, windowDays: s.windowDays });
  });

  it('does NOT suppress a genuine KEEP — calls prove their own reachability', () => {
    // The precondition guards the destructive direction only, mirroring the
    // documented asymmetry (undetermined is never upgraded to retire).
    const v = evaluateDispatchAdoption(sample({ interventionReachable: false }));
    expect(v.verdict).toBe('keep');
  });
});
