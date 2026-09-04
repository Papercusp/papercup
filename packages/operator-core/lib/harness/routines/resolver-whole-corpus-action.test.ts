import { describe, expect, it, vi } from 'vitest';
import type { ScoutLlmCall } from '../../scout/types';
import type { AdmissionCensusItem } from '../../work-items-admission-census';
import type { ApplyWholeCorpusDeps } from '../../resolver/whole-corpus-apply';

const CENSUS: AdmissionCensusItem[] = [
  {
    id: 'WI-1',
    title: 'first title',
    summary: 'first summary',
    estimatedTokens: 100,
    originClass: 'agent-filed',
    hasEmbedding: false,
    embeddingMode: null,
    titleKey: null,
    conditionKey: null,
  },
  {
    id: 'WI-2',
    title: 'second title',
    summary: 'second summary',
    estimatedTokens: 100,
    originClass: 'agent-filed',
    hasEmbedding: false,
    embeddingMode: null,
    titleKey: null,
    conditionKey: null,
  },
  {
    id: 'WI-3',
    title: 'third title',
    summary: 'third summary',
    estimatedTokens: 100,
    originClass: 'agent-filed',
    hasEmbedding: false,
    embeddingMode: null,
    titleKey: null,
    conditionKey: null,
  },
];

const readCorpus = vi.fn(async () => CENSUS);
vi.mock('../../work-items-admission-census', async (orig) => ({
  ...(await orig<typeof import('../../work-items-admission-census')>()),
  readCorpus: (...args: unknown[]) => readCorpus(...(args as Parameters<typeof readCorpus>)),
}));

import {
  makeResolverWholeCorpusAction,
  readDedupEdges,
  runResolverWholeCorpusPass,
  type RunResolverWholeCorpusPassResult,
} from './resolver-whole-corpus-action';

/** Minimal tagged-template stub: records every statement, answers by shape. */
function fakeSql(): { tag: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>; statements: string[] } {
  const statements: string[] = [];
  const tag = (async (strings: TemplateStringsArray, ..._vals: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    statements.push(text.trim());
    return [];
  }) as unknown as (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
  return { tag, statements };
}

function fakeLlm(payload: { json?: unknown; text?: string } = { json: { merges: [], clusters: [] } }): {
  llmCall: ScoutLlmCall;
  calls: Array<Parameters<ScoutLlmCall>[0]>;
} {
  const calls: Array<Parameters<ScoutLlmCall>[0]> = [];
  const llmCall: ScoutLlmCall = async (input) => {
    calls.push(input);
    return { text: payload.text ?? '', json: payload.json, costUsd: 0.05, inputTokens: 500, outputTokens: 40 };
  };
  return { llmCall, calls };
}

function fakeApplyDeps(): { deps: ApplyWholeCorpusDeps; calls: { linked: unknown[]; stated: unknown[]; commented: unknown[] } } {
  const calls = { linked: [] as unknown[], stated: [] as unknown[], commented: [] as unknown[] };
  const deps: ApplyWholeCorpusDeps = {
    getWorkItem: async (id) => ({ id, state: 'open' }),
    resolveWorkItemRef: async (id) => ({ kind: 'feature', ref: id }),
    linkWorkItem: async (id, dst, rel) => {
      calls.linked.push({ id, dst, rel });
      return { ok: true };
    },
    setState: async (id, state, opts) => {
      calls.stated.push({ id, state, opts });
      return { ok: true };
    },
    comment: async (id, body) => {
      calls.commented.push({ id, body });
    },
    findExistingClusterParentByKey: async () => null,
    createClusterParent: async (input) => ({ ok: true, id: `cluster-${input.payload.clusterKey}` }),
    mergePayload: async () => ({ ok: true }),
  };
  return { deps, calls };
}

describe('readDedupEdges', () => {
  it('returns [] without querying when ids is empty', async () => {
    const { tag, statements } = fakeSql();
    const edges = await readDedupEdges(tag as never, { workspaceId: 'ws', harnessSlug: 'h' }, []);
    expect(edges).toEqual([]);
    expect(statements).toHaveLength(0);
  });

  it('maps dedup_edges rows into cosine AdmissionCensusEdge shape', async () => {
    const tag = (async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (/dedup_edges/.test(text)) return [{ a: 'WI-1', b: 'WI-2', cos: 0.91, trgm: 0.7 }];
      return [];
    }) as unknown as Parameters<typeof readDedupEdges>[0];
    const edges = await readDedupEdges(tag, { workspaceId: 'ws', harnessSlug: 'h' }, ['WI-1', 'WI-2']);
    expect(edges).toEqual([{ a: 'WI-1', b: 'WI-2', similarity: 0.91, trgm: 0.7, source: 'cosine' }]);
  });
});

