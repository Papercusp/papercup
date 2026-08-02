/**
 * precision-alert.test.ts — the recall-drop classifier (EI-10047). Pure math,
 * no I/O — pins the exact bug class the feature exists to catch: a total
 * search outage (degrade-never-throw → r@10 collapses to 0) against a
 * healthy baseline history must alert, while ordinary per-run noise must not.
 *
 * WI-7215 adds the second axis: r@10 is only comparable across runs measured
 * under the SAME admission shape, so priors carry their shape and the
 * classifier drops the incomparable ones.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRecallDrop,
  RECALL_DROP_THRESHOLD,
  RECALL_CRITICAL_FLOOR,
  MIN_BASELINE_RUNS,
  type PriorRun,
} from './precision-alert';

/** The shape production runs today (D-010 + WI-7179). */
const SHAPE = 'fusionMode:cosine-gated';
/** The shape every row recorded before WI-7179 was measured under — untagged. */
const LEGACY_SHAPE = null;

/** Tag a list of r@10 values with one admission shape. */
const shaped = (xs: readonly (number | null)[], shape: string | null = SHAPE): PriorRun[] =>
  xs.map((rAt10) => ({ rAt10, shape }));

const HEALTHY_HISTORY = shaped([0.82, 0.8, 0.83, 0.81, 0.82]); // median 0.82

describe('evaluateRecallDrop', () => {
  it('no history yet + a healthy-looking number: insufficient-history, no alert', () => {
    const r = evaluateRecallDrop([], 0.82, SHAPE);
    expect(r).toEqual({ alert: false, reason: 'insufficient-history', baseline: null, latest: 0.82, delta: null, comparablePriors: 0 });
  });

  it('no history yet + a catastrophic number: still no baseline, so no baseline-drop — but the critical floor is independent and fires', () => {
    const r = evaluateRecallDrop([], 0.0, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
    expect(r.baseline).toBeNull();
  });

  it('fewer than MIN_BASELINE_RUNS prior points: still insufficient-history for baseline-drop purposes', () => {
    const prior = HEALTHY_HISTORY.slice(0, MIN_BASELINE_RUNS - 1);
    const r = evaluateRecallDrop(prior, 0.81, SHAPE);
    expect(r.baseline).toBeNull();
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('insufficient-history');
  });

  it('a healthy baseline + a healthy run: ok, no alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.8, SHAPE);
    expect(r.baseline).toBe(0.82);
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('ok');
    expect(r.delta).toBeCloseTo(0.02, 5);
  });

  it('ordinary noise just under the threshold does not alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.82 - RECALL_DROP_THRESHOLD + 0.001, SHAPE);
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('ok');
  });

  it('a drop just over the 5pt threshold alerts as baseline-drop', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.82 - RECALL_DROP_THRESHOLD - 0.001, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('baseline-drop');
    expect(r.baseline).toBe(0.82);
  });

  it('THE motivating incident: a healthy baseline, then a total-outage run (r@10=0) — must alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0, SHAPE);
    expect(r.alert).toBe(true);
    // Both rules would fire here; baseline-drop is checked first and wins.
    expect(r.reason).toBe('baseline-drop');
    expect(r.delta).toBeCloseTo(0.82, 5);
  });

  it('a null latest (bench produced no number) with a known baseline alerts as critical-floor', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, null, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
    expect(r.latest).toBeNull();
    expect(r.delta).toBe(0.82);
  });

  it('a null latest with NO baseline yet does not alert (nothing to compare)', () => {
    const r = evaluateRecallDrop([], null, SHAPE);
    expect(r).toEqual({ alert: false, reason: 'insufficient-history', baseline: null, latest: null, delta: null, comparablePriors: 0 });
  });

  it('the absolute critical floor fires even when it is not a big relative drop (a permanently-mediocre baseline)', () => {
    const mediocre = shaped([0.22, 0.21, 0.23, 0.22, 0.21]); // median 0.22 — itself close to the floor
    const latest = RECALL_CRITICAL_FLOOR - 0.01; // 0.19: below floor, but only a 0.03 drop from baseline (< 5pt threshold)
    const r = evaluateRecallDrop(mediocre, latest, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
  });

  it('nulls in the prior-history array are dropped, not counted toward MIN_BASELINE_RUNS', () => {
    const prior = shaped([0.82, null, null, 0.8, 0.81]); // only 3 real numbers
    const r = evaluateRecallDrop(prior, 0.8, SHAPE);
    expect(r.baseline).toBe(0.81);
    expect(r.comparablePriors).toBe(3);
    expect(r.alert).toBe(false);
  });

  it('median baseline is robust to one outlier run (does not itself become the alert trigger)', () => {
    const withOutlier = shaped([0.82, 0.81, 0.83, 0.05, 0.8]); // one bad run mixed into otherwise-healthy history
    const r = evaluateRecallDrop(withOutlier, 0.8, SHAPE);
    expect(r.baseline).toBe(0.81); // median ignores the single 0.05 outlier
    expect(r.alert).toBe(false);
  });
});

