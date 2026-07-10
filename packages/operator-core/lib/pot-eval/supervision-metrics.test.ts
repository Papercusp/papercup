/**
 * Unit tests for supervision-metrics (P-064 / P-065). Pure + deterministic — no live hive, no DB.
 *
 * Two layers are covered:
 *  1. The pure AGGREGATION (`summarize` via `measureBehavioralDetection`): the detection-rate /
 *     false-positive-rate divide guards (0, never NaN), the verdict mapping (tp/fn/fp/tn), the
 *     mean-latency null-vs-0 semantics, and undetectedHardCases. Driven through the exported
 *     `BehavioralDetector` seam over synthetic SupervisionCases so the outcome is fully controlled.
 *  2. The real shipped detectors + the wired liveness corpus (the normal, non-degenerate path).
 */
import { describe, it, expect } from 'vitest';
import {
  measureLivenessDetection,
  measureBehavioralDetection,
  scopeViolationDetector,
  convergenceChurnDetector,
  compositeDetector,
  EXPECTED_RECOVERY_LATENCY_MS,
  COLLECTOR_DETECTION_LATENCY_MS,
  type BehavioralDetector,
} from './supervision-metrics';
import type { SupervisionCase } from './supervision-scenarios';

/** A minimal valid behavioral SupervisionCase (no seed — synthetic cases pair with fake detectors). */
function bcase(id: string, misbehaving: boolean, behavioral?: SupervisionCase['behavioral']): SupervisionCase {
  return { id, family: 'behavioral', misbehaving, detectableToday: misbehaving, description: id, behavioral };
}

/** Wrap a detect fn into the exported BehavioralDetector seam. */
function fake(detect: BehavioralDetector['detect'], name = 'fake'): BehavioralDetector {
  return { name, detect };
}

const find = (r: { outcomes: { caseId: string }[] }, id: string) =>
  (r.outcomes as { caseId: string; misbehaving: boolean; detected: boolean; verdict: string; latencyMs: number | null }[]).find(
    (o) => o.caseId === id,
  )!;

describe('measureBehavioralDetection — verdict mapping (ground-truth × detection)', () => {
  const cases = [bcase('m-hit', true), bcase('m-miss', true), bcase('c-flag', false), bcase('c-ok', false)];
  // Detect iff the id contains "hit" (a caught positive) or "flag" (a false-flagged control).
  const detector = fake((c) => {
    const detected = c.id.includes('hit') || c.id.includes('flag');
    return { detected, latencyMs: detected ? 1000 : null };
  });
  const r = measureBehavioralDetection(detector, { cases });

  it('maps each case to tp / fn / fp / tn correctly', () => {
    expect(find(r, 'm-hit').verdict).toBe('tp'); // misbehaving + detected
    expect(find(r, 'm-miss').verdict).toBe('fn'); // misbehaving + missed
    expect(find(r, 'c-flag').verdict).toBe('fp'); // control + flagged
    expect(find(r, 'c-ok').verdict).toBe('tn'); // control + clean
  });

  it('detectionRate = tp / positives and falsePositiveRate = fp / negatives', () => {
    expect(r.detectionRate).toBe(0.5); // 1 of 2 misbehaving detected
    expect(r.falsePositiveRate).toBe(0.5); // 1 of 2 controls falsely flagged
  });

  it('undetectedHardCases lists exactly the missed positives; meanLatency is over true positives only', () => {
    expect(r.undetectedHardCases).toEqual(['m-miss']);
    expect(r.meanLatencyMs).toBe(1000); // only the single tp contributes
  });
});

describe('measureBehavioralDetection — divide guards never produce NaN', () => {
  it('no misbehaving positives → detectionRate 0 (NOT NaN)', () => {
    const cases = [bcase('c1', false), bcase('c2', false)];
    const r = measureBehavioralDetection(fake(() => ({ detected: false, latencyMs: null })), { cases });
    expect(r.detectionRate).toBe(0);
    expect(Number.isNaN(r.detectionRate)).toBe(false);
    expect(r.undetectedHardCases).toEqual([]);
    expect(r.meanLatencyMs).toBeNull();
  });

  it('no healthy controls → falsePositiveRate 0 (NOT NaN)', () => {
    const cases = [bcase('m1', true), bcase('m2', true)];
    const r = measureBehavioralDetection(fake(() => ({ detected: true, latencyMs: 50 })), { cases });
    expect(r.falsePositiveRate).toBe(0);
    expect(Number.isNaN(r.falsePositiveRate)).toBe(false);
    expect(r.detectionRate).toBe(1);
  });

  it('empty corpus → no outcomes, both rates 0, meanLatency null', () => {
    const r = measureBehavioralDetection(fake(() => ({ detected: false, latencyMs: null })), { cases: [] });
    expect(r.outcomes).toHaveLength(0);
    expect(r.detectionRate).toBe(0);
    expect(r.falsePositiveRate).toBe(0);
    expect(r.meanLatencyMs).toBeNull();
    expect(r.undetectedHardCases).toEqual([]);
  });
});

