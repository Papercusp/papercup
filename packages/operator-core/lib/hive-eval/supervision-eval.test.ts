import { describe, it, expect } from 'vitest';
import {
  measureLivenessDetection,
  measureBehavioralDetection,
  measureSupervision,
  ekgDriftDetector,
  EXPECTED_RECOVERY_LATENCY_MS,
  type BehavioralDetector,
} from './supervision-metrics';
import { SUPERVISION_CASES, casesForFamily } from './supervision-scenarios';

const outcome = (r: { outcomes: { caseId: string; detected: boolean; latencyMs: number | null }[] }, id: string) =>
  r.outcomes.find((o) => o.caseId === id)!;

describe('supervision corpus', () => {
  it('every misbehaving case has a healthy control sibling in its family (false-positive denominator)', () => {
    for (const fam of ['liveness', 'behavioral'] as const) {
      const cs = casesForFamily(fam);
      expect(cs.some((c) => c.misbehaving)).toBe(true);
      expect(cs.some((c) => !c.misbehaving)).toBe(true); // a control exists
    }
  });
});

describe('measureLivenessDetection (P-064) — the built liveness family', () => {
  const r = measureLivenessDetection();

  it('detects BOTH hung modes (stale heartbeat + silent output) — 100% detection rate', () => {
    expect(outcome(r, 'liveness-hung-heartbeat').detected).toBe(true);
    expect(outcome(r, 'liveness-hung-silent').detected).toBe(true);
    expect(r.detectionRate).toBe(1);
  });

  it('measures recovery latency at the REAL thresholds (rounded to the next sweep)', () => {
    expect(outcome(r, 'liveness-hung-heartbeat').latencyMs).toBe(EXPECTED_RECOVERY_LATENCY_MS.heartbeat); // ~330s
    expect(outcome(r, 'liveness-hung-silent').latencyMs).toBe(EXPECTED_RECOVERY_LATENCY_MS.silent); // ~630s
    // stale heartbeat is caught sooner than silent output (different thresholds).
    expect(EXPECTED_RECOVERY_LATENCY_MS.heartbeat).toBeLessThan(EXPECTED_RECOVERY_LATENCY_MS.silent);
  });

  it('does NOT false-positive a healthy OR a slow-but-working bee (the FP trap)', () => {
    expect(outcome(r, 'liveness-healthy').detected).toBe(false);
    expect(outcome(r, 'liveness-slow-but-working').detected).toBe(false); // slow ≠ stalled
    expect(r.falsePositiveRate).toBe(0);
  });
});

describe('measureBehavioralDetection (P-065) — the hard family; EKG drift is all we have today', () => {
  const r = measureBehavioralDetection(ekgDriftDetector());

  it('catches off-brief WITH a tool-mix shift (the EKG drift signal fires)', () => {
    expect(outcome(r, 'behavioral-off-brief-shift').detected).toBe(true);
  });

  it('MISSES the hard cases — stealth off-brief + churn — the quantified gap P-052 must close', () => {
    expect(outcome(r, 'behavioral-off-brief-stealth').detected).toBe(false);
    expect(outcome(r, 'behavioral-churn-no-convergence').detected).toBe(false);
    expect(r.undetectedHardCases.sort()).toEqual(['behavioral-churn-no-convergence', 'behavioral-off-brief-stealth']);
  });

  it('reports the HONEST current detection rate (1 of 3 misbehaving) — not assumed', () => {
    expect(r.detectionRate).toBeCloseTo(1 / 3, 5);
  });

  it('does NOT false-positive an on-brief bee (tool-mix matches baseline)', () => {
    expect(outcome(r, 'behavioral-healthy').detected).toBe(false);
    expect(r.falsePositiveRate).toBe(0);
  });
});

describe('the yardstick (D-007): a future P-052 detector plugs in and raises the rate', () => {
  it('a detector that sees file-lane + churn lifts behavioral detection to 100% with no new FPs', () => {
    // Stand-in for the P-052 scope-violation + convergence-churn collectors: flags every
    // misbehaving case (it can see the file-lane + re-placement signals EKG can't).
    const p052: BehavioralDetector = {
      name: 'p052-stub (scope-violation + convergence-churn)',
      detect: (c) => ({ detected: c.misbehaving, latencyMs: c.misbehaving ? 60_000 : null }),
    };
    const r = measureBehavioralDetection(p052);
    expect(r.detectionRate).toBe(1);
    expect(r.falsePositiveRate).toBe(0);
    expect(r.undetectedHardCases).toEqual([]);
  });
});

describe('measureSupervision — both families in one report', () => {
  const { liveness, behavioral } = measureSupervision();
  it('returns a per-family report; liveness solid, behavioral partial (the honest state)', () => {
    expect(liveness.family).toBe('liveness');
    expect(liveness.detectionRate).toBe(1);
    expect(behavioral.family).toBe('behavioral');
    expect(behavioral.detectionRate).toBeLessThan(1); // the gap is real
    expect(behavioral.falsePositiveRate).toBe(0);
  });
  it('the corpus is the registered set', () => {
    expect(liveness.outcomes.length + behavioral.outcomes.length).toBe(SUPERVISION_CASES.length);
  });
});
