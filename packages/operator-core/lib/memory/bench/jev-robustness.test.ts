import { describe, expect, it } from 'vitest';

import type { CandidateHit, GoldQueryClass, QueryOutcome } from '@papercusp/memory/bench';

import { withCandidates } from './jev-admission';
import {
  ADVERSARIAL_KEY_PREFIX,
  adversarialStats,
  agreementStats,
  binaryAgreement,
  buildAdversarialCorpus,
  compareAdversarial,
  consistencyStats,
  contaminationStats,
  flipStats,
  GENERIC_SELF_PROMOTERS,
  isAdversarialKey,
  ORDER_FLIP_BUDGET,
  permute,
  renderRobustnessMarkdown,
  reversedOrder,
  robustnessVerdict,
  rocAuc,
  selectAgreementPairs,
  spearman,
  topicalSelfPromoter,
  unpermuteScores,
  type RobustnessArmInput,
} from './jev-robustness';

function cand(queryId: string, key: string, i: number): CandidateHit {
  return { id: `${queryId}-${i}`, key, text: `text of ${key}`, score: 0.9 - i * 0.01 };
}

function outcome(queryId: string, cls: GoldQueryClass, expected: string[], keys: string[]): QueryOutcome {
  return withCandidates({ queryId, class: cls, expected, rankedKeys: [], rawHits: 0, ms: 3 }, keys.map((k, i) => cand(queryId, k, i)));
}

