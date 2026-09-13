import { describe, expect, it } from 'vitest';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import type { ScoutLlmCall } from '../scout/types';
import {
  buildWholeCorpusPrompt,
  parseWholeCorpusVerdict,
  planWholeCorpusShards,
  runWholeCorpusPass,
  wholeCorpusCandidateFromCensusItem,
  type WholeCorpusCandidate,
} from './whole-corpus-pass';
import type { AdmissionCensusEdge, AdmissionCensusItem } from '../work-items-admission-census';

function candidate(id: string, title = `title ${id}`, summary = `summary for ${id}`): WholeCorpusCandidate {
  return { id, title, summary };
}

function fakeLlm(payload: { json?: unknown; text?: string } = { json: { merges: [], clusters: [] } }): {
  llmCall: ScoutLlmCall;
  calls: Array<Parameters<ScoutLlmCall>[0]>;
} {
  const calls: Array<Parameters<ScoutLlmCall>[0]> = [];
  const llmCall: ScoutLlmCall = async (input) => {
    calls.push(input);
    input.onAdmitted?.();
    input.onResponseStart?.();
    return {
      text: payload.text ?? '',
      json: payload.json,
      costUsd: 0.12,
      inputTokens: 40_000,
      outputTokens: 512,
    };
  };
  return { llmCall, calls };
}

const ITEMS = [candidate('WI-1'), candidate('WI-2'), candidate('WI-3')];

describe('buildWholeCorpusPrompt', () => {
  it('renders every resolvable item and fences ghost-only context', () => {
    const prompt = buildWholeCorpusPrompt(ITEMS, [candidate('WI-9', 'ghost title')]);

    expect(prompt.system).toContain('MERGES');
    expect(prompt.system).toContain('CLUSTERS');
    expect(prompt.user).toContain('## Resolvable items (3)');
    expect(prompt.user).toContain('id: WI-1');
    expect(prompt.user).toContain('id: WI-2');
    expect(prompt.user).toContain('## Context-only items (1) — DO NOT name these ids in a merge or cluster');
    expect(prompt.user).toContain('id: WI-9');
  });

  it('rejects an empty corpus or a ghost id that collides with a resolvable item', () => {
    expect(() => buildWholeCorpusPrompt([])).toThrow('at least one item');
    expect(() => buildWholeCorpusPrompt(ITEMS, [candidate('WI-1')])).toThrow('duplicates a resolvable item');
  });

  it('truncates an oversized summary to maxSummaryChars', () => {
    const prompt = buildWholeCorpusPrompt([candidate('WI-1', 'title', 'x'.repeat(2000))], [], {
      maxSummaryChars: 50,
    });
    expect(prompt.user).toContain(`summary: ${'x'.repeat(50)}`);
    expect(prompt.user).not.toContain('x'.repeat(51));
  });
});

describe('parseWholeCorpusVerdict', () => {
  const validIds = new Set(['WI-1', 'WI-2', 'WI-3']);

  it('accepts a clean verdict unchanged', () => {
    const result = parseWholeCorpusVerdict(
      {
        merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'same defect' }],
        clusters: [{ label: 'flaky retry', memberIds: ['WI-1', 'WI-3'], suspectedGenerator: 'shared timeout' }],
      },
      validIds,
    );
    expect(result).toEqual({
      ok: true,
      outcome: {
        verdict: {
          merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'same defect' }],
          clusters: [{ label: 'flaky retry', memberIds: ['WI-1', 'WI-3'], suspectedGenerator: 'shared timeout' }],
        },
        droppedUnknownRefs: 0,
        droppedSelfRefs: 0,
        droppedDegenerateMerges: 0,
        droppedDegenerateClusters: 0,
      },
    });
  });

  it('rejects malformed JSON shapes without coercion', () => {
    const result = parseWholeCorpusVerdict({ merges: [], clusters: [], extra: true }, validIds);
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toContain('Unrecognized key');
  });

  it('drops refs to unknown ids and counts them', () => {
    const result = parseWholeCorpusVerdict(
      {
        merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2', 'WI-999'], reason: 'r' }],
        clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-2', 'WI-888'], suspectedGenerator: 'g' }],
      },
      validIds,
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: {
        droppedUnknownRefs: 2,
        verdict: {
          merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'r' }],
          clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g' }],
        },
      },
    });
  });

  it('drops a merge whose canonicalId is unknown entirely (never partially applies it)', () => {
    const result = parseWholeCorpusVerdict(
      { merges: [{ canonicalId: 'WI-999', duplicateIds: ['WI-1'], reason: 'r' }], clusters: [] },
      validIds,
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: { verdict: { merges: [] }, droppedUnknownRefs: 1 },
    });
  });

  it('drops a self-referencing duplicate id and the whole merge if nothing else remains', () => {
    const selfOnly = parseWholeCorpusVerdict(
      { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-1'], reason: 'r' }], clusters: [] },
      validIds,
    );
    expect(selfOnly).toMatchObject({
      ok: true,
      outcome: { verdict: { merges: [] }, droppedSelfRefs: 1, droppedDegenerateMerges: 1 },
    });

    const mixed = parseWholeCorpusVerdict(
      { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-1', 'WI-2'], reason: 'r' }], clusters: [] },
      validIds,
    );
    expect(mixed).toMatchObject({
      ok: true,
      outcome: {
        verdict: { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'r' }] },
        droppedSelfRefs: 1,
        droppedDegenerateMerges: 0,
      },
    });
  });

  it('drops a degenerate cluster left with fewer than 2 unique members', () => {
    const result = parseWholeCorpusVerdict(
      { merges: [], clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-1', 'WI-999'], suspectedGenerator: 'g' }] },
      validIds,
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: { verdict: { clusters: [] }, droppedDegenerateClusters: 1, droppedUnknownRefs: 1 },
    });
  });
});