describe('evaluateRecallDrop — admission-shape comparability (WI-7215)', () => {
  it('THE regression: the real recorded history against the post-WI-7179 flip must NOT fire a false baseline-drop', () => {
    // The four rows actually in harness_shared.memory_precision_bench on
    // 2026-08-02, all measured under floored-union at the (inert) 0.45 floor
    // and therefore untagged. Median 0.965278; the 0.05 threshold would fire on
    // anything below 0.915278.
    const recorded = shaped([0.9375, 0.95, 0.9805555555555556, 0.9805555555555556], LEGACY_SHAPE);
    // cosine-gated admits strictly less than floored-union (D-008), so a real
    // one-time step-change down is EXPECTED here — it is not a regression.
    const r = evaluateRecallDrop(recorded, 0.8, SHAPE);
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('insufficient-history');
    expect(r.baseline).toBeNull();
    expect(r.comparablePriors).toBe(0);
  });

  it('the same numbers WOULD alert if the shapes matched — proving the filter, not the arithmetic, is what spares us', () => {
    const recorded = shaped([0.9375, 0.95, 0.9805555555555556, 0.9805555555555556], SHAPE);
    const r = evaluateRecallDrop(recorded, 0.8, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('baseline-drop');
    expect(r.comparablePriors).toBe(4);
  });

  it('a genuine collapse is NOT masked by a shape change — the critical floor is shape-independent', () => {
    const recorded = shaped([0.9375, 0.95, 0.98, 0.98], LEGACY_SHAPE);
    const r = evaluateRecallDrop(recorded, 0, SHAPE);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
  });

  it('mixed history counts only the same-shape runs toward the baseline', () => {
    const mixed = [...shaped([0.5, 0.5, 0.5, 0.5], LEGACY_SHAPE), ...shaped([0.82, 0.8, 0.81])];
    const r = evaluateRecallDrop(mixed, 0.8, SHAPE);
    expect(r.comparablePriors).toBe(3);
    expect(r.baseline).toBe(0.81); // median of the cosine-gated three only
    expect(r.alert).toBe(false);
  });

  it('untagged legacy rows form their own comparable cohort (null is a shape, not a wildcard)', () => {
    const legacy = shaped([0.82, 0.8, 0.83, 0.81], LEGACY_SHAPE);
    const r = evaluateRecallDrop(legacy, 0.7, LEGACY_SHAPE);
    expect(r.comparablePriors).toBe(4);
    expect(r.baseline).toBe(0.815);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('baseline-drop');
  });

  it('a null shape does NOT match a tagged shape in either direction', () => {
    const tagged = shaped([0.82, 0.8, 0.83, 0.81], SHAPE);
    expect(evaluateRecallDrop(tagged, 0.5, LEGACY_SHAPE).comparablePriors).toBe(0);
    const legacy = shaped([0.82, 0.8, 0.83, 0.81], LEGACY_SHAPE);
    expect(evaluateRecallDrop(legacy, 0.5, SHAPE).comparablePriors).toBe(0);
  });

  it('a LATER shape change is protected too — this is not a one-off patch for the WI-7179 flip', () => {
    const cosineGated = shaped([0.82, 0.8, 0.83, 0.81], SHAPE);
    const r = evaluateRecallDrop(cosineGated, 0.6, 'fusionMode:some-future-mode');
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('insufficient-history');
    expect(r.comparablePriors).toBe(0);
  });
});
