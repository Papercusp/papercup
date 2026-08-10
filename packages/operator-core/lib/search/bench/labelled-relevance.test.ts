/**
 * The labelled pass's arithmetic, tested offline at $0 with an injected judge.
 *
 * D-079 Q1's split: gate-test the deterministic machinery around the judge, run
 * the LLM deliberately. Every rule below decides whether a $12-15 run means
 * what it says — the grade mapping that ties the pass bar to precision, the two
 * exclusions that keep a vacuous zero out of a mean, and the honesty fields
 * that let a degraded run void itself instead of publishing a confident null.
 */
import { describe, expect, it, vi } from 'vitest';

import { precisionAtK } from '@papercusp/search-core';

import { RELEVANCE_PASS_BAR, type JudgeVerdict } from './judge-agreement';
import {
  aggregateByTool,
  formatLabelledReport,
  judgeScoreToGrade,
  runLabelledPass,
  scoreQuery,
  type LabelledHit,
  type RetrievalResult,
} from './labelled-relevance';

const hit = (rank: number, docId = `d${rank}`): { docId: string; docText: string; rank: number } => ({
  docId,
  docText: `document ${docId}`,
  rank,
});

const ok = (hits: number, over: Partial<RetrievalResult> = {}): RetrievalResult => ({
  hits: Array.from({ length: hits }, (_, i) => hit(i + 1)),
  degraded: false,
  rerankApplied: true,
  ...over,
});

const verdict = (relevance: number): JudgeVerdict => ({
  relevance,
  judgedRelevant: relevance >= RELEVANCE_PASS_BAR,
  judgeCostUsd: 0.01,
  judgeNotes: `scored ${relevance}`,
});