describe('runWholeCorpusPass', () => {
  it('makes exactly one bounded call and returns a clean empty verdict', async () => {
    const { llmCall, calls } = fakeLlm({ json: { merges: [], clusters: [] } });
    const result = await runWholeCorpusPass({ items: ITEMS, llmCall });

    expect(result).toEqual({
      verdict: 'ok',
      outcome: {
        verdict: { merges: [], clusters: [] },
        droppedUnknownRefs: 0,
        droppedSelfRefs: 0,
        droppedDegenerateMerges: 0,
        droppedDegenerateClusters: 0,
      },
      usage: { model: LEARNING_MODEL_SPEC, costUsd: 0.12, inputTokens: 40_000, outputTokens: 512 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: LEARNING_MODEL_SPEC, responseFormat: 'json', maxTokens: 8_192 });
  });

  it('excludes ghost items from validIds so a ghost ref is dropped as unknown', async () => {
    const { llmCall } = fakeLlm({
      json: { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-9'], reason: 'r' }], clusters: [] },
    });
    const result = await runWholeCorpusPass({ items: ITEMS, ghostItems: [candidate('WI-9')], llmCall });
    expect(result).toMatchObject({ verdict: 'ok', outcome: { verdict: { merges: [] }, droppedUnknownRefs: 1 } });
  });

  it('reports malformed JSON without retrying the model', async () => {
    const { llmCall, calls } = fakeLlm({ text: 'not json', json: undefined });
    const result = await runWholeCorpusPass({ items: ITEMS, llmCall });
    expect(result).toMatchObject({ verdict: 'malformed', error: 'whole-corpus output is not strict JSON' });
    expect(calls).toHaveLength(1);
  });

  it('rejects a non-positive-integer config override before calling the model', async () => {
    const { llmCall, calls } = fakeLlm();
    await expect(runWholeCorpusPass({ items: ITEMS, llmCall, config: { timeoutMs: 0 } })).rejects.toThrow(
      'timeoutMs must be a positive integer',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('wholeCorpusCandidateFromCensusItem', () => {
  it('narrows a census item to id/title/summary', () => {
    const item: AdmissionCensusItem = {
      id: 'WI-1',
      title: 't',
      summary: 's',
      estimatedTokens: 10,
      originClass: 'agent-filed',
      hasEmbedding: false,
      embeddingMode: null,
      embeddingProfile: null,
      titleKey: null,
      conditionKey: null,
    };
    expect(wholeCorpusCandidateFromCensusItem(item)).toEqual({ id: 'WI-1', title: 't', summary: 's' });
  });
});

describe('planWholeCorpusShards', () => {
  it('reuses buildAdmissionShardPlan and covers every corpus member', () => {
    const items: AdmissionCensusItem[] = [
      { id: 'WI-1', title: 'a', summary: '', estimatedTokens: 1000, originClass: 'agent-filed', hasEmbedding: false, embeddingMode: null, embeddingProfile: null, titleKey: null, conditionKey: null },
      { id: 'WI-2', title: 'b', summary: '', estimatedTokens: 1000, originClass: 'agent-filed', hasEmbedding: false, embeddingMode: null, embeddingProfile: null, titleKey: null, conditionKey: null },
    ];
    const edges: AdmissionCensusEdge[] = [];
    const plan = planWholeCorpusShards(items, edges);
    expect(plan.memberRows).toBe(2);
    expect(plan.corpusSize).toBe(2);
  });
});
