/**
 * precision-alert.test.ts — the recall-drop classifier (EI-10047). Pure math,
 * no I/O — pins the exact bug class the feature exists to catch: a total
 * search outage (degrade-never-throw → r@10 collapses to 0) against a
 * healthy baseline history must alert, while ordinary per-run noise must not.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRecallDrop,
  RECALL_DROP_THRESHOLD,
  RECALL_CRITICAL_FLOOR,
  MIN_BASELINE_RUNS,
} from './precision-alert';

const HEALTHY_HISTORY = [0.82, 0.8, 0.83, 0.81, 0.82]; // median 0.82

describe('evaluateRecallDrop', () => {
  it('no history yet + a healthy-looking number: insufficient-history, no alert', () => {
    const r = evaluateRecallDrop([], 0.82);
    expect(r).toEqual({ alert: false, reason: 'insufficient-history', baseline: null, latest: 0.82, delta: null });
  });

  it('no history yet + a catastrophic number: still no baseline, so no baseline-drop — but the critical floor is independent and fires', () => {
    const r = evaluateRecallDrop([], 0.0);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
    expect(r.baseline).toBeNull();
  });

  it('fewer than MIN_BASELINE_RUNS prior points: still insufficient-history for baseline-drop purposes', () => {
    const prior = HEALTHY_HISTORY.slice(0, MIN_BASELINE_RUNS - 1);
    const r = evaluateRecallDrop(prior, 0.81);
    expect(r.baseline).toBeNull();
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('insufficient-history');
  });

  it('a healthy baseline + a healthy run: ok, no alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.8);
    expect(r.baseline).toBe(0.82);
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('ok');
    expect(r.delta).toBeCloseTo(0.02, 5);
  });

  it('ordinary noise just under the threshold does not alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.82 - RECALL_DROP_THRESHOLD + 0.001);
    expect(r.alert).toBe(false);
    expect(r.reason).toBe('ok');
  });

  it('a drop just over the 5pt threshold alerts as baseline-drop', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0.82 - RECALL_DROP_THRESHOLD - 0.001);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('baseline-drop');
    expect(r.baseline).toBe(0.82);
  });

  it('THE motivating incident: a healthy baseline, then a total-outage run (r@10=0) — must alert', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, 0);
    expect(r.alert).toBe(true);
    // Both rules would fire here; baseline-drop is checked first and wins.
    expect(r.reason).toBe('baseline-drop');
    expect(r.delta).toBeCloseTo(0.82, 5);
  });

  it('a null latest (bench produced no number) with a known baseline alerts as critical-floor', () => {
    const r = evaluateRecallDrop(HEALTHY_HISTORY, null);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
    expect(r.latest).toBeNull();
    expect(r.delta).toBe(0.82);
  });

  it('a null latest with NO baseline yet does not alert (nothing to compare)', () => {
    const r = evaluateRecallDrop([], null);
    expect(r).toEqual({ alert: false, reason: 'insufficient-history', baseline: null, latest: null, delta: null });
  });

  it('the absolute critical floor fires even when it is not a big relative drop (a permanently-mediocre baseline)', () => {
    const mediocre = [0.25, 0.24, 0.26, 0.25, 0.24]; // median 0.25 — itself close to the floor
    const r = evaluateRecallDrop(mediocre, RECALL_CRITICAL_FLOOR - 0.01);
    expect(r.alert).toBe(true);
    expect(r.reason).toBe('critical-floor');
  });

  it('nulls in the prior-history array are dropped, not counted toward MIN_BASELINE_RUNS', () => {
    const prior = [0.82, null, null, 0.8, 0.81]; // only 3 real numbers
    const r = evaluateRecallDrop(prior, 0.8);
    expect(r.baseline).toBe(0.81);
    expect(r.alert).toBe(false);
  });

  it('median baseline is robust to one outlier run (does not itself become the alert trigger)', () => {
    const withOutlier = [0.82, 0.81, 0.83, 0.05, 0.8]; // one bad run mixed into otherwise-healthy history
    const r = evaluateRecallDrop(withOutlier, 0.8);
    expect(r.baseline).toBe(0.81); // median ignores the single 0.05 outlier
    expect(r.alert).toBe(false);
  });
});
