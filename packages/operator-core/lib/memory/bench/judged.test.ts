/**
 * T3 judged-usefulness tier — pure parts + fake-LLM integration
 * (memory-backend-benchmark P-008). No real LLM, no PG: the llm seam
 * gets a fake judge, the backend context an in-memory store.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { candidateSourcePartition } from './candidate-hybrid-bench';
import { hashJson } from './measurement-manifest';

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
  collectIndependentCohort,
  parseBlindChunkVotes,
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

describe('blind label collection through the injected stateless transport', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-cohort-test-'));
    const seed = 'blind-test';
    const sourceFor = (partition: 'calibration' | 'test') => {
      for (let i = 0; i < 1000; i++) if (candidateSourcePartition(`session:s${i}`, seed) === partition) return `s${i}`;
      throw new Error('test source not found');
    };
    const entries = ['calibration', 'test'].map((partition) => {
      const sourceSession = sourceFor(partition as 'calibration' | 'test');
      return { key: sourceSession, text: `frozen source ${sourceSession}`, kind: 'fact', metadata: {
        cluster: `session:${sourceSession}`, sourceSession, sourceAttribution: 'session', partition,
      } };
    });
    const snapshot = path.join(root, 'snapshot.json');
    fs.writeFileSync(snapshot, JSON.stringify({ formatVersion: 1, seed, snapshotAt: '2026-01-01T00:00:00.000Z',
      suites: { memory: { entries }, prose: { entries } } }));
    let calls = 0;
    const llm: LlmCallFn = async (opts) => {
      calls++; expect(opts.ownerId).toBeTruthy(); expect(opts.model).toBe(BLIND_COHORT_CONTRACT.model);
      const input = JSON.parse(opts.messages[0].content);
      const json = input.questions ? { votes: input.questions.map((q: { index: number; query: string }) => ({
        q: q.index, d: q.query.endsWith('hard-negative') ? []
          : input.sources.filter((s: { index: number; text: string }) => q.query.includes(`target=${s.text.split(' ').at(-1)};`)).map((s: { index: number }) => s.index),
        a: false,
      })) } : { queries: ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'].map((cls) => ({
        class: cls, query: `target=${input.sources[0].key}; fixture question ${cls}`,
      })) };
      return { text: JSON.stringify(json), json, inputTokens: 1, outputTokens: 1, costUsd: 0, raw: null };
    };
    return { root, snapshot, llm, get calls() { return calls; } };
  }
  it('retains separate raw calls, labels from full-chunk consensus and exact-input recovery guards', async () => {
    const f = fixture(), { root, snapshot, llm } = f;
    try {
      const out = path.join(root, 'run');
      const receipt = await collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 });
      expect(f.calls).toBe(8);
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      const proofs = JSON.parse(fs.readFileSync(receipt.judgments.path, 'utf8'));
      expect(labels.memory).toHaveLength(8); expect(labels.prose).toHaveLength(8);
      expect(proofs.memory.agreement).toBe(1);
      expect(new Set(proofs.memory.judges.map((j: { transport: string }) => j.transport)).size).toBe(2);
      await expect(collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('already finished');
      fs.unlinkSync(receipt.judgments.path);
      const rawFile = fs.readdirSync(out).find((name) => name.startsWith('memory-author-'))!;
      const raw = JSON.parse(fs.readFileSync(path.join(out, rawFile), 'utf8'));
      raw.messages[0].content = 'altered provenance'; fs.writeFileSync(path.join(out, rawFile), JSON.stringify(raw));
      await expect(collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('invalid recovered');
      expect(f.calls).toBe(8);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  async function authorOnly(f: ReturnType<typeof fixture>) {
    const out = path.join(f.root, 'original');
    const llm: LlmCallFn = async (opts) => {
      if (JSON.parse(opts.messages[0].content).questions) throw new Error('fixture judge interruption');
      return f.llm(opts);
    };
    await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('fixture judge interruption');
    return out;
  }
  it('recovers authors by reference, preserves original invocation IDs and makes fresh independent judge calls', async () => {
    const f = fixture();
    try {
      const original = await authorOnly(f), out = path.join(f.root, 'new-attempt');
      // An old judge/source revision must not invalidate unchanged author prompts.
      const identityFile = path.join(original, 'identity.json'), donor = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      donor.identity.contract.judge = 'legacy string-key judge';
      donor.identity.sourceFingerprint.sha256 = '1'.repeat(64);
      donor.identityHash = hashJson(donor.identity); fs.writeFileSync(identityFile, JSON.stringify(donor));
      for (const name of fs.readdirSync(original).filter((s) => s.startsWith('memory-author-'))) {
        const file = path.join(original, name), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.identityHash = donor.identityHash; fs.writeFileSync(file, JSON.stringify(raw));
      }
      fs.writeFileSync(path.join(original, 'memory-judge-1-0.json'), JSON.stringify({ invalidLegacyJudge: true }));
      const originals = fs.readdirSync(original).filter((name) => name.startsWith('memory-author-')).map((name) => ({
        name, bytes: fs.readFileSync(path.join(original, name)),
      }));
      const originalIds = originals.map(({ bytes }) => JSON.parse(bytes.toString()).invocationId).sort();
      let newCalls = 0;
      const llm: LlmCallFn = async (opts) => { newCalls++; return f.llm(opts); };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1, reuseAuthorsFrom: original });
      expect(newCalls).toBe(6); // two prose authors + four fresh judge passes
      expect(f.calls).toBe(8);
      for (const { name, bytes } of originals) {
        expect(fs.readFileSync(path.join(original, name))).toEqual(bytes);
        const ref = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
        expect(ref.kind).toBe('reused-author'); expect(ref.result).toBeUndefined();
        expect(ref.origin.path).toBe(path.join(original, name));
      }
      const authors = JSON.parse(fs.readFileSync(path.join(out, 'memory-authors.json'), 'utf8'));
      expect(authors.calls.map((c: { invocationId: string }) => c.invocationId).sort()).toEqual(originalIds);
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: original, llm, reuseAuthorsFrom: original })).rejects.toThrow('new output');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['messages', 'model', 'promptSha256', 'identityHash', 'finishedAt', 'stopReason'])('refuses altered recovered author %s before any new transport', async (field) => {
    const f = fixture();
    try {
      const original = await authorOnly(f), name = fs.readdirSync(original).find((s) => s.startsWith('memory-author-'))!;
      const file = path.join(original, name), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (field === 'messages') raw.messages[0].content = 'altered prompt';
      else if (field === 'stopReason') raw.result.stopReason = 'max_tokens';
      else raw[field] = field === 'finishedAt' ? '' : 'altered';
      fs.writeFileSync(file, JSON.stringify(raw));
      let calls = 0;
      const llm: LlmCallFn = async (opts) => { calls++; return f.llm(opts); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'new'), llm, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('invalid recovered');
      expect(calls).toBe(0);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('revalidates an original raw fingerprint when resuming an existing author reference', async () => {
    const f = fixture();
    try {
      const original = await authorOnly(f), out = path.join(f.root, 'new');
      const paused: LlmCallFn = async () => { throw new Error('fixture new judge interruption'); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: paused, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('fixture new judge interruption');
      const name = fs.readdirSync(original).find((s) => s.startsWith('memory-author-'))!;
      fs.appendFileSync(path.join(original, name), '\n');
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: paused, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('invalid authors-only raw reference');
      expect(f.calls).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['ownerId', 'snapshot', 'model', 'author'])('refuses a mismatched recovery identity %s', async (field) => {
    const f = fixture();
    try {
      const original = await authorOnly(f), file = path.join(original, 'identity.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (field === 'ownerId') saved.identity.ownerId = 'other-owner';
      else if (field === 'snapshot') saved.identity.snapshotFingerprint.sha256 = '0'.repeat(64);
      else saved.identity.contract[field] = 'changed contract';
      saved.identityHash = hashJson(saved.identity); fs.writeFileSync(file, JSON.stringify(saved));
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'new'), llm: f.llm, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('recovery identity');
      expect(f.calls).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('retains an invalid numeric response and refuses labels before consensus', async () => {
    const f = fixture();
    try {
      const out = path.join(f.root, 'invalid');
      const llm: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        if (!JSON.parse(opts.messages[0].content).questions) return result;
        const json = JSON.parse(result.text); json.votes[0].d = [999];
        return { ...result, json, text: JSON.stringify(json) };
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('document index 999 outside');
      expect(fs.existsSync(path.join(out, 'memory-judge-1-0.json'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'labels.json'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'judgments.json'))).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('blind numeric response validation', () => {
  const questions = [{ id: 'question-a' }, { id: 'question-b' }], chunk = [{ key: 'source-a' }, { key: 'source-b' }];
  const votes = [{ q: 0, d: [1], a: false }, { q: 1, d: [], a: false }];
  it('maps reordered numeric votes through submitted references only', () => {
    expect(parseBlindChunkVotes({ votes: [...votes].reverse() }, questions, chunk)).toEqual([
      { queryId: 'question-b', relevantKeys: [], ambiguous: false, note: '' },
      { queryId: 'question-a', relevantKeys: ['source-b'], ambiguous: false, note: '' },
    ]);
  });
  it.each([
    ['missing', [votes[0]], 'missing question indices 1'],
    ['duplicate question', [votes[0], votes[0]], 'duplicate question index 0'],
    ['unknown question', [votes[0], { ...votes[1], q: 2 }], 'question index 2 outside'],
    ['unknown document', [{ ...votes[0], d: [2] }, votes[1]], 'document index 2 outside'],
    ['duplicate document', [{ ...votes[0], d: [1, 1] }, votes[1]], 'duplicate document index'],
    ['string question', [{ ...votes[0], q: '0' }, votes[1]], 'invalid blind numeric response'],
    ['negative document', [{ ...votes[0], d: [-1] }, votes[1]], 'invalid blind numeric response'],
    ['fractional document', [{ ...votes[0], d: [0.5] }, votes[1]], 'invalid blind numeric response'],
    ['legacy source key', [{ ...votes[0], relevantKeys: ['unsubmitted'] }, votes[1]], 'invalid blind numeric response'],
  ])('rejects %s without guessing a reference', (_name, rows, error) => {
    expect(() => parseBlindChunkVotes({ votes: rows }, questions, chunk)).toThrow(error);
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
