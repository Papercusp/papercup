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

const sample = (over: Partial<DispatchAdoptionSample> = {}): DispatchAdoptionSample => ({
  dispatchCalls: 40,
  dispatchAgents: 8,
  sendCalls: 4_000,
  windowDays: 30,
  asOf: '2026-09-10',
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
