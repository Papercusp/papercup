import { describe, expect, it } from 'vitest';

import { JEV_CONTRADICTION_LABELS, type ContradictionJudgement, type JevContradictionLabel } from '../jev-contradiction-judge';
import {
  D017_BAR,
  binaryKappa,
  evaluateD017,
  flagScore,
  renderDocContradictionReport,
  scoreDocContradictionBench,
  type DocContradictionCalls,
  type DocContradictionPairResult,
} from './doc-contradiction-bench';
import { DOC_CONTRADICTION_SAMPLE } from './doc-contradiction-sample';

function j(label: JevContradictionLabel, pOpposite: number): ContradictionJudgement {
  const rest = (1 - pOpposite) / 2;
  const probabilities = { 'opposite-instructions': pOpposite, compatible: rest, unrelated: rest };
  return { label, p: probabilities[label], pOpposite, probabilities, model: 'jev-test' };
}

const OPP = j('opposite-instructions', 0.9);
const COMPAT = j('compatible', 0.1);

function row(
  id: string,
  gold: JevContradictionLabel,
  jev: ContradictionJudgement | null,
  incumbent: boolean | null,
  extra: Partial<DocContradictionPairResult> = {},
): DocContradictionPairResult {
  return {
    id,
    gold,
    note: gold === 'opposite-instructions' ? 'direct' : gold === 'compatible' ? 'redundant' : 'shared-wording',
    jevForward: jev,
    jevRepeat: jev,
    jevSwapped: jev,
    incumbentForward: incumbent,
    incumbentSwapped: incumbent,
    ...extra,
  };
}

const CALLS: DocContradictionCalls = {
  jevCalls: 30,
  jevInconclusive: 0,
  jevInconclusiveReasons: {},
  jevModels: ['jev-test'],
  incumbentCalls: 20,
  incumbentErrors: 0,
  incumbentModel: 'claude-haiku-4-5',
};

describe('flagScore', () => {
  it('counts the confusion cells and derives precision, recall and F1', () => {
    const s = flagScore([
      { gold: 'opposite-instructions', flagged: true },
      { gold: 'opposite-instructions', flagged: true },
      { gold: 'opposite-instructions', flagged: false },
      { gold: 'compatible', flagged: true },
      { gold: 'unrelated', flagged: false },
    ]);
    expect([s.tp, s.fp, s.fn, s.tn]).toEqual([2, 1, 1, 1]);
    expect(s.precision.value).toBeCloseTo(2 / 3);
    expect(s.recall.value).toBeCloseTo(2 / 3);
    expect(s.f1).toBeCloseTo(2 / 3);
  });

  it('has no F1 when nothing was gold and nothing was flagged', () => {
    expect(flagScore([{ gold: 'compatible', flagged: false }]).f1).toBeNull();
  });
});

describe('binaryKappa', () => {
  it('is 1 for perfect agreement and 0 for agreement at chance', () => {
    expect(binaryKappa([[true, true], [false, false]]).kappa).toBe(1);
    expect(binaryKappa([[true, true], [true, false], [false, true], [false, false]]).kappa).toBe(0);
  });

  it('is undefined with no rows or when both raters are constant and agree', () => {
    expect(binaryKappa([]).kappa).toBeNull();
    expect(binaryKappa([[false, false], [false, false]]).kappa).toBeNull();
  });
});

describe('scoreDocContradictionBench', () => {
  it('scores a silent judge as flagging nothing, and counts it as unanswered', () => {
    const m = scoreDocContradictionBench(
      [row('o1', 'opposite-instructions', null, true), row('c1', 'compatible', null, false)],
      { ...CALLS, jevCalls: 6, jevInconclusive: 6 },
    );
    expect(m.jev.flag.tp).toBe(0);
    expect(m.jev.flag.fn).toBe(1);
    expect(m.jev.unanswered).toBe(2);
    expect(m.jev.inconclusiveRate.value).toBe(1);
    expect(m.agreement.n).toBe(0);
  });

  it('measures swap and repeat flips only over pairs answered both times', () => {
    const m = scoreDocContradictionBench(
      [
        row('o1', 'opposite-instructions', OPP, true, { jevSwapped: COMPAT }),
        row('o2', 'opposite-instructions', OPP, true, { jevSwapped: null }),
        row('c1', 'compatible', COMPAT, false),
      ],
      CALLS,
    );
    expect(m.jev.swapFlagFlips.num).toBe(1);
    expect(m.jev.swapFlagFlips.den).toBe(2);
    expect(m.jev.repeatFlagFlips.num).toBe(0);
  });

  it('fills a 3x3 confusion matrix over the answered pairs', () => {
    const m = scoreDocContradictionBench(
      [row('o1', 'opposite-instructions', OPP, true), row('u1', 'unrelated', COMPAT, false)],
      CALLS,
    );
    expect(Object.keys(m.jev.confusion)).toEqual([...JEV_CONTRADICTION_LABELS]);
    expect(m.jev.confusion['opposite-instructions']['opposite-instructions']).toBe(1);
    expect(m.jev.confusion.unrelated.compatible).toBe(1);
  });
});