describe('judgeScoreToGrade', () => {
  it('bands 0..5 onto the metric contract 0..3', () => {
    expect([0, 1, 2, 3, 4, 5].map(judgeScoreToGrade)).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('makes "the judge called it relevant" and "precision@k counts it" the SAME predicate', () => {
    // The load-bearing property. A document scored exactly at the pass bar must
    // land at or above precision@k's default threshold of 2, or the pass
    // reports a precision that disagrees with its own labels.
    const atBar: LabelledHit[] = [
      { ...hit(1), relevance: RELEVANCE_PASS_BAR, grade: judgeScoreToGrade(RELEVANCE_PASS_BAR), judgeCostUsd: 0 },
    ];
    expect(atBar[0]!.grade).toBeGreaterThanOrEqual(2);
    expect(precisionAtK(atBar.map((h) => h.grade), 10, 2)).toBe(1);
  });

  it('is NOT a linear rescale — that would put the pass bar below the precision threshold', () => {
    // score * 3/5 maps the bar (3) to 1.8, i.e. grade 1 once rounded down: a
    // document the judge called relevant would then not count as a precision
    // hit, and the reported precision would silently understate the labels.
    const linear = Math.floor((RELEVANCE_PASS_BAR * 3) / 5);
    expect(linear).toBeLessThan(2);
    expect(judgeScoreToGrade(RELEVANCE_PASS_BAR)).toBe(2);
  });

  it('clamps out-of-range scores and refuses a non-finite one', () => {
    expect(judgeScoreToGrade(9)).toBe(3);
    expect(judgeScoreToGrade(-2)).toBe(0);
    expect(() => judgeScoreToGrade(Number.NaN)).toThrow(/finite/);
  });
});

describe('scoreQuery', () => {
  it('reports recall as null — this pass has no externally-known relevant set', () => {
    // A 0 here would read as "found none of them", the strongest possible
    // failure claim, from a run that is PRODUCING the labels and had nothing
    // to find.
    const res = scoreQuery([{ ...hit(1), relevance: 5, grade: 3, judgeCostUsd: 0 }]);
    expect(res.recallAtK).toBeNull();
    expect(res.coverage).toBe('complete');
  });

  it('marks an empty ranking as empty-ranking, not as a complete zero', () => {
    expect(scoreQuery([]).coverage).toBe('empty-ranking');
  });
});

describe('runLabelledPass', () => {
  const oneQuery = [{ tool: 'docs:search', query: 'a b c', terms: 3 }];

  it('judges the top k and scores the ranking', async () => {
    const judge = vi.fn(async () => verdict(5));
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(12),
      judge,
      k: 10,
      sampleSeed: 's',
    });
    expect(judge).toHaveBeenCalledTimes(10); // k, not the 12 retrieved
    expect(report.judgedHits).toBe(10);
    expect(report.outcomes[0]!.ndcgAtK).toBe(1);
    expect(report.outcomes[0]!.hits[0]!.grade).toBe(3);
    expect(report.judgeCostUsd).toBeCloseTo(0.1, 6);
  });

  it('EXCLUDES a degraded query, judges nothing for it, and says so on the number', async () => {
    // A null embedder degrades the engine to lexical-only. That measured a
    // different system: averaging it in would report keyword ranking as hybrid,
    // and paying to label it would be paying for a ranking already discarded.
    const judge = vi.fn(async () => verdict(5));
    const report = await runLabelledPass({
      queries: [...oneQuery, { tool: 'docs:search', query: 'd e f', terms: 3 }],
      retrieve: async (q) =>
        q === 'a b c' ? ok(3) : ok(3, { degraded: true, degradeWarning: 'semantic leg did not run' }),
      judge,
      k: 10,
      sampleSeed: 's',
    });
    expect(judge).toHaveBeenCalledTimes(3); // only the healthy query
    const degradedOutcome = report.outcomes.find((o) => o.degraded)!;
    expect(degradedOutcome.ndcgAtK).toBeNull();
    expect(degradedOutcome.excludedReason).toMatch(/DEGRADED.*semantic leg did not run/);
    expect(report.overall.n).toBe(1);
    expect(report.overall.excluded).toBe(1);
    expect(report.caveats.join(' ')).toContain('1 of 2 queries excluded as DEGRADED');
  });

  it('EXCLUDES an empty ranking rather than averaging in a vacuous zero', async () => {
    // ndcg → 0 for an empty ranking is indistinguishable from "retrieval worked
    // and everything it found was irrelevant" — opposite verdicts.
    const report = await runLabelledPass({
      queries: [...oneQuery, { tool: 'docs:search', query: 'd e f', terms: 3 }],
      retrieve: async (q) => (q === 'a b c' ? ok(3) : ok(0)),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 's',
    });
    const empty = report.outcomes.find((o) => o.query === 'd e f')!;
    expect(empty.coverage).toBe('empty-ranking');
    expect(empty.excludedReason).toMatch(/no hits/);
    // The mean is 1.0 (the one query that was measured), NOT 0.5.
    expect(report.overall.meanNdcgAtK).toBe(1);
    expect(report.overall.n).toBe(1);
  });

  it('flags a run whose Stage B rerank did not actually rank', async () => {
    // The reranker is fail-soft: a total degrade returns the retrieval order,
    // byte-identical to no reranking. A pass that cannot say which it got is
    // publishing a different pipeline than an interactive caller gets.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(3, { rerankApplied: false }),
      judge: async () => verdict(4),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.rerankApplied).toBe(false);
    expect(report.caveats.join(' ')).toMatch(/1 scored queries ran WITHOUT Stage B/);
  });

  it('preserves RANK ORDER when judging concurrently, and bounds the in-flight count', async () => {
    // Every metric downstream reads the labelled array positionally. A result
    // reordered by completion time would still produce a plausible nDCG — of a
    // ranking the engine never returned.
    let inFlight = 0;
    let peak = 0;
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(8),
      judge: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Later ranks finish FIRST — the ordering trap, made deterministic.
        const rank = Number(input.pairId.split(':').pop());
        await new Promise((r) => setTimeout(r, (9 - rank) * 4));
        inFlight--;
        return verdict(rank <= 2 ? 5 : 0);
      },
      k: 10,
      judgeConcurrency: 3,
      sampleSeed: 's',
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(report.outcomes[0]!.hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The two relevant docs are at ranks 1-2, so this is a perfect ranking.
    expect(report.outcomes[0]!.ndcgAtK).toBe(1);
  });

  it('hands every per-query row to onQueryDone as it lands', async () => {
    // A paid run that dies at query 120 must still be worth 120 queries.
    const seen: string[] = [];
    await runLabelledPass({
      queries: [oneQuery[0]!, { tool: 'plans:search', query: 'd e f', terms: 3 }],
      retrieve: async () => ok(2),
      judge: async () => verdict(3),
      k: 10,
      sampleSeed: 's',
      onQueryDone: (o) => seen.push(o.query),
    });
    expect(seen).toEqual(['a b c', 'd e f']);
  });

  it('keeps the judge rationale on every hit', async () => {
    // The aggregates cannot adjudicate a surprising number; the rationales can,
    // and re-deriving them means paying for the whole run again.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(1),
      judge: async () => verdict(2),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.hits[0]!.judgeNotes).toBe('scored 2');
  });

  it('reports strata separately and never pools them', async () => {
    const report = await runLabelledPass({
      queries: [
        { tool: 'docs:search', query: 'a b c', terms: 3 },
        { tool: 'plans:search', query: 'd e f', terms: 3 },
      ],
      retrieve: async () => ok(1),
      judge: async (input) => verdict(input.query === 'a b c' ? 5 : 0),
      k: 10,
      sampleSeed: 's',
    });
    const by = new Map(report.byTool.map((a) => [a.tool, a]));
    expect(by.get('docs:search')!.meanNdcgAtK).toBe(1);
    expect(by.get('plans:search')!.meanNdcgAtK).toBe(0);
    expect(by.get('plans:search')!.pollutionRate).toBe(1);
    expect(report.overall.meanNdcgAtK).toBe(0.5);
  });

  it('carries the frozen contract and the not-a-floor caveat on the report itself', async () => {
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(1),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 'p038-labelled-v1',
    });
    expect(report.rubricVersion).toBe('search-relevance.v1');
    expect(report.passBar).toBe(RELEVANCE_PASS_BAR);
    expect(report.sampleSeed).toBe('p038-labelled-v1');
    // D-074: no floor off one run.
    expect(report.caveats.join(' ')).toContain('NOT A FLOOR');
    // The caveats must be IN the rendered report, not a footnote elsewhere.
    expect(formatLabelledReport(report)).toContain('NOT A FLOOR');
  });
});