describe('measureBehavioralDetection — latency null-vs-0 semantics', () => {
  it('a detected true-positive that reports NO latency → meanLatencyMs is null (NOT 0)', () => {
    const cases = [bcase('m', true)];
    const r = measureBehavioralDetection(fake(() => ({ detected: true, latencyMs: null })), { cases });
    expect(r.detectionRate).toBe(1); // it WAS detected
    expect(r.meanLatencyMs).toBeNull(); // but contributed no latency, so the mean is "no signal", not 0
  });

  it('a detector-supplied latency on a NON-detected case is nulled out (detected ? latency : null)', () => {
    const cases = [bcase('m', true)];
    const r = measureBehavioralDetection(fake(() => ({ detected: false, latencyMs: 9999 })), { cases });
    const o = find(r, 'm');
    expect(o.detected).toBe(false);
    expect(o.verdict).toBe('fn');
    expect(o.latencyMs).toBeNull(); // the 9999 a non-firing detector returned is discarded
    expect(r.meanLatencyMs).toBeNull();
  });
});

describe('real collector detectors (genuine pure logic over seeded cases)', () => {
  it('scopeViolationDetector flags wholly out-of-lane touches at the collector latency, spares in-lane work', () => {
    const offLane = bcase('off', true, {
      brief: 'write tests',
      baselineToolMix: {},
      windowToolMix: {},
      declaredLane: ['src/tests/**'],
      touchedFiles: ['src/payments/charge.ts', 'src/auth/login.ts'], // ratio 2/2 = 1 ≥ 0.5
    });
    const inLane = bcase('in', false, {
      brief: 'write tests',
      baselineToolMix: {},
      windowToolMix: {},
      declaredLane: ['src/tests/**'],
      touchedFiles: ['src/tests/x.test.ts'],
    });
    const r = measureBehavioralDetection(scopeViolationDetector(), { cases: [offLane, inLane] });
    expect(find(r, 'off').detected).toBe(true);
    expect(find(r, 'off').latencyMs).toBe(COLLECTOR_DETECTION_LATENCY_MS);
    expect(find(r, 'in').detected).toBe(false);
    expect(r.detectionRate).toBe(1);
    expect(r.falsePositiveRate).toBe(0);
  });

  it('convergenceChurnDetector flags un-converged churn (failCount ≥ threshold), spares converged retries', () => {
    const churn = bcase('churn', true, {
      brief: 'fix bug',
      baselineToolMix: {},
      windowToolMix: {},
      placement: { failCount: 3, converged: false }, // 3 unproductive attempts ≥ 2
    });
    const converged = bcase('done', false, {
      brief: 'fix bug',
      baselineToolMix: {},
      windowToolMix: {},
      placement: { failCount: 5, converged: true }, // converged ⇒ 0 unproductive attempts
    });
    const r = measureBehavioralDetection(convergenceChurnDetector(), { cases: [churn, converged] });
    expect(find(r, 'churn').detected).toBe(true);
    expect(find(r, 'churn').latencyMs).toBe(COLLECTOR_DETECTION_LATENCY_MS);
    expect(find(r, 'done').detected).toBe(false);
  });

  it('compositeDetector fires when ANY sub-detector fires and takes the MIN latency', () => {
    const slow = fake(() => ({ detected: true, latencyMs: 500 }), 'slow');
    const fast = fake(() => ({ detected: true, latencyMs: 200 }), 'fast');
    const out = compositeDetector([slow, fast]).detect(bcase('x', true));
    expect(out.detected).toBe(true);
    expect(out.latencyMs).toBe(200); // fastest firing detector
  });

  it('compositeDetector does not fire when no sub-detector fires', () => {
    const none = compositeDetector([
      fake(() => ({ detected: false, latencyMs: null })),
      fake(() => ({ detected: false, latencyMs: null })),
    ]).detect(bcase('x', true));
    expect(none.detected).toBe(false);
    expect(none.latencyMs).toBeNull();
  });
});

describe('measureLivenessDetection — wired liveness corpus (normal non-degenerate path)', () => {
  const r = measureLivenessDetection();

  it('detects BOTH hung modes and never flags the two healthy controls (FPR 0, detection 1)', () => {
    expect(find(r, 'liveness-hung-heartbeat').detected).toBe(true);
    expect(find(r, 'liveness-hung-silent').detected).toBe(true);
    expect(find(r, 'liveness-healthy').verdict).toBe('tn');
    expect(find(r, 'liveness-slow-but-working').verdict).toBe('tn'); // the slow≠stalled false-positive trap
    expect(r.detectionRate).toBe(1);
    expect(r.falsePositiveRate).toBe(0);
    expect(r.undetectedHardCases).toEqual([]);
  });

  it('measures recovery latency at the REAL thresholds (rounded up to the next sweep)', () => {
    expect(find(r, 'liveness-hung-heartbeat').latencyMs).toBe(EXPECTED_RECOVERY_LATENCY_MS.heartbeat);
    expect(find(r, 'liveness-hung-silent').latencyMs).toBe(EXPECTED_RECOVERY_LATENCY_MS.silent);
    // controls produce no latency
    expect(find(r, 'liveness-healthy').latencyMs).toBeNull();
  });

  it('meanLatencyMs is the mean over the two detected true positives', () => {
    expect(r.meanLatencyMs).toBe((EXPECTED_RECOVERY_LATENCY_MS.heartbeat + EXPECTED_RECOVERY_LATENCY_MS.silent) / 2);
  });
});