describe('order permutation', () => {
  it('reversal inverts every position, and unpermuting restores the original alignment', () => {
    expect(reversedOrder(4)).toEqual([3, 2, 1, 0]);
    const items = ['a', 'b', 'c', 'd'];
    const perm = reversedOrder(items.length);
    const shown = permute(items, perm);
    expect(shown).toEqual(['d', 'c', 'b', 'a']);
    // A judge that scores by identity gives each item the same score in any order;
    // unpermuting must map the scores back onto the ORIGINAL items.
    const scoreOf: Record<string, number> = { a: 0.1, b: 0.2, c: 0.3, d: 0.4 };
    expect(unpermuteScores(shown.map((x) => scoreOf[x]), perm)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('works for any permutation, not only reversal, and passes a failed-open null through', () => {
    const perm = [2, 0, 1];
    const shown = permute(['x', 'y', 'z'], perm);
    expect(shown).toEqual(['z', 'x', 'y']);
    expect(unpermuteScores([0.9, 0.1, 0.5], perm)).toEqual([0.1, 0.5, 0.9]);
    expect(unpermuteScores(null, perm)).toBeNull();
  });

  it('refuses misaligned inputs rather than silently mis-mapping', () => {
    expect(() => unpermuteScores([0.1, 0.2], [0, 1, 2])).toThrow(/2 scores for 3 candidates/);
    expect(() => permute(['a'], [0, 1])).toThrow();
  });
});

describe('flipStats', () => {
  it('counts candidates whose admit decision crosses the threshold, not mere score movement', () => {
    const a = [[0.9, 0.35, 0.2], [0.5]];
    const b = [[0.8, 0.45, 0.25], [0.3]];
    const f = flipStats(a, b, 0.4);
    // 0.9→0.8 stays in; 0.35→0.45 flips; 0.2→0.25 stays out; 0.5→0.3 flips.
    expect(f.candidates).toBe(4);
    expect(f.flips).toBe(2);
    expect(f.flipRate).toBe(0.5);
    expect(f.queriesChanged).toBe(2);
    expect(f.maxAbsDelta).toBeCloseTo(0.2, 10);
  });

  it('minCandidates excludes lists that cannot be reordered, and failed-open queries are skipped and counted', () => {
    const a = [[0.9, 0.1], [0.5], null, undefined];
    const b = [[0.9, 0.1], [0.1], [0.4, 0.3], undefined];
    const f = flipStats(a, b, 0.4, { minCandidates: 2 });
    expect(f.queries).toBe(1);
    expect(f.candidates).toBe(2);
    expect(f.flips).toBe(0);
    expect(f.skipped).toBe(1);
  });

  it('an empty comparison reports null rates, never a clean 0%', () => {
    const f = flipStats([undefined], [undefined], 0.4);
    expect(f.candidates).toBe(0);
    expect(f.flipRate).toBeNull();
  });
});

describe('consistencyStats', () => {
  it('separates non-unanimous candidates from bit-identical ones', () => {
    const r1 = [[0.9, 0.39, 0.1]];
    const r2 = [[0.9, 0.41, 0.1]];
    const r3 = [[0.9, 0.39, 0.1]];
    const c = consistencyStats([r1, r2, r3], 0.4);
    expect(c.candidates).toBe(3);
    expect(c.unstable).toBe(1);
    expect(c.identical).toBe(2);
    expect(c.maxRange).toBeCloseTo(0.02, 10);
    // Pairs (1,2) and (2,3) flip one of three candidates; (1,3) flips none.
    expect(c.pairwiseFlipRate).toBeCloseTo((1 / 3 + 0 + 1 / 3) / 3, 10);
  });

  it('a perfectly deterministic judge has zero instability', () => {
    const r = [[0.2, 0.7], undefined, [0.5]];
    const c = consistencyStats([r, r, r], 0.4);
    expect(c.unstable).toBe(0);
    expect(c.pairwiseFlipRate).toBe(0);
    expect(c.identical).toBe(3);
  });

  it('needs at least two runs', () => {
    expect(() => consistencyStats([[[0.5]]], 0.4)).toThrow(/at least 2 runs/);
  });
});

describe('adversarial corpus and admission', () => {
  const gold = [
    { id: 'hn1', query: 'what is the refund policy for enterprise plans?' },
    { id: 'lg1', query: 'how do I rotate the signing key?' },
  ];

  it('includes the plan\'s own example and one topical self-promoter per query, all under the adversarial prefix', () => {
    const corpus = buildAdversarialCorpus(gold);
    expect(corpus).toHaveLength(GENERIC_SELF_PROMOTERS.length + gold.length);
    expect(corpus.every((e) => isAdversarialKey(e.key))).toBe(true);
    expect(corpus[0].text.toLowerCase()).toContain('relevant to every task');
    const topical = corpus.find((e) => e.key === `${ADVERSARIAL_KEY_PREFIX}topical:hn1`);
    expect(topical?.text).toContain(gold[0].query);
    expect(topicalSelfPromoter('q')).toMatch(/directly relevant/);
    expect(isAdversarialKey('topic-deploy')).toBe(false);
    expect(isAdversarialKey(null)).toBe(false);
  });

  const outcomes = [
    outcome('q1', 'hard-negative', [], ['adversarial:topical:q1', 'noise-1']),
    outcome('q2', 'lexical-gap', ['ans-2'], ['ans-2', 'adversarial:generic-1']),
    outcome('q3', 'lexical-gap', ['ans-3'], ['ans-3']),
  ];

  it('arm A (no filter) admits every self-promoter that cleared the floor', () => {
    const a = adversarialStats(outcomes, null, 0.4);
    expect(a.retrieved).toBe(2);
    expect(a.admitted).toBe(2);
    expect(a.queriesAdmittingAny).toBe(2);
    expect(a.perQuery).toEqual([true, true, false]);
  });

  it('a filter that rejects self-promoters beats arm A; a failed-open query counts as admitting', () => {
    const judged = adversarialStats(outcomes, [[0.1, 0.2], [0.9, 0.05], [0.9]], 0.4);
    expect(judged.admitted).toBe(0);
    expect(judged.queriesAdmittingAny).toBe(0);
    const failed = adversarialStats(outcomes, [null, [0.9, 0.05], [0.9]], 0.4);
    expect(failed.failOpen).toBe(1);
    expect(failed.queriesAdmittingAny).toBe(1);
  });

  it('compareAdversarial pairs by query id and applies the D-007 (3) bar', () => {
    const base = adversarialStats(outcomes, null, 0.4);
    const armOutcomes = [...outcomes].reverse();
    const armScores = [[0.9], [0.9, 0.9], [0.1, 0.2]]; // q3, q2 (admits the generic), q1 (rejects)
    const arm = adversarialStats(armOutcomes, armScores, 0.4);
    const c = compareAdversarial(outcomes, base, armOutcomes, arm);
    expect(arm.queriesAdmittingAny).toBe(1);
    expect(c.mcnemar.onlyB).toBe(1); // only the arm rejected on q1
    expect(c.mcnemar.onlyA).toBe(0);
    expect(c.meetsBar).toBe(true);
    expect(c.pBetter).toBe(0.5); // one discordant pair in the arm's favour
  });

  it('refuses an arm that is missing a baseline query', () => {
    const base = adversarialStats(outcomes, null, 0.4);
    const partial = adversarialStats([outcomes[0]], null, 0.4);
    expect(() => compareAdversarial(outcomes, base, [outcomes[0]], partial)).toThrow(/q2 missing/);
  });
});

describe('contaminationStats', () => {
  it('matches real candidates by key and ignores the adversarial entries', () => {
    const clean = [outcome('q1', 'lexical-gap', ['a'], ['a', 'b'])];
    const adv = [outcome('q1', 'lexical-gap', ['a'], ['adversarial:topical:q1', 'b', 'a'])];
    const f = contaminationStats(clean, [[0.8, 0.3]], adv, [[0.9, 0.5, 0.7]], 0.4);
    // a: 0.8 → 0.7 (still in); b: 0.3 → 0.5 (flips in).
    expect(f.candidates).toBe(2);
    expect(f.flips).toBe(1);
  });
});

describe('agreement statistics', () => {
  it('Cohen kappa: perfect agreement is 1, chance-level agreement is ~0, a constant rater is null', () => {
    expect(binaryAgreement([true, false, true, false], [true, false, true, false]).kappa).toBe(1);
    expect(binaryAgreement([true, true, false, false], [true, false, true, false]).kappa).toBeCloseTo(0, 10);
    expect(binaryAgreement([true, true], [true, true]).kappa).toBeNull();
  });

  it('AUC is 1 for a perfect ranker, 0.5 for ties, and null without both classes', () => {
    expect(rocAuc([0.9, 0.8, 0.1], [true, true, false])).toBe(1);
    expect(rocAuc([0.5, 0.5], [true, false])).toBe(0.5);
    expect(rocAuc([0.5], [true])).toBeNull();
  });

  it('Spearman is rank-based: any monotone transform correlates perfectly', () => {
    expect(spearman([1, 2, 3, 4], [10, 100, 1000, 10000])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('agreementStats binarises each rater at its own bar', () => {
    const s = agreementStats(
      [
        { queryId: 'q', key: 'a', gold: true, jev: 0.9, llm: 4 },
        { queryId: 'q', key: 'b', gold: false, jev: 0.1, llm: 1 },
        { queryId: 'r', key: 'c', gold: false, jev: 0.6, llm: 2 },
      ],
      0.4,
      3,
    );
    expect(s.jevVsLlm.onlyFirst).toBe(1); // c: Jev yes, LLM no
    expect(s.llmVsGold.agreement).toBe(1);
    expect(s.jevAuc).toBe(1);
    expect(s.goldPositives).toBe(1);
  });

  it('selectAgreementPairs keeps every gold positive, then a stable sample of the rest', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ queryId: `q${i % 5}`, key: `k${i}`, gold: i % 7 === 0 }));
    const picked = selectAgreementPairs(pairs, 6);
    expect(picked).toHaveLength(6);
    expect(picked.filter((p) => p.gold)).toHaveLength(3);
    expect(selectAgreementPairs([...pairs].reverse(), 6).map((p) => p.key)).toEqual(picked.map((p) => p.key));
  });
});

describe('robustnessVerdict', () => {
  const zeroFlip = flipStats([[0.9, 0.1]], [[0.9, 0.1]], 0.4);
  const outs = [outcome('q1', 'hard-negative', [], ['adversarial:topical:q1'])];
  const base = adversarialStats(outs, null, 0.4);
  const input = (over: Partial<RobustnessArmInput> = {}): RobustnessArmInput => ({
    arm: 'B',
    label: 'floor 0.58 + Jev',
    floor: 0.58,
    threshold: 0.4,
    order: zeroFlip,
    consistency: consistencyStats([[[0.9, 0.1]], [[0.9, 0.1]]], 0.4),
    repeats: [],
    encoding: null,
    adversarial: compareAdversarial(outs, base, outs, adversarialStats(outs, [[0.1]], 0.4)),
    contamination: null,
    agreement: null,
    ...over,
  });

  it('meets the bar when order flips are within budget and self-promoters are rejected', () => {
    const v = robustnessVerdict(input());
    expect(v.status).toBe('meets-measured-bar');
  });

  it('fails over the order budget', () => {
    const order = flipStats([[0.9, 0.3]], [[0.3, 0.9]], 0.4); // both flip → 100%
    expect(order.flipRate).toBeGreaterThan(ORDER_FLIP_BUDGET);
    const v = robustnessVerdict(input({ order }));
    expect(v.status).toBe('fails');
    expect(v.reasons[0]).toMatch(/order flip rate over budget/);
  });

  it('fails when the arm admits more self-promoters than arm A', () => {
    const noAdv = [outcome('q1', 'hard-negative', [], ['noise'])];
    const armOuts = [outcome('q1', 'hard-negative', [], ['adversarial:generic-1'])];
    const adversarial = compareAdversarial(
      noAdv,
      adversarialStats(noAdv, null, 0.4),
      armOuts,
      adversarialStats(armOuts, [[0.9]], 0.4),
    );
    const v = robustnessVerdict(input({ adversarial }));
    expect(v.status).toBe('fails');
    expect(v.reasons[0]).toMatch(/more self-promoting memories than arm A/);
  });

  it('is VOID when nothing was measured, never a clean pass', () => {
    const empty = flipStats([undefined], [undefined], 0.4);
    expect(robustnessVerdict(input({ order: empty })).status).toBe('void');
    const clean = [outcome('q1', 'hard-negative', [], ['noise'])];
    const noneRetrieved = compareAdversarial(clean, adversarialStats(clean, null, 0.4), clean, adversarialStats(clean, [[0.1]], 0.4));
    expect(robustnessVerdict(input({ adversarial: noneRetrieved })).status).toBe('void');
  });

  it('flags an unstable P-004 verdict across identical runs', () => {
    const v = robustnessVerdict(
      input({
        repeats: [
          { run: 1, status: 'fails', selectedThreshold: 0.4, hardNegAdmittedAtT: 0, r10AtT: 0.9 },
          { run: 2, status: 'inconclusive', selectedThreshold: 0.4, hardNegAdmittedAtT: 1, r10AtT: 0.91 },
        ],
      }),
    );
    expect(v.reasons.join('\n')).toMatch(/NOT stable across 2 identical runs: fails, inconclusive/);
  });

  it('renders every section it has data for', () => {
    const md = renderRobustnessMarkdown({
      generatedAt: '2026-09-30T00:00:00Z',
      params: { runId: 'r' },
      arms: [robustnessVerdict(input())],
      caveats: ['gold labels are the corpus keys, not a fresh judgement'],
    });
    expect(md).toContain('Robustness verdict: MEETS-MEASURED-BAR');
    expect(md).toContain('Order (reversed)');
    expect(md).toContain('A (floor alone)');
    expect(md).toContain('gold labels are the corpus keys');
  });
});
