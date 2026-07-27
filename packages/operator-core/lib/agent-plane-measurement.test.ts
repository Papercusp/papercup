import { describe, it, expect } from 'vitest';
import {
  PLANE_METRIC_IDS,
  PLANE_ZERO_REASONS,
  METRIC_SPECS,
  MIN_BATCHES_FOR_VARIANCE,
  buildMetric,
  composePlaneMeasurement,
  assessSeries,
  isStructuralZero,
  explainZero,
  type MetricCounts,
  type PlaneCounts,
  type PlaneMetricId,
} from './agent-plane-measurement';

const ZERO: MetricCounts = { population: 0, eligible: 0, comparable: 0, observed: 0 };

function countsWith(overrides: Partial<Record<PlaneMetricId, MetricCounts>>): PlaneCounts {
  return Object.fromEntries(
    PLANE_METRIC_IDS.map((id) => [id, overrides[id] ?? ZERO]),
  ) as PlaneCounts;
}

describe('the pre-registration is total and answers D-030 §3', () => {
  // D-030 requires P-015 to "pre-register the metric and the N". If a metric can
  // exist without a spec, pre-registration is a convention rather than a fact —
  // which is the failure mode P-015's own text names.
  it('every metric id has a frozen spec', () => {
    for (const id of PLANE_METRIC_IDS) {
      expect(METRIC_SPECS[id], `no spec for ${id}`).toBeDefined();
      expect(METRIC_SPECS[id].id).toBe(id);
    }
    expect(Object.keys(METRIC_SPECS).sort()).toEqual([...PLANE_METRIC_IDS].sort());
  });

  it('every metric answers "what makes this pass for the WRONG reason?"', () => {
    for (const id of PLANE_METRIC_IDS) {
      const spec = METRIC_SPECS[id];
      // Not merely present — substantive. A one-word answer is the same
      // non-answer the required field exists to prevent.
      expect(spec.vacuousPassWhen.length, `${id} vacuousPassWhen too thin`).toBeGreaterThan(60);
      expect(spec.question.length, `${id} question too thin`).toBeGreaterThan(20);
      expect(spec.inputProducer.length, `${id} names no producer`).toBeGreaterThan(10);
      expect(spec.unit.length).toBeGreaterThan(0);
      expect(spec.verdictUnit.length).toBeGreaterThan(0);
    }
  });

  it('the spec table is frozen, so a run cannot restate a question to fit a number', () => {
    expect(Object.isFrozen(METRIC_SPECS)).toBe(true);
  });

  it('implements D-032 — the corrected metric, not the item text’s presentation one', () => {
    expect(PLANE_METRIC_IDS).toContain('acted-on-stale-or-wrong-value');
    // The item's literal wording ("cells-read vs values-transcribed-into-prose")
    // was corrected by D-032 as measuring PRESENTATION; it must not reappear.
    expect(PLANE_METRIC_IDS.join(',')).not.toMatch(/transcri/i);
  });
});

describe('the two denominators are not one (D-089)', () => {
  // THE test of this item. "Nothing was declared" and "nothing was wrong" must
  // never render the same, however similar the headline number looks.
  it('an empty window and a window with zero fill report DIFFERENT zeros', () => {
    const idle = buildMetric('intent-action-divergence-stamped', ZERO);
    const busyButUnstamped = buildMetric('intent-action-divergence-stamped', {
      population: 176_784,
      eligible: 0,
      comparable: 0,
      observed: 0,
    });

    expect(idle.zeroReason).toBe('population-empty');
    expect(busyButUnstamped.zeroReason).toBe('nothing-eligible');
    expect(idle.zeroReason).not.toBe(busyButUnstamped.zeroReason);

    // Both are structural — neither is a clean bill of health.
    expect(isStructuralZero(idle.zeroReason)).toBe(true);
    expect(isStructuralZero(busyButUnstamped.zeroReason)).toBe(true);
    // And the fill rate names which: 0 fill over a large population.
    expect(busyButUnstamped.fillRate).toBe(0);
    expect(idle.fillRate).toBeNull();
  });

  it('rate is NULL, never 0, when nothing was comparable', () => {
    const m = buildMetric('conflicting-assumption-incidence', {
      population: 2148,
      eligible: 0,
      comparable: 0,
      observed: 0,
    });
    // A rate of 0 is a finding; this is the absence of one. They must not share
    // a representation.
    expect(m.rate).toBeNull();
    expect(m.rate).not.toBe(0);
    expect(m.interpretable).toBe(false);
  });

  it('a real zero over a real denominator is the ONLY informative zero', () => {
    const m = buildMetric('intent-action-divergence-sampling', {
      population: 1000,
      eligible: 40,
      comparable: 40,
      observed: 0,
    });
    expect(m.zeroReason).toBe('clean');
    expect(isStructuralZero(m.zeroReason)).toBe(false);
    expect(m.rate).toBe(0);
    expect(m.interpretable).toBe(true);
  });

  it('distinguishes "input present but nothing comparable" from "no input"', () => {
    const m = buildMetric('intent-action-divergence-stamped', {
      population: 1000,
      eligible: 500,
      comparable: 0,
      observed: 0,
    });
    expect(m.zeroReason).toBe('nothing-comparable');
    expect(m.fillRate).toBe(0.5);
    expect(m.rate).toBeNull();
  });
});