describe('runResolverWholeCorpusPass', () => {
  it('runs one shard through the whole-corpus pass and applies a merge verdict', async () => {
    const { tag } = fakeSql();
    const { llmCall, calls } = fakeLlm({ json: { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'same defect' }], clusters: [] } });
    const { deps, calls: applyCalls } = fakeApplyDeps();

    const result: RunResolverWholeCorpusPassResult = await runResolverWholeCorpusPass({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'resolver-whole-corpus-test-1',
      sql: tag as never,
      llmCall,
      applyDeps: deps,
      now: () => 1_000,
    });

    expect(result).toEqual({
      runId: 'resolver-whole-corpus-test-1',
      corpusSize: 3,
      shardCount: 1,
      merges: 1,
      clusters: 0,
      droppedUnknownRefs: 0,
      errors: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]?.content).toContain('WI-1');
    expect(applyCalls.linked).toEqual([{ id: 'WI-2', dst: { kind: 'feature', ref: 'WI-1' }, rel: 'duplicates' }]);
    expect(applyCalls.stated).toEqual([{ id: 'WI-2', state: 'dropped', opts: { completionRef: 'WI-1' } }]);
  });

  it('records a malformed shard result as an error without throwing', async () => {
    const { tag } = fakeSql();
    const { llmCall } = fakeLlm({ text: 'not json' });
    const { deps } = fakeApplyDeps();

    const result = await runResolverWholeCorpusPass({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'resolver-whole-corpus-test-2',
      sql: tag as never,
      llmCall,
      applyDeps: deps,
      now: () => 2_000,
    });

    expect(result.merges).toBe(0);
    expect(result.clusters).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('shard 0');
  });

  it('writes the running row then a completed row to admission_runs, and fails closed on a thrown error', async () => {
    const statements: string[] = [];
    const tag = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      // Interpolated values (incl. the JSON detail blob) live in `vals`, not
      // in the literal template pieces — join both so a substring search
      // over `statements` can see the detail.status this test asserts on.
      const text = strings.join('?') + ' ||| ' + vals.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' | ');
      statements.push(text.trim());
      return [];
    }) as unknown as Parameters<typeof runResolverWholeCorpusPass>[0]['sql'];
    const { llmCall } = fakeLlm();
    const { deps } = fakeApplyDeps();

    await runResolverWholeCorpusPass({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      runId: 'resolver-whole-corpus-test-3',
      sql: tag,
      llmCall,
      applyDeps: deps,
      now: () => 3_000,
    });

    expect(statements.some((s) => /INSERT INTO harness_shared.admission_runs/.test(s))).toBe(true);
    expect(statements.some((s) => /UPDATE harness_shared.admission_runs/.test(s) && /status.:.complete/.test(s))).toBe(
      true,
    );

    readCorpus.mockRejectedValueOnce(new Error('boom'));
    const failStatements: string[] = [];
    const failTag = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join('?') + ' ||| ' + vals.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' | ');
      failStatements.push(text.trim());
      return [];
    }) as unknown as Parameters<typeof runResolverWholeCorpusPass>[0]['sql'];
    await expect(
      runResolverWholeCorpusPass({
        workspaceId: 'ws',
        harnessSlug: 'papercusp',
        runId: 'resolver-whole-corpus-test-4',
        sql: failTag,
        llmCall,
        applyDeps: deps,
        now: () => 4_000,
      }),
    ).rejects.toThrow('boom');
    expect(failStatements.some((s) => /status.:.failed/.test(s) && /boom/.test(s))).toBe(true);
  });
});

describe('makeResolverWholeCorpusAction', () => {
  it('runs the injected pass and logs a one-line summary', async () => {
    const run = vi.fn(async () => ({
      runId: 'r-1',
      corpusSize: 12,
      shardCount: 1,
      merges: 2,
      clusters: 1,
      droppedUnknownRefs: 0,
      errors: [] as string[],
    }));
    const log = vi.fn();
    const action = makeResolverWholeCorpusAction({ run, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('corpus=12 shards=1 merges=2 clusters=1 errors=0'));
  });
});
