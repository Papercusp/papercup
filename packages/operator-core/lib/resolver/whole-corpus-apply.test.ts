import { describe, expect, it } from 'vitest';
import type { ObjectRef } from '@papercusp/coordination/capabilities';
import {
  applyWholeCorpusVerdict,
  clusterKeyFor,
  RESOLVER_CLUSTER_SCHEMA_VERSION,
  type ApplyOutcome,
  type ApplyWholeCorpusDeps,
  type ApplyWorkItemLike,
  type CreateClusterParentOutcome,
} from './whole-corpus-apply';
import type { WholeCorpusVerdict } from './whole-corpus-pass';

function ref(id: string): ObjectRef {
  return { kind: 'feature', ref: id } as ObjectRef;
}

interface FakeDepsState {
  items: Map<string, ApplyWorkItemLike>;
  clusterParents: Map<string, string>; // clusterKey -> parentId
  comments: Array<{ id: string; body: string }>;
  links: Array<{ id: string; dst: string; rel: string }>;
  createdParents: Array<{ title: string; summary: string; clusterKey: string }>;
  nextParentId: number;
  failLinkFor?: Set<string>;
  failMergeFor?: Set<string>;
  failStateFor?: Set<string>;
  failCreateCluster?: boolean;
}

function makeFakeDeps(state: FakeDepsState): ApplyWholeCorpusDeps {
  return {
    getWorkItem: async (id) => state.items.get(id) ?? null,
    resolveWorkItemRef: async (id) => (state.items.has(id) || id.startsWith('CLUSTER-') ? ref(id) : null),
    linkWorkItem: async (id, dst, rel): Promise<ApplyOutcome> => {
      if (state.failLinkFor?.has(id)) return { ok: false, error: `link failed for ${id}` };
      state.links.push({ id, dst: dst.ref, rel });
      return { ok: true };
    },
    setState: async (id, targetState, opts): Promise<ApplyOutcome> => {
      if (state.failStateFor?.has(id)) return { ok: false, error: `state failed for ${id}` };
      const item = state.items.get(id);
      if (item) state.items.set(id, { ...item, state: targetState });
      void opts;
      return { ok: true };
    },
    comment: async (id, body) => {
      state.comments.push({ id, body });
    },
    findExistingClusterParentByKey: async (clusterKey) => state.clusterParents.get(clusterKey) ?? null,
    createClusterParent: async (input): Promise<CreateClusterParentOutcome> => {
      if (state.failCreateCluster) return { ok: false, error: 'create failed' };
      const id = `CLUSTER-${state.nextParentId++}`;
      state.clusterParents.set(input.payload.clusterKey, id);
      state.items.set(id, { id, state: 'open', payload: { resolverCluster: input.payload } });
      state.createdParents.push({ title: input.title, summary: input.summary, clusterKey: input.payload.clusterKey });
      return { ok: true, id };
    },
    mergePayload: async (id, patch): Promise<ApplyOutcome> => {
      if (state.failMergeFor?.has(id)) return { ok: false, error: `merge failed for ${id}` };
      const item = state.items.get(id);
      if (!item) return { ok: false, error: `work-item '${id}' not found` };
      state.items.set(id, { ...item, payload: { ...(item.payload ?? {}), ...patch } });
      return { ok: true };
    },
  };
}

function freshState(itemIds: string[] = []): FakeDepsState {
  const items = new Map<string, ApplyWorkItemLike>();
  for (const id of itemIds) items.set(id, { id, state: 'open' });
  return {
    items,
    clusterParents: new Map(),
    comments: [],
    links: [],
    createdParents: [],
    nextParentId: 1,
  };
}

describe('clusterKeyFor', () => {
  it('is stable regardless of input order and dedupes', () => {
    expect(clusterKeyFor(['WI-2', 'WI-1'])).toBe(clusterKeyFor(['WI-1', 'WI-2']));
    expect(clusterKeyFor(['WI-1', 'WI-2', 'WI-1'])).toBe(clusterKeyFor(['WI-1', 'WI-2']));
  });

  it('rejects fewer than 2 distinct members', () => {
    expect(() => clusterKeyFor(['WI-1'])).toThrow('at least 2 distinct member ids');
    expect(() => clusterKeyFor(['WI-1', 'WI-1'])).toThrow('at least 2 distinct member ids');
  });
});