describe('aggregateByTool', () => {
  it('returns an empty roll-up for no outcomes rather than dividing by zero', () => {
    expect(aggregateByTool([])).toEqual([]);
  });
});

describe('ndcgUninformative', () => {
  const graded = (grades: number[]): LabelledHit[] =>
    grades.map((g, i) => ({ ...hit(i + 1), relevance: g === 3 ? 5 : 0, grade: g, judgeCostUsd: 0 }));

  it('marks the configuration where nDCG is invariant under ANY reordering', () => {
    // The property the field exists to make legible. With one distinct grade the
    // engine's ordering cannot move the score, so a 1.000 there is arithmetic,
    // not evidence that anything was ranked well.
    const forward = scoreQuery(graded([3, 3, 3]), 10).ndcgAtK;
    const reversed = scoreQuery([...graded([3, 3, 3])].reverse(), 10).ndcgAtK;
    expect(forward).toBe(1);
    expect(reversed).toBe(forward);
  });

  it('does NOT mark a query whose ranking the metric could actually have punished', () => {
    const best = scoreQuery(graded([3, 3, 0]), 10).ndcgAtK!;
    const worst = scoreQuery(graded([0, 3, 3]), 10).ndcgAtK!;
    // Mixed grades ⇒ order changes the score ⇒ nDCG carried real information.
    expect(worst).toBeLessThan(best);
    expect(new Set([3, 3, 0]).size).toBeGreaterThan(1);
  });

  it('separates a vacuous 1.000 from an earned one in the aggregate', async () => {
    const report = await runLabelledPass({
      queries: [
        { tool: 'docs:search', query: 'uniform', terms: 1 },
        { tool: 'docs:search', query: 'mixed', terms: 1 },
      ],
      retrieve: async () => ok(2),
      judge: async (input) =>
        input.query === 'uniform' ? verdict(5) : verdict(input.docId === 'd1' ? 5 : 0),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.overall.n).toBe(2);
    // Both queries score; only one of them had a score that could have moved.
    expect(report.overall.ndcgUninformative).toBe(1);
  });

  it('quotes its own share in the caveat and renders it beside the column it qualifies', async () => {
    const report = await runLabelledPass({
      queries: [{ tool: 'docs:search', query: 'all relevant', terms: 2 }],
      retrieve: async () => ok(3),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.overall.meanNdcgAtK).toBe(1);
    expect(report.overall.ndcgUninformative).toBe(1);
    // The share is computed from the SAME roll-up that is reported, so the prose
    // and the table cannot drift apart.
    expect(report.caveats.join(' ')).toContain('1/1 scored queries had a uniform grade vector');
    const rendered = formatLabelledReport(report);
    expect(rendered).toContain('NOT A SEARCH-QUALITY SCORE');
    expect(rendered).toContain('uninf');
    expect(rendered).toContain('1/1');
  });
});
