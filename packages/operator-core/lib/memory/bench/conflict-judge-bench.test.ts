import { describe, expect, it } from 'vitest';

import { JEV_CONFLICT_LABELS, type ConflictVerdict, type JevConflictLabel } from '../jev-conflict-judge';
import { D015_BAR, evaluateD015, ratio, renderConflictBenchReport, scoreConflictBench, type ConflictPairResult } from './conflict-judge-bench';
import { CONFLICT_JUDGE_SAMPLE } from './conflict-judge-sample';

function verdict(label: JevConflictLabel, pContradicts = label === 'contradicts' ? 0.9 : 0.05): ConflictVerdict {
  const rest = (1 - pContradicts) / 3;
  const probabilities = Object.fromEntries(JEV_CONFLICT_LABELS.map((l) => [l, l === 'contradicts' ? pContradicts : rest])) as Record<JevConflictLabel, number>;
  return { label, p: probabilities[label], pContradicts, probabilities };
}

function pair(gold: JevConflictLabel, forward: ConflictVerdict | null, reversed: ConflictVerdict | null = forward, repeat = forward): ConflictPairResult {
  return { caseId: 'k', neighbourId: `k.${Math.random().toString(36).slice(2, 7)}`, gold, forward, repeat, reversed };
}

const CALLS = { calls: 10, inconclusive: 0, inconclusiveReasons: {}, models: ['jev-1.13.0'] };

describe('the frozen P-009 sample', () => {
  const pairs = CONFLICT_JUDGE_SAMPLE.flatMap((c) => c.neighbours);
  it('meets the P-009 size floor with enough contradictions and hard negatives', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(50);
    const count = (l: JevConflictLabel) => pairs.filter((p) => p.gold === l).length;
    expect(count('contradicts')).toBeGreaterThanOrEqual(15);
    expect(count('duplicates') + count('refines')).toBeGreaterThanOrEqual(15);
    expect(count('unrelated')).toBeGreaterThanOrEqual(15);
  });

  it('has unique case and neighbour ids, valid labels, and at least two neighbours per case (order reversal needs two)', () => {
    expect(new Set(CONFLICT_JUDGE_SAMPLE.map((c) => c.id)).size).toBe(CONFLICT_JUDGE_SAMPLE.length);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
    for (const p of pairs) expect(JEV_CONFLICT_LABELS).toContain(p.gold);
    for (const c of CONFLICT_JUDGE_SAMPLE) {
      expect(c.neighbours.length).toBeGreaterThanOrEqual(2);
      expect(c.newText.trim()).not.toBe('');
    }
  });
});

describe('ratio', () => {
  it('is undefined, not 0 or 1, on an empty denominator', () => {
    expect(ratio(0, 0)).toEqual({ num: 0, den: 0, value: null, ci95: null });
  });
  it('brackets the point estimate with a Wilson interval inside [0, 1]', () => {
    const r = ratio(9, 10);
    expect(r.value).toBeCloseTo(0.9);
    expect(r.ci95![0]).toBeLessThan(0.9);
    expect(r.ci95![1]).toBeGreaterThan(0.9);
    expect(r.ci95![1]).toBeLessThanOrEqual(1);
    expect(ratio(10, 10).ci95![1]).toBe(1);
  });
});

