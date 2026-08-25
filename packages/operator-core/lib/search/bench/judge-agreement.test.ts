/**
 * Unit tests for P-038's judge-agreement core (WI-37638).
 *
 * The judge itself is an LLM and cannot be asserted on here — what CAN rot
 * silently is the ARITHMETIC around it, and that is what these pin:
 *   - sensitivity and specificity stay SEPARATE (the blended rate is the
 *     number that would quietly overstate the judge),
 *   - self-consistency counts BINARY FLIPS, not just |Δ| (a |Δ| that never
 *     crosses the bar injects no label noise; one that crosses it flips a label),
 *   - the re-judge rows never double-count into the arm aggregates,
 *   - pair construction is deterministic and excludes the referenced item.
 *
 * The LLM transport is a scripted fake, so these run offline at zero cost.
 */
import { describe, expect, it } from 'vitest';

import type { LlmCallFn } from '@papercusp/testing-shell/llm';

import {
  aggregateByArm,
  buildPairsForQuery,
  JUDGE_AGREEMENT_RUBRIC_VERSION,
  runJudgeAgreement,
  RELEVANCE_PASS_BAR,
  SEARCH_RELEVANCE_RUBRIC,
  type JudgedPair,
  type PairOutcome,
} from './judge-agreement';
import { sha256 } from './judge-cache';
import type { GoldQuery, PoolDoc } from './ref-expansion-gold';

/**
 * A fake judge that returns a scripted score per call, in order. Mirrors the
 * real transport's result shape so `judgeRun` parses it on the happy path.
 */
function fakeJudge(scores: readonly number[]): { llm: LlmCallFn; calls: () => number } {
  let i = 0;
  const llm: LlmCallFn = async () => {
    const relevance = scores[i % scores.length]!;
    i++;
    return {
      text: JSON.stringify({ scores: { relevance } }),
      json: { scores: { relevance }, notes: `scripted ${relevance}` },
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      raw: {},
    };
  };
  return { llm, calls: () => i };
}

function pair(over: Partial<JudgedPair> & Pick<JudgedPair, 'pairId' | 'goldRelevant'>): JudgedPair {
  return {
    ref: 'WI-1',
    arm: 'verbatim',
    query: 'q',
    docId: 'D-1',
    docText: 'doc',
    ...over,
  };
}

function outcome(over: Partial<PairOutcome> & Pick<PairOutcome, 'goldRelevant' | 'relevance'>): PairOutcome {
  const judgedRelevant = over.relevance >= RELEVANCE_PASS_BAR;
  return {
    pairId: `p${Math.random()}`,
    ref: 'WI-1',
    arm: 'verbatim',
    query: 'q',
    docId: 'D-1',
    docText: 'doc',
    judgedRelevant,
    agrees: judgedRelevant === over.goldRelevant,
    judgeCostUsd: 0,
    ...over,
  };
}

describe('aggregateByArm', () => {
  it('reports sensitivity and specificity SEPARATELY rather than one blended rate', () => {
    // 2 positives, both missed by the judge; 6 negatives, all correctly rejected.
    const outcomes: PairOutcome[] = [
      outcome({ goldRelevant: true, relevance: 1 }),
      outcome({ goldRelevant: true, relevance: 2 }),
      ...Array.from({ length: 6 }, () => outcome({ goldRelevant: false, relevance: 0 })),
    ];
    const [agg] = aggregateByArm(outcomes);

    expect(agg!.positives.sensitivity).toBe(0);
    expect(agg!.negatives.specificity).toBe(1);
    // The blended number looks like a 75%-accurate judge while it is in fact
    // catching NONE of the relevant documents — this is why it is never quoted alone.
    expect(agg!.rawAgreement).toBe(0.75);
  });

  it('separates the two arms instead of pooling them', () => {
    const outcomes: PairOutcome[] = [
      outcome({ arm: 'verbatim', goldRelevant: true, relevance: 5 }),
      outcome({ arm: 'verbatim', goldRelevant: false, relevance: 0 }),
      outcome({ arm: 'degraded', goldRelevant: true, relevance: 1 }),
      outcome({ arm: 'degraded', goldRelevant: false, relevance: 0 }),
    ];
    const byArm = aggregateByArm(outcomes);
    const verbatim = byArm.find((a) => a.arm === 'verbatim')!;
    const degraded = byArm.find((a) => a.arm === 'degraded')!;

    expect(verbatim.positives.sensitivity).toBe(1);
    expect(degraded.positives.sensitivity).toBe(0);
    // Separation is the judge's discrimination on that arm.
    expect(verbatim.separation).toBe(5);
    expect(degraded.separation).toBe(1);
  });

  it('scores an empty class as 0 without dividing by zero', () => {
    const [agg] = aggregateByArm([outcome({ goldRelevant: true, relevance: 4 })]);
    expect(agg!.negatives.n).toBe(0);
    expect(agg!.negatives.specificity).toBe(0);
    expect(Number.isNaN(agg!.negatives.meanScore)).toBe(false);
  });
});

describe('content-derived rubric version', () => {
  it('changes the cache namespace when the serialized judging axes change', () => {
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).toBe(
      `search-relevance.${sha256(JSON.stringify({ axes: SEARCH_RELEVANCE_RUBRIC.axes })).slice(0, 12)}`,
    );
    expect(SEARCH_RELEVANCE_RUBRIC.version).toBe(JUDGE_AGREEMENT_RUBRIC_VERSION);
  });
});

