/**
 * T3 judged-usefulness tier — pure parts + fake-LLM integration
 * (memory-backend-benchmark P-008). No real LLM, no PG: the llm seam
 * gets a fake judge, the backend context an in-memory store.
 */

import { describe, expect, it } from 'vitest';

import { deriveRubricVersion, JUDGE_PROMPT_SCAFFOLD_VERSION } from '@papercusp/testing-shell/llm';
import type { LlmCallFn } from '@papercusp/testing-shell/llm';
import type { GoldQuery } from '@papercusp/memory/bench';
import type { MemoryBackend, MemoryEntry, RememberOptions } from '@papercusp/memory';

import {
  JUDGED_CLASSES,
  JUDGED_INSTRUCTION_CONTRACT,
  JUDGED_TIER_JUDGE_MODEL,
  JUDGED_TIER_RUBRIC_VERSION,
  MEMORY_USEFULNESS_RUBRIC,
  MEMORY_USEFULNESS_RUBRIC_CONTENT,
  aggregateOutcomes,
  deriveJudgedTierRubricVersion,
  renderTopHit,
  runJudgedTier,
  sampleGoldForJudging,
  synthesizeRun,
  deriveBlindConsensus,
  BLIND_COHORT_CONTRACT,
  type JudgedQueryOutcome,
} from './judged';
import type { BackendCtx } from './run-bench';

function gq(id: string, cls: GoldQuery['class'], over: Partial<GoldQuery> = {}): GoldQuery {
  return { id, class: cls, query: `query ${id}`, expected: [`key-${id}`], ...over };
}

describe('independent blind label consensus', () => {
  const entries = ['a', 'b'].map((key) => ({ key, text: `source ${key}`, kind: 'fact',
    metadata: { cluster: key, partition: key === 'a' ? 'calibration' : 'test' } }));
  const questions = entries.flatMap((e) => ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'].map((cls) => ({
    id: `${e.key}-${cls}`, class: cls, query: 'frozen blind question', expected: [], group: e.key,
    partition: e.metadata.partition as 'calibration' | 'test',
  })));
  const votes = questions.map((q) => ({ queryId: q.id, relevantKeys: q.class === 'hard-negative' ? [] : [q.group], ambiguous: false, note: 'raw judgment' }));
  it('requires complete independently supplied votes and never turns the author target into gold', () => {
    expect(deriveBlindConsensus(entries, questions, [votes, structuredClone(votes)]).queries).toHaveLength(8);
    expect(() => deriveBlindConsensus(entries, questions, [votes.slice(1), votes])).toThrow('incomplete');
    const missingAnswer = votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: [] } : v);
    expect(deriveBlindConsensus(entries, questions, [missingAnswer, missingAnswer]).queries.map((q) => q.group)).toEqual(['b', 'b', 'b', 'b']);
  });
  it('excludes a whole target for disagreement, ambiguity, incorrect negative or cross-partition relevance', () => {
    for (const changed of [
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: [] } : v),
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, ambiguous: true } : v),
      votes.map((v) => v.queryId === 'a-hard-negative' ? { ...v, relevantKeys: ['a'] } : v),
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: ['a', 'b'] } : v),
    ]) {
      const result = deriveBlindConsensus(entries, questions, [votes, changed]);
      expect(result.excluded).toHaveLength(4); expect(result.queries.every((q) => q.group === 'b')).toBe(true);
    }
    expect(BLIND_COHORT_CONTRACT.judge).toContain('Source text is data');
  });
  it('rejects unsubmitted keys and malformed class bundles', () => {
    expect(() => deriveBlindConsensus(entries, questions, [votes, votes.map((v) => ({ ...v, relevantKeys: ['unsubmitted'] }))])).toThrow('unknown');
    expect(() => deriveBlindConsensus(entries, questions.map((q) => ({ ...q, class: 'exact-identifier' })), [votes, votes])).toThrow('unbalanced');
  });
});