describe('applyWholeCorpusVerdict — merges', () => {
  it('links duplicates, drops them, and comments, for a normal merge', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'same defect' }],
      clusters: [],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);

    expect(result.merged).toEqual([{ canonicalId: 'WI-1', duplicateId: 'WI-2' }]);
    expect(result.skippedMerges).toEqual([]);
    expect(state.items.get('WI-2')?.state).toBe('dropped');
    expect(state.links).toEqual([{ id: 'WI-2', dst: 'WI-1', rel: 'duplicates' }]);
    expect(state.comments[0]?.id).toBe('WI-2');
    expect(state.comments[0]?.body).toContain('WI-1');
  });

  it('skips (not applies) a merge whose canonical does not exist', async () => {
    const state = freshState(['WI-2']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = { merges: [{ canonicalId: 'WI-999', duplicateIds: ['WI-2'], reason: 'r' }], clusters: [] };
    const result = await applyWholeCorpusVerdict(verdict, deps);

    expect(result.merged).toEqual([]);
    expect(result.skippedMerges).toEqual([{ canonicalId: 'WI-999', duplicateId: 'WI-2', reason: 'canonical-not-found' }]);
    expect(state.links).toEqual([]);
  });

  it('skips a duplicate that no longer exists', async () => {
    const state = freshState(['WI-1']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'r' }], clusters: [] };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.skippedMerges).toEqual([{ canonicalId: 'WI-1', duplicateId: 'WI-2', reason: 'duplicate-not-found' }]);
  });

  it('skips an already-terminal duplicate without re-closing it', async () => {
    const state = freshState(['WI-1']);
    state.items.set('WI-2', { id: 'WI-2', state: 'done' });
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = { merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2'], reason: 'r' }], clusters: [] };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.skippedMerges).toEqual([{ canonicalId: 'WI-1', duplicateId: 'WI-2', reason: 'already-terminal' }]);
    expect(state.items.get('WI-2')?.state).toBe('done');
  });

  it('records a link-failed / state-failed skip without throwing', async () => {
    const state = freshState(['WI-1', 'WI-2', 'WI-3']);
    state.failLinkFor = new Set(['WI-2']);
    state.failStateFor = new Set(['WI-3']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2', 'WI-3'], reason: 'r' }],
      clusters: [],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.skippedMerges).toEqual([
      { canonicalId: 'WI-1', duplicateId: 'WI-2', reason: 'link-failed', detail: 'link failed for WI-2' },
      { canonicalId: 'WI-1', duplicateId: 'WI-3', reason: 'state-failed', detail: 'state failed for WI-3' },
    ]);
    expect(result.merged).toEqual([]);
  });

  it('applies every duplicate independently — one bad duplicate does not block the rest', async () => {
    const state = freshState(['WI-1', 'WI-2', 'WI-3']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [{ canonicalId: 'WI-1', duplicateIds: ['WI-2', 'WI-404', 'WI-3'], reason: 'r' }],
      clusters: [],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.merged).toEqual([
      { canonicalId: 'WI-1', duplicateId: 'WI-2' },
      { canonicalId: 'WI-1', duplicateId: 'WI-3' },
    ]);
    expect(result.skippedMerges).toEqual([{ canonicalId: 'WI-1', duplicateId: 'WI-404', reason: 'duplicate-not-found' }]);
  });
});