describe('evaluateD017', () => {
  const good = [
    ...Array.from({ length: 10 }, (_, i) => row(`o${i}`, 'opposite-instructions', OPP, true)),
    ...Array.from({ length: 10 }, (_, i) => row(`c${i}`, 'compatible', COMPAT, false)),
  ];

  it('passes when every criterion holds', () => {
    const v = evaluateD017(scoreDocContradictionBench(good, CALLS));
    expect(v.criteria.map((c) => c.pass)).toEqual([true, true, true, true, true]);
    expect(v.pass).toBe(true);
  });

  it('fails on precision when compatible pairs are flagged', () => {
    const noisy = good.map((r) => (r.gold === 'compatible' && r.id < 'c2' ? { ...r, jevForward: OPP, jevRepeat: OPP, jevSwapped: OPP } : r));
    const v = evaluateD017(scoreDocContradictionBench(noisy, CALLS));
    expect(v.criteria.find((c) => c.name === 'Jev flag precision')?.pass).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('fails the non-inferiority criterion when Jev trails the incumbent by more than the allowed deficit', () => {
    // Jev misses 3 of 10 contradictions (F1 0.82); the incumbent catches all (F1 1.0).
    const weaker = good.map((r) => (['o0', 'o1', 'o2'].includes(r.id) ? { ...r, jevForward: COMPAT, jevRepeat: COMPAT, jevSwapped: COMPAT } : r));
    const v = evaluateD017(scoreDocContradictionBench(weaker, CALLS));
    expect(v.criteria.find((c) => c.name === 'Jev flag recall')?.pass).toBe(true);
    expect(v.criteria.find((c) => c.name === 'Jev flag F1 vs incumbent F1')?.pass).toBe(false);
  });

  it('fails when too many Jev calls were inconclusive, even if the answered ones were right', () => {
    const v = evaluateD017(scoreDocContradictionBench(good, { ...CALLS, jevInconclusive: Math.ceil(CALLS.jevCalls * (D017_BAR.maxInconclusiveRate + 0.01)) }));
    expect(v.criteria.find((c) => c.name === 'Jev inconclusive calls')?.pass).toBe(false);
  });

  it('renders the verdict and names the pairs a judge got wrong', () => {
    const m = scoreDocContradictionBench([row('o1', 'opposite-instructions', COMPAT, true)], CALLS);
    const md = renderDocContradictionReport({ generatedAt: 'T', calls: CALLS, metrics: m, verdict: evaluateD017(m), pairs: [row('o1', 'opposite-instructions', COMPAT, true)] });
    expect(md).toContain('does NOT meet the D-017 bar');
    expect(md).toMatch(/\| o1 \| opposite-instructions \| compatible \(0\.10\) ✗ \| contradicts \|/);
  });
});

describe('DOC_CONTRADICTION_SAMPLE (frozen for D-017)', () => {
  it('has 40 pairs with unique ids and non-empty passages', () => {
    expect(DOC_CONTRADICTION_SAMPLE).toHaveLength(40);
    expect(new Set(DOC_CONTRADICTION_SAMPLE.map((p) => p.id)).size).toBe(40);
    for (const p of DOC_CONTRADICTION_SAMPLE) {
      expect(p.a.content.trim().length).toBeGreaterThan(0);
      expect(p.b.content.trim().length).toBeGreaterThan(0);
      expect(p.a.id).not.toBe(p.b.id);
    }
  });

  it('keeps the gold mix it was measured with', () => {
    const count = (gold: JevContradictionLabel) => DOC_CONTRADICTION_SAMPLE.filter((p) => p.gold === gold).length;
    expect({ opposite: count('opposite-instructions'), compatible: count('compatible'), unrelated: count('unrelated') }).toEqual({
      opposite: 14,
      compatible: 16,
      unrelated: 10,
    });
  });
});
