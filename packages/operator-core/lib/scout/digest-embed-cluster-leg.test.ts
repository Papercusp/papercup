/**
 * Tests for the P-018(b) flag-gated embedding-cluster experiment leg
 * (su-ideate-learning-substrate-2026-07-10). Two halves:
 *   - the PURE `clusterByCosine` (greedy cosine ≥ threshold → {signature,ids});
 *   - the flag-gated `clusterFrictionByEmbedding`: the money case (a re-worded
 *     friction pair the lexical findLikelyDuplicates MISSES is caught by cosine),
 *     plus the fail-open contract (flag-off / VITEST-inert / disabled /
 *     dims-mismatch / wrong-width all degrade to null → the lexical control).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dedupSignature, findLikelyDuplicates, type DupCluster } from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import {
  clusterByCosine,
  clusterFrictionByEmbedding,
  digestEmbedClusterEnabled,
  type DigestEmbedClusterDeps,
} from './digest-embed-cluster-leg';

const DIM = 384;

/** A friction candidate — only id + title are read by the leg; cast past the rest. */
function mk(id: string, title: string): ImprovementCandidate {
  return { id, title, state: 'open' } as unknown as ImprovementCandidate;
}

/** A DIM-wide unit vector along one axis: same `topic` ⇒ cosine 1, distinct ⇒ cosine 0. */
function vecFor(topic: number): number[] {
  const v = new Array(DIM).fill(0);
  v[topic % DIM] = 1;
  return v;
}

/** Injected embedder deps mapping title → topic axis (so the test owns every cosine). */
function makeDeps(opts: {
  topicByTitle?: Record<string, number>;
  dims?: number;
  mode?: string;
  disabled?: boolean;
  embedLen?: number;
}): DigestEmbedClusterDeps & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (title: string) => {
    if (opts.embedLen != null) return new Array(opts.embedLen).fill(0.01);
    const topic = opts.topicByTitle?.[title] ?? 999;
    return vecFor(topic);
  });
  const resolveEmbedder = async () =>
    opts.disabled
      ? ({ mode: 'disabled' as const, reason: 'test' })
      : { mode: opts.mode ?? 'gemma', dims: opts.dims ?? DIM, embed };
  return { resolveEmbedder, embed };
}

const FLAG = 'PAPERCUSP_SU_DIGEST_EMBED_CLUSTER';
const prevFlag = process.env[FLAG];
function enable(): void {
  process.env[FLAG] = 'on';
}
afterEach(() => {
  if (prevFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prevFlag;
  delete process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD;
});

describe('clusterByCosine — pure greedy cosine clustering', () => {
  it('clusters vectors at/above threshold and leaves the orthogonal one out', () => {
    const cands = [mk('a', 'alpha'), mk('b', 'beta'), mk('c', 'gamma')];
    const vecs = [vecFor(0), vecFor(0), vecFor(1)]; // a,b parallel; c orthogonal
    const clusters = clusterByCosine(cands, vecs, 0.85);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toEqual(['a', 'b']);
    expect(clusters[0].signature).toBe(dedupSignature('alpha'));
  });

  it('does not cluster a pair whose cosine is below threshold', () => {
    const cands = [mk('a', 'alpha'), mk('b', 'beta')];
    // cosine of these two = 0.5 (normalized) — below 0.85.
    const vecs = [
      [1, 1, ...new Array(DIM - 2).fill(0)],
      [1, 0, ...new Array(DIM - 2).fill(0)],
    ];
    expect(clusterByCosine(cands, vecs, 0.85)).toEqual([]);
  });
});

describe('clusterFrictionByEmbedding — the experiment (flag-gated, fail-open)', () => {
  // Two captures of ONE friction, worded with ~zero shared tokens — the lexical
  // blind spot the embedding leg exists to close.
  const reworded = [
    mk('wi:1', 'cache the corpus digest between scout passes'),
    mk('wi:2', 'memoize state-of-hive rollups so cycles stop recomputing them'),
    mk('wi:3', 'quantum flux capacitor teleport'),
  ];

  it('catches a re-worded friction pair the LEXICAL findLikelyDuplicates misses', async () => {
    // Control: lexical clustering finds nothing (no token overlap between wi:1/wi:2).
    expect(findLikelyDuplicates(reworded).filter((c) => c.ids.length > 1)).toEqual([]);

    // Experiment: same topic axis for the pair, orthogonal for the third → one cluster.
    enable();
    const deps = makeDeps({ topicByTitle: { [reworded[0].title]: 0, [reworded[1].title]: 0, [reworded[2].title]: 1 } });
    const clusters = await clusterFrictionByEmbedding(reworded, deps);
    expect(clusters).not.toBeNull();
    expect(clusters).toHaveLength(1);
    expect(clusters![0].ids).toEqual(['wi:1', 'wi:2']);
    expect(clusters![0].signature).toBe(dedupSignature(reworded[0].title));
  });

  it('is deterministic — same candidates + embeddings ⇒ identical clusters', async () => {
    enable();
    const mkDeps = () =>
      makeDeps({ topicByTitle: { [reworded[0].title]: 0, [reworded[1].title]: 0, [reworded[2].title]: 1 } });
    const a = await clusterFrictionByEmbedding(reworded, mkDeps());
    const b = await clusterFrictionByEmbedding(reworded, mkDeps());
    expect(a).toEqual(b);
  });

  it('honors an env threshold override (raise it above the pair cosine ⇒ no cluster)', async () => {
    enable();
    process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD = '0.99';
    // wi:1 = [1,0,…]; wi:2 = [0.8,0.6,…] ⇒ cosine 0.8, clearly below the raised 0.99
    // bar, so the otherwise-clustering pair now stays apart. wi:3 orthogonal.
    const deps: DigestEmbedClusterDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: DIM,
        embed: async (t: string) =>
          t === reworded[0].title
            ? vecFor(0)
            : t === reworded[1].title
              ? [0.8, 0.6, ...new Array(DIM - 2).fill(0)]
              : vecFor(5),
      }),
    };
    expect(await clusterFrictionByEmbedding(reworded, deps)).toEqual([]);
  });

  it('fail-opens to null when the flag is OFF (the default control path)', async () => {
    // no enable() — flag stays off
    expect(digestEmbedClusterEnabled()).toBe(false);
    const deps = makeDeps({ topicByTitle: { [reworded[0].title]: 0, [reworded[1].title]: 0 } });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toBeNull();
  });

  it('is VITEST-inert (null) when the flag is on but no deps are injected', async () => {
    enable();
    expect(await clusterFrictionByEmbedding(reworded)).toBeNull();
  });

  it('fail-opens to null when the embedder is disabled', async () => {
    enable();
    expect(await clusterFrictionByEmbedding(reworded, makeDeps({ disabled: true }))).toBeNull();
  });

  it('fail-opens to null on a dims mismatch (harrier@1024 ≠ vector(384))', async () => {
    enable();
    const deps = makeDeps({ dims: 1024, topicByTitle: { [reworded[0].title]: 0, [reworded[1].title]: 0 } });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toBeNull();
    expect(deps.embed).not.toHaveBeenCalled(); // rejected before embedding
  });

  it('fail-opens to null when the embedder returns a wrong-width vector', async () => {
    enable();
    const deps = makeDeps({ embedLen: 10, topicByTitle: { [reworded[0].title]: 0 } });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toBeNull();
  });

  it('fail-opens to null on too few candidates (nothing to cluster)', async () => {
    enable();
    const deps = makeDeps({ topicByTitle: { [reworded[0].title]: 0 } });
    expect(await clusterFrictionByEmbedding([reworded[0]], deps)).toBeNull();
  });
});