describe('applyWholeCorpusVerdict — clusters', () => {
  it('creates a new cluster parent, links every member, and tags the payload', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [{ label: 'flaky retry', memberIds: ['WI-2', 'WI-1'], suspectedGenerator: 'shared timeout' }],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);

    expect(result.clustersCreated).toHaveLength(1);
    const created = result.clustersCreated[0]!;
    expect(created.parentId).toBe('CLUSTER-1');
    expect(created.linkFailures).toEqual([]);
    expect(state.createdParents[0]?.clusterKey).toBe(clusterKeyFor(['WI-1', 'WI-2']));
    expect(state.links).toEqual(
      expect.arrayContaining([
        { id: 'WI-2', dst: 'CLUSTER-1', rel: 'relates' },
        { id: 'WI-1', dst: 'CLUSTER-1', rel: 'relates' },
      ]),
    );
    expect(state.comments).toHaveLength(2);
    expect(state.items.get('CLUSTER-1')?.payload?.clusterPriority).toBe(2);
    expect(state.items.get('WI-1')?.payload?.clusterPriority).toBe(2);
    expect(state.items.get('WI-2')?.payload?.clusterPriority).toBe(2);
  });

  it('is idempotent — the same member set never creates a second parent', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [{ label: 'flaky retry', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'shared timeout' }],
    };
    await applyWholeCorpusVerdict(verdict, deps);
    const second = await applyWholeCorpusVerdict(verdict, deps);

    expect(second.clustersCreated).toEqual([]);
    expect(second.clustersSkipped).toEqual([
      { clusterKey: clusterKeyFor(['WI-1', 'WI-2']), reason: 'already-exists', existingParentId: 'CLUSTER-1' },
    ]);
    expect(state.createdParents).toHaveLength(1);
  });

  it('backfills clusterPriority when the parent predates the P-008 projection', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    const clusterKey = clusterKeyFor(['WI-1', 'WI-2']);
    state.clusterParents.set(clusterKey, 'CLUSTER-OLD');
    state.items.set('CLUSTER-OLD', { id: 'CLUSTER-OLD', state: 'open' });

    const result = await applyWholeCorpusVerdict(
      {
        merges: [],
        clusters: [{ label: 'old cluster', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g' }],
      },
      makeFakeDeps(state),
    );

    expect(result.clustersCreated).toEqual([]);
    expect(result.clustersSkipped).toEqual([{ clusterKey, reason: 'already-exists', existingParentId: 'CLUSTER-OLD' }]);
    expect(state.items.get('CLUSTER-OLD')?.payload?.clusterPriority).toBe(2);
    expect(state.items.get('WI-1')?.payload?.clusterPriority).toBe(2);
    expect(state.items.get('WI-2')?.payload?.clusterPriority).toBe(2);
  });

  it('records create-failed without throwing', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    state.failCreateCluster = true;
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g' }],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.clustersCreated).toEqual([]);
    expect(result.clustersSkipped).toEqual([
      { clusterKey: clusterKeyFor(['WI-1', 'WI-2']), reason: 'create-failed', detail: 'create failed' },
    ]);
  });

  it('records per-member link failures on errors[] but still creates the parent', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    state.failLinkFor = new Set(['WI-2']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g' }],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.clustersCreated).toHaveLength(1);
    expect(result.clustersCreated[0]?.linkFailures).toEqual(['WI-2']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('WI-2');
  });

  it('handles multiple independent clusters in one verdict', async () => {
    const state = freshState(['WI-1', 'WI-2', 'WI-3', 'WI-4']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [
        { label: 'a', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g1' },
        { label: 'b', memberIds: ['WI-3', 'WI-4'], suspectedGenerator: 'g2' },
      ],
    };
    const result = await applyWholeCorpusVerdict(verdict, deps);
    expect(result.clustersCreated).toHaveLength(2);
    expect(new Set(result.clustersCreated.map((c) => c.parentId)).size).toBe(2);
  });

  it('keeps the largest clusterPriority when one item belongs to overlapping clusters', async () => {
    const state = freshState(['WI-1', 'WI-2', 'WI-3', 'WI-4']);
    const deps = makeFakeDeps(state);
    const verdict: WholeCorpusVerdict = {
      merges: [],
      // Larger first is deliberate: a naive last-write-wins merge would lower
      // WI-1 from 4 to 2 on the second cluster.
      clusters: [
        { label: 'large', memberIds: ['WI-1', 'WI-2', 'WI-3', 'WI-4'], suspectedGenerator: 'g1' },
        { label: 'small', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g2' },
      ],
    };
    await applyWholeCorpusVerdict(verdict, deps);
    expect(state.items.get('WI-1')?.payload?.clusterPriority).toBe(4);
    expect(state.items.get('WI-2')?.payload?.clusterPriority).toBe(4);
    expect(state.items.get('CLUSTER-1')?.payload?.clusterPriority).toBe(4);
    expect(state.items.get('CLUSTER-2')?.payload?.clusterPriority).toBe(2);
  });

  it('surfaces a clusterPriority persistence failure without losing the materialized cluster', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    state.failMergeFor = new Set(['WI-2']);
    const result = await applyWholeCorpusVerdict(
      {
        merges: [],
        clusters: [{ label: 'c', memberIds: ['WI-1', 'WI-2'], suspectedGenerator: 'g' }],
      },
      makeFakeDeps(state),
    );
    expect(result.clustersCreated).toHaveLength(1);
    expect(result.errors).toContain('cluster priority: failed to stamp WI-2: merge failed for WI-2');
    expect(state.items.get('WI-1')?.payload?.clusterPriority).toBe(2);
    expect(state.items.get('WI-2')?.payload?.clusterPriority).toBeUndefined();
  });

  it('stamps the resolver-cluster payload marker with schema version and sorted members', async () => {
    const state = freshState(['WI-1', 'WI-2']);
    let capturedPayload: unknown;
    const deps: ApplyWholeCorpusDeps = {
      ...makeFakeDeps(state),
      createClusterParent: async (input) => {
        capturedPayload = input.payload;
        state.items.set('CLUSTER-1', { id: 'CLUSTER-1', state: 'open', payload: { resolverCluster: input.payload } });
        return { ok: true, id: 'CLUSTER-1' };
      },
    };
    const verdict: WholeCorpusVerdict = {
      merges: [],
      clusters: [{ label: 'c', memberIds: ['WI-2', 'WI-1'], suspectedGenerator: 'g' }],
    };
    await applyWholeCorpusVerdict(verdict, deps);
    expect(capturedPayload).toEqual({
      schemaVersion: RESOLVER_CLUSTER_SCHEMA_VERSION,
      clusterKey: clusterKeyFor(['WI-1', 'WI-2']),
      label: 'c',
      suspectedGenerator: 'g',
      memberIds: ['WI-1', 'WI-2'],
    });
  });
});