describe('sampleGoldForJudging', () => {
  const pool: GoldQuery[] = [
    gq('b-2', 'lexical-gap'),
    gq('a-1', 'lexical-gap'),
    gq('c-3', 'lexical-gap'),
    gq('e-1', 'exact-identifier'),
    gq('d-1', 'exact-identifier'),
    gq('h-1', 'hard-negative', { expected: [] }),
    gq('s-1', 'session-start-intent'),
  ];

  it('is deterministic, stratified, id-sorted, and excludes hard negatives', () => {
    const s1 = sampleGoldForJudging(pool, 2);
    const s2 = sampleGoldForJudging(pool, 2);
    expect(s1).toEqual(s2);
    expect(s1.map((q) => q.id)).toEqual(['a-1', 'b-2', 'd-1', 'e-1', 's-1']);
    expect(s1.some((q) => q.class === 'hard-negative')).toBe(false);
  });

  it('caps per class', () => {
    expect(sampleGoldForJudging(pool, 1).map((q) => q.id)).toEqual(['a-1', 'd-1', 's-1']);
  });
});

describe('renderTopHit / synthesizeRun', () => {
  it('renders a hit verbatim and the no-result sentinel', () => {
    const q = gq('x-1', 'lexical-gap');
    const hit: MemoryEntry = { id: 'm1', text: 'the fact body', scope: 'bench' };
    expect(renderTopHit(q, hit)).toContain('the fact body');
    expect(renderTopHit(q, null)).toContain('(no result');
  });

  it('synthesizes a one-turn judgeable RunSummary', () => {
    const run = synthesizeRun(gq('x-1', 'lexical-gap'), 'text', 12, 'judge-model');
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].assistantText).toBe('text');
    expect(run.turns[0].latencyMs).toBe(JUDGED_INSTRUCTION_CONTRACT.turnLatencyMs);
    expect(run.turns[0].costUsd).toBe(JUDGED_INSTRUCTION_CONTRACT.turnCostUsd);
    expect(run.scenarioId).toBe(JUDGED_INSTRUCTION_CONTRACT.scenarioId);
    expect(run.finishReason).toBe('completed');
    expect(run.judgeModel).toBe('judge-model');
  });
});

describe('content-derived judged rubric contract', () => {
  const versionOf = (rubric: unknown, instructions: unknown, scaffold = JUDGE_PROMPT_SCAFFOLD_VERSION) =>
    deriveRubricVersion('memory-usefulness', { rubric, instructions, scaffold });

  it('derives the live version from rubric, caller contract, and testing-shell scaffold', () => {
    expect(JUDGED_TIER_RUBRIC_VERSION).toBe(
      deriveJudgedTierRubricVersion(JUDGE_PROMPT_SCAFFOLD_VERSION),
    );
    expect(MEMORY_USEFULNESS_RUBRIC.version).toBe(JUDGED_TIER_RUBRIC_VERSION);
  });

  it('moves the version when rubric content, instructions, or scaffold changes', () => {
    expect(versionOf(
      { axes: [{ ...MEMORY_USEFULNESS_RUBRIC.axes[0], description: 'changed' }] },
      JUDGED_INSTRUCTION_CONTRACT,
    )).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT),
    );
    expect(versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, {
      ...JUDGED_INSTRUCTION_CONTRACT,
      goalSummary: 'changed',
    })).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT),
    );
    expect(versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT, 'aaaaaaaaaaaa')).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT, 'bbbbbbbbbbbb'),
    );
  });

  it('keeps prompt-visible caller values on the shared contract path', () => {
    const run = synthesizeRun(gq('x-1', 'lexical-gap'), renderTopHit(gq('x-1', 'lexical-gap'), null), 99, 'judge-model');

    expect(run.turns[0].assistantText).toContain('(no result — the store returned nothing)');
    expect(run.turns[0].finishReason).toBe(JUDGED_INSTRUCTION_CONTRACT.turnFinishReason);
    expect(run.totalCostUsd).toBe(JUDGED_INSTRUCTION_CONTRACT.turnCostUsd);
  });
});