describe('scoreConflictBench', () => {
  it('scores the flag with P(contradicts) >= 0.5 and counts an unjudged contradiction as a miss (production fails open)', () => {
    const m = scoreConflictBench(
      [
        pair('contradicts', verdict('contradicts', 0.8)),
        pair('contradicts', null),
        pair('duplicates', verdict('contradicts', 0.6)),
        pair('refines', verdict('refines')),
        pair('contradicts', verdict('refines', 0.4)),
      ],
      CALLS,
    );
    expect(m.flag).toMatchObject({ tp: 1, fp: 1, fn: 2, tn: 1 });
    expect(m.flag.precision.value).toBeCloseTo(0.5);
    expect(m.flag.recall.value).toBeCloseTo(1 / 3);
    expect(m.unjudgedPairs).toBe(1);
  });

  it('builds per-label precision/recall and the confusion matrix from judged pairs only', () => {
    const m = scoreConflictBench(
      [pair('duplicates', verdict('duplicates')), pair('duplicates', verdict('refines')), pair('refines', verdict('refines')), pair('unrelated', null)],
      CALLS,
    );
    const dup = m.perLabel.find((s) => s.label === 'duplicates')!;
    expect(dup.support).toBe(2);
    expect(dup.precision.value).toBe(1);
    expect(dup.recall.value).toBe(0.5);
    const ref = m.perLabel.find((s) => s.label === 'refines')!;
    expect(ref.precision.value).toBe(0.5);
    expect(m.confusion.duplicates.refines).toBe(1);
    expect(m.perLabel.find((s) => s.label === 'unrelated')!.support).toBe(0);
  });

  it('counts flag and label flips under reversal and repeat only where both runs answered', () => {
    const m = scoreConflictBench(
      [
        pair('contradicts', verdict('contradicts', 0.7), verdict('refines', 0.3)),
        pair('refines', verdict('refines'), verdict('duplicates')),
        pair('unrelated', verdict('unrelated'), null),
      ],
      CALLS,
    );
    expect(m.order.flagFlips).toMatchObject({ num: 1, den: 2 });
    expect(m.order.labelFlips).toMatchObject({ num: 2, den: 2 });
    expect(m.repeat.flagFlips).toMatchObject({ num: 0, den: 3 });
  });
});

describe('evaluateD015', () => {
  const perfect = (extra: ConflictPairResult[] = []) => [
    ...Array.from({ length: 10 }, () => pair('contradicts', verdict('contradicts'))),
    ...Array.from({ length: 30 }, () => pair('refines', verdict('refines'))),
    ...extra,
  ];

  it('passes when every criterion holds', () => {
    const v = evaluateD015(scoreConflictBench(perfect(), CALLS));
    expect(v.pass).toBe(true);
    expect(v.criteria.map((c) => c.pass)).toEqual([true, true, true, true]);
  });

  it('fails on precision just under 0.90', () => {
    const fps = Array.from({ length: 2 }, () => pair('duplicates', verdict('contradicts', 0.7)));
    const v = evaluateD015(scoreConflictBench(perfect(fps), CALLS));
    expect(v.criteria[0]).toMatchObject({ name: 'contradicts-flag precision', pass: false });
    expect(v.pass).toBe(false);
  });

  it('fails on order instability above 5% and on inconclusive calls above 5%', () => {
    const unstable = Array.from({ length: 3 }, () => pair('contradicts', verdict('contradicts'), verdict('refines', 0.2)));
    const v = evaluateD015(scoreConflictBench(perfect(unstable), { ...CALLS, calls: 100, inconclusive: 6 }));
    expect(v.criteria[2].pass).toBe(false);
    expect(v.criteria[3].pass).toBe(false);
  });

  it('fails an undefined criterion rather than passing it vacuously', () => {
    const v = evaluateD015(scoreConflictBench([pair('refines', verdict('refines'))], CALLS));
    expect(v.criteria[0]).toMatchObject({ value: null, pass: false });
  });

  it('pins the bar to D-015', () => {
    expect(D015_BAR).toEqual({ minFlagPrecision: 0.9, minFlagRecall: 0.6, maxOrderFlagFlipRate: 0.05, maxInconclusiveRate: 0.05 });
  });
});

describe('renderConflictBenchReport', () => {
  it('states the verdict and lists flag errors', () => {
    const pairs = [pair('duplicates', verdict('contradicts', 0.7)), pair('contradicts', verdict('contradicts'))];
    const metrics = scoreConflictBench(pairs, CALLS);
    const md = renderConflictBenchReport({ generatedAt: 'T', calls: CALLS, metrics, verdict: evaluateD015(metrics), pairs });
    expect(md).toContain('does NOT meet the bar');
    expect(md).toContain('gold=duplicates → contradicts P(contradicts)=0.70');
    expect(md).toContain('labelled by the implementer');
  });
});