describe('buildMetric arithmetic', () => {
  it('computes fillRate and rate to 4dp, matching DivergenceCoverage.stampFillRate', () => {
    const m = buildMetric('intent-action-divergence-sampling', {
      population: 3,
      eligible: 3,
      comparable: 3,
      observed: 1,
    });
    expect(m.rate).toBe(0.3333);
    expect(m.fillRate).toBe(1);
  });

  it('never suppresses a finding because a denominator was mis-supplied', () => {
    const m = buildMetric('intent-action-divergence-sampling', {
      population: 0,
      eligible: 0,
      comparable: 0,
      observed: 4,
    });
    expect(m.observed).toBe(4);
    expect(m.zeroReason).toBeNull();
    expect(m.interpretable).toBe(true);
  });

  it('clamps negative / non-finite counts rather than poisoning a rate', () => {
    const m = buildMetric('clarification-rate', {
      population: Number.NaN,
      eligible: -5,
      comparable: 10,
      observed: 2.9,
    });
    expect(m.population).toBe(0);
    expect(m.eligible).toBe(0);
    expect(m.observed).toBe(2);
    expect(m.rate).toBe(0.2);
  });
});

describe('composePlaneMeasurement', () => {
  it('reports every metric and leads with what is measurable', () => {
    const m = composePlaneMeasurement({
      counts: countsWith({}),
      windowStartMs: 1_000,
      windowEndMs: 2_000,
    });
    expect(m.metrics).toHaveLength(PLANE_METRIC_IDS.length);
    expect(m.interpretableCount).toBe(0);
    expect(m.awaitingProducer).toHaveLength(PLANE_METRIC_IDS.length);
    expect(m.summary).toContain(`0/${PLANE_METRIC_IDS.length}`);
    expect(m.summary).toContain('awaiting a producer');
  });

  it('names findings in the summary when there are any', () => {
    const m = composePlaneMeasurement({
      counts: countsWith({
        'intent-action-divergence-sampling': {
          population: 176_784,
          eligible: 601,
          comparable: 601,
          observed: 39,
        },
      }),
      windowStartMs: 0,
      windowEndMs: 1,
    });
    expect(m.summary).toContain('intent-action-divergence-sampling=39/601');
    expect(m.interpretableCount).toBe(1);
    expect(m.awaitingProducer).not.toContain('intent-action-divergence-sampling');
  });

  it('is deterministic — same counts, same row', () => {
    const args = { counts: countsWith({}), windowStartMs: 5, windowEndMs: 9, measuredAt: 'X' };
    expect(JSON.stringify(composePlaneMeasurement(args))).toBe(
      JSON.stringify(composePlaneMeasurement(args)),
    );
  });

  it('derives measuredAt from the window end when not supplied', () => {
    const m = composePlaneMeasurement({ counts: countsWith({}), windowStartMs: 0, windowEndMs: 86_400_000 });
    expect(m.measuredAt).toBe(new Date(86_400_000).toISOString());
  });
});

describe('assessSeries — D-030 §3 variance, D-035 no effect-size inference', () => {
  it('refuses to report a trend from a single batch', () => {
    const a = assessSeries([0.42]);
    expect(a.verdict).toBe('insufficient-batches');
    expect(a.n).toBe(1);
    // ⚠ D-035: it must not report a mean, which a reader would take as the effect.
    expect(a.mean).toBeNull();
    expect(a.spread).toBeNull();
    expect(a.note).toContain('D-035');
  });

  it('treats null rates as absent readings, not as zeros', () => {
    // A structurally-empty window contributes NO reading. Counting it as 0 would
    // manufacture a downward trend out of an instrument that was never read.
    const a = assessSeries([null, null, 0.5]);
    expect(a.n).toBe(1);
    expect(a.verdict).toBe('insufficient-batches');
  });

  it('reports spread once MIN_BATCHES_FOR_VARIANCE readings exist', () => {
    const a = assessSeries([0.471, 0.591, 0.349]);
    expect(a.verdict).toBe('reportable');
    expect(a.n).toBe(3);
    expect(a.min).toBe(0.349);
    expect(a.max).toBe(0.591);
    // The non-monotonic curve P-015 exists to make visible: the spread (0.242) is
    // larger than any adjacent step, so no single delta may be read as a trend.
    expect(a.spread).toBe(0.242);
    expect(a.mean).toBeCloseTo(0.4703, 3);
  });

  it('MIN_BATCHES_FOR_VARIANCE is the D-030 floor', () => {
    expect(MIN_BATCHES_FOR_VARIANCE).toBe(2);
    expect(assessSeries([0.1, 0.2]).verdict).toBe('reportable');
  });
});

describe('explainZero', () => {
  it('covers every reason and never renders a structural zero as good news', () => {
    for (const r of PLANE_ZERO_REASONS) {
      const text = explainZero(r);
      expect(text.length).toBeGreaterThan(20);
      if (isStructuralZero(r)) {
        expect(text).not.toMatch(/good news/);
      }
    }
    expect(explainZero('clean')).toContain('good news');
  });
});