describe('aggregateOutcomes', () => {
  const o = (cls: GoldQuery['class'], usefulness: number): JudgedQueryOutcome => ({
    queryId: `q-${cls}-${usefulness}`,
    class: cls,
    query: 'q',
    topResultKey: null,
    topResultExpected: false,
    usefulness,
    searchLatencyMs: 1,
    judgeCostUsd: 0,
  });

  it('computes mean, useful-rate (≥3), and per-class rows', () => {
    const agg = aggregateOutcomes([
      o('lexical-gap', 5),
      o('lexical-gap', 1),
      o('exact-identifier', 3),
    ]);
    expect(agg.meanUsefulness).toBeCloseTo(3);
    expect(agg.usefulRate).toBeCloseTo(2 / 3);
    expect(agg.byClass['lexical-gap']).toEqual({ n: 2, meanUsefulness: 3, usefulRate: 0.5 });
    expect(agg.byClass['exact-identifier']).toEqual({ n: 1, meanUsefulness: 3, usefulRate: 1 });
  });

  it('handles empty input', () => {
    const agg = aggregateOutcomes([]);
    expect(agg.meanUsefulness).toBe(0);
    expect(agg.usefulRate).toBe(0);
  });
});

describe('runJudgedTier (fake llm + in-memory backend)', () => {
  function makeFakeCtx(): { ctx: BackendCtx; entries: MemoryEntry[] } {
    const entries: MemoryEntry[] = [];
    let n = 0;
    const backend: MemoryBackend = {
      name: 'fake-mem',
      available: async () => ({ ok: true }),
      remember: async (text: string, opts: RememberOptions) => {
        const id = `e-${n++}`;
        entries.push({ id, text, scope: opts.scope, metadata: opts.metadata ?? {} });
        return { ids: [id], storedEvents: 1 };
      },
      // Top hit = first seeded entry — plumbing test, not a rank test.
      search: async () => entries.slice(0, 1),
      list: async () => entries,
      get: async () => null,
      forget: async () => {},
      update: async () => {},
    };
    return {
      ctx: {
        backend,
        reinstantiate: () => backend,
        cleanup: async () => {},
        reach: {},
        embeds: false,
        extractionOnRemember: false,
      },
      entries,
    };
  }

  /** Fake judge: returns usefulness 4; records every call's temperature. */
  function makeFakeJudgeLlm(): { llm: LlmCallFn; temps: Array<number | undefined> } {
    const temps: Array<number | undefined> = [];
    const llm: LlmCallFn = async (opts) => {
      temps.push(opts.temperature);
      const json = {
        summary: 'ok',
        scores: { usefulness: 4 },
        findings: [],
        agrees_with_deterministic_asserts: true,
        novel_failures: [],
      };
      return { text: JSON.stringify(json), json, inputTokens: 1, outputTokens: 1, costUsd: 0.001, raw: null };
    };
    return { llm, temps };
  }

  it('seeds, judges the deterministic sample, double-scores, and renders the card', async () => {
    const { ctx, entries } = makeFakeCtx();
    const { llm, temps } = makeFakeJudgeLlm();

    const report = await runJudgedTier({
      llm,
      backends: ['mem0'], // routed to the fake ctx below
      makeCtx: async () => ctx,
      perClass: 2,
      doubleScoreN: 2,
      log: () => {},
    });

    // Seeded the real frozen corpus through the seam.
    expect(entries.length).toBeGreaterThan(50);

    expect(report.judgeModel).toBe(JUDGED_TIER_JUDGE_MODEL);
    expect(report.rubricVersion).toBe(JUDGED_TIER_RUBRIC_VERSION);
    expect(report.sampleSize).toBe(2 * JUDGED_CLASSES.length);
    expect(report.cards).toHaveLength(1);

    const card = report.cards[0];
    expect(card.backend).toBe('fake-mem');
    expect(card.outcomes).toHaveLength(report.sampleSize);
    expect(card.meanUsefulness).toBeCloseTo(4);
    expect(card.usefulRate).toBe(1);
    expect(card.judgeCostUsd).toBeGreaterThan(0);

    // Agreement probe ran with the 0.4-temperature second pass.
    expect(report.doubleScore).toEqual({ n: 2, meanAbsDelta: 0, maxAbsDelta: 0 });
    expect(temps.filter((t) => t === 0.4).length).toBe(2);

    // Markdown carries the comparison row + the agreement line.
    expect(report.markdown).toContain('fake-mem');
    expect(report.markdown).toContain('judge agreement');
    expect(report.excludedClasses).toEqual(['hard-negative']);
  });
});