describe('runJudgeAgreement self-consistency', () => {
  it('counts a BINARY FLIP only when the re-judge crosses the pass bar', async () => {
    // First pass scores every pair 4 (relevant). The re-judge pass scores 5 —
    // a |Δ| of 1 that changes no label.
    const pairs = [pair({ pairId: 'a', goldRelevant: true }), pair({ pairId: 'b', goldRelevant: true })];
    const { llm } = fakeJudge([4, 4, 5, 5]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 2 });

    expect(report.selfConsistency).not.toBeNull();
    expect(report.selfConsistency!.meanAbsDelta).toBe(1);
    // The delta moved but no label did — the flip rate is what bounds label noise.
    expect(report.selfConsistency!.flipRate).toBe(0);
  });

  it('counts a flip when the re-judge crosses the bar downward', async () => {
    const pairs = [pair({ pairId: 'a', goldRelevant: true })];
    // 3 (relevant, at the bar) then 2 (not relevant) — |Δ| 1 that DOES flip.
    const { llm } = fakeJudge([3, 2]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 1 });

    expect(report.selfConsistency!.meanAbsDelta).toBe(1);
    expect(report.selfConsistency!.flipRate).toBe(1);
  });

  it('excludes the re-judge rows from the arm aggregates', async () => {
    const pairs = [pair({ pairId: 'a', goldRelevant: true }), pair({ pairId: 'b', goldRelevant: false })];
    const { llm } = fakeJudge([5, 0, 5, 0]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 2 });
    const [agg] = report.byArm;

    // 4 outcomes are retained (2 first-pass + 2 re-judged) but only the 2
    // first-pass rows may count, or every rate is computed over a doubled n.
    expect(report.outcomes).toHaveLength(4);
    expect(agg!.positives.n).toBe(1);
    expect(agg!.negatives.n).toBe(1);
    expect(report.outcomes.filter((o) => o.pairId.endsWith('#rejudge'))).toHaveLength(2);
  });

  it('reports null self-consistency when disabled rather than a fabricated zero', async () => {
    const { llm } = fakeJudge([4]);
    const report = await runJudgeAgreement({
      pairs: [pair({ pairId: 'a', goldRelevant: true })],
      llm,
      selfConsistencyN: 0,
    });
    // A 0% flip rate and "never measured" must not be the same value.
    expect(report.selfConsistency).toBeNull();
  });

  it('carries the limits with the numbers', async () => {
    const { llm } = fakeJudge([4]);
    const report = await runJudgeAgreement({
      pairs: [pair({ pairId: 'a', goldRelevant: true })],
      llm,
      selfConsistencyN: 0,
    });
    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats.join(' ')).toMatch(/UPPER BOUND/);
    expect(report.caveats.join(' ')).toMatch(/LOWER bound/);
  });
});

describe('buildPairsForQuery', () => {
  const pool: PoolDoc[] = [
    { id: 'D-cites', v1Text: 'cites the ref', v2Text: '', refs: ['WI-9'] },
    { id: 'WI-9', v1Text: 'the referenced item itself', v2Text: '', refs: [] },
    { id: 'D-other-1', v1Text: 'unrelated one', v2Text: '', refs: [] },
    { id: 'D-other-2', v1Text: 'unrelated two', v2Text: '', refs: [] },
  ];
  const q: GoldQuery = {
    ref: 'WI-9',
    text: 'the referenced item title',
    degraded: 'referenced title',
    relevantIds: ['D-cites'],
  };

  it('never draws the referenced item itself as a negative', () => {
    const pairs = buildPairsForQuery(q, pool);
    const negatives = pairs.filter((p) => !p.goldRelevant);
    expect(negatives.length).toBeGreaterThan(0);
    // WI-9 is topically identical to the query but gold never labels it
    // relevant (it does not cite itself) — drawing it would manufacture a
    // disagreement and charge it to the judge.
    expect(negatives.every((p) => p.docId !== 'WI-9')).toBe(true);
  });

  it('is deterministic — a re-run judges the same pairs', () => {
    expect(buildPairsForQuery(q, pool)).toEqual(buildPairsForQuery(q, pool));
  });

  it('emits both arms with one positive and one negative each', () => {
    const pairs = buildPairsForQuery(q, pool);
    expect(pairs).toHaveLength(4);
    expect(pairs.filter((p) => p.arm === 'verbatim')).toHaveLength(2);
    expect(pairs.filter((p) => p.arm === 'degraded')).toHaveLength(2);
    expect(pairs.filter((p) => p.goldRelevant)).toHaveLength(2);
    expect(pairs.find((p) => p.arm === 'degraded')!.query).toBe('referenced title');
  });

  it('yields nothing when the query has no usable positive or negative', () => {
    const onlyRelevant: PoolDoc[] = [{ id: 'D-cites', v1Text: 'x', v2Text: '', refs: ['WI-9'] }];
    expect(buildPairsForQuery(q, onlyRelevant)).toEqual([]);
    expect(buildPairsForQuery({ ...q, relevantIds: ['D-missing'] }, pool)).toEqual([]);
  });
});
