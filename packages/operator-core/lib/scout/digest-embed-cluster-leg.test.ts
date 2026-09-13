/**
 * Tests for the P-018(b) flag-gated embedding-cluster experiment leg
 * (su-ideate-learning-substrate-2026-07-10). Two halves:
 *   - the PURE `clusterByCosine` (greedy cosine ≥ threshold → {signature,ids});
 *   - the flag-gated `clusterFrictionByEmbedding`: the money case (a re-worded
 *     friction pair the lexical findLikelyDuplicates MISSES is caught by cosine),
 *     plus the fail-open contract (flag-off / VITEST-inert / disabled /
 *     dims-mismatch / wrong-width / no-stored-vector all degrade to null or a
 *     per-row skip → the lexical control).
 *
 * WI-4183/EI-9694: the leg now REUSES stored migration-551 vectors join-wise
 * (queryStoredVectors) instead of calling .embed() per title — these tests inject
 * `queryStoredVectors` directly rather than mocking an `embed` function.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

import { dedupSignature, findLikelyDuplicates, type DupCluster } from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import {
  clusterByCosine,
  clusterFrictionByEmbedding,
  digestEmbedClusterEnabled,
  type DigestEmbedClusterDeps,
} from './digest-embed-cluster-leg';
import { PROSE_VECTOR_DIMS } from '../search/prose-vector-dims';

// The prose column width, imported not restated: a width change must move this
// fixture automatically rather than stranding it (the 384→768 strand).
const DIM = PROSE_VECTOR_DIMS;

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

/** Injected deps: a fixed resolved mode/dims + a stored-vector map keyed by candidate id
 *  (mirrors the real join: an id absent from `vectorsById` has no stored vector). */
function makeDeps(opts: {
  vectorsById?: Record<string, number[]>;
  dims?: number;
  mode?: string;
  disabled?: boolean;
}): DigestEmbedClusterDeps & { queryStoredVectors: ReturnType<typeof vi.fn> } {
  const queryStoredVectors = vi.fn(async (_mode: string, ids: string[]) => {
    const m = new Map<string, number[]>();
    for (const id of ids) {
      const v = opts.vectorsById?.[id];
      if (v) m.set(id, v);
    }
    return m;
  });
  const resolveEmbedder = async () =>
    opts.disabled
      ? ({ mode: 'disabled' as const, reason: 'test' })
      : {
          mode: opts.mode ?? 'gemma',
          dims: opts.dims ?? DIM,
          profile: opts.mode === 'openai' ? EMBEDDER_DIM_SPECS.openai : EMBEDDER_DIM_SPECS.gemma,
          embed: vi.fn(),
        };
  return { resolveEmbedder, queryStoredVectors };
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
    const deps = makeDeps({
      vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0), 'wi:3': vecFor(1) },
    });
    const clusters = await clusterFrictionByEmbedding(reworded, deps);
    expect(clusters).not.toBeNull();
    expect(clusters).toHaveLength(1);
    expect(clusters![0].ids).toEqual(['wi:1', 'wi:2']);
    expect(clusters![0].signature).toBe(dedupSignature(reworded[0].title));
  });

  it('queries stored vectors under the CURRENT resolved mode, not a hardcoded one', async () => {
    enable();
    const deps = makeDeps({
      mode: 'harrier-ish-but-384', // any string; the leg passes resolved.mode through verbatim
      vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0), 'wi:3': vecFor(1) },
    });
    await clusterFrictionByEmbedding(reworded, deps);
    expect(deps.queryStoredVectors).toHaveBeenCalledWith(
      'harrier-ish-but-384',
      ['wi:1', 'wi:2', 'wi:3'],
      expect.objectContaining({
        profileId: EMBEDDER_DIM_SPECS.gemma.profileId,
        legacyMode: null,
      }),
    );
  });

  it('is deterministic — same candidates + stored vectors ⇒ identical clusters', async () => {
    enable();
    const mkDeps = () =>
      makeDeps({ vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0), 'wi:3': vecFor(1) } });
    const a = await clusterFrictionByEmbedding(reworded, mkDeps());
    const b = await clusterFrictionByEmbedding(reworded, mkDeps());
    expect(a).toEqual(b);
  });

  it('honors an env threshold override (raise it above the pair cosine ⇒ no cluster)', async () => {
    enable();
    process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD = '0.99';
    // wi:1 = [1,0,…]; wi:2 = [0.8,0.6,…] ⇒ cosine 0.8, clearly below the raised 0.99
    // bar, so the otherwise-clustering pair now stays apart. wi:3 orthogonal.
    const deps = makeDeps({
      vectorsById: {
        'wi:1': vecFor(0),
        'wi:2': [0.8, 0.6, ...new Array(DIM - 2).fill(0)],
        'wi:3': vecFor(5),
      },
    });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toEqual([]);
  });

  it('defaults the threshold to 0.92 (raised post-EI-9693) when no override is set', async () => {
    enable();
    // cosine ~0.894 (angle 26.57°) between wi:1/wi:2 — above the OLD 0.85 default,
    // below the NEW 0.92 default.
    const deps = makeDeps({
      vectorsById: {
        'wi:1': [1, 0, ...new Array(DIM - 2).fill(0)],
        'wi:2': [0.894, 0.447, ...new Array(DIM - 2).fill(0)],
        'wi:3': vecFor(5),
      },
    });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toEqual([]);
  });

  it('fail-opens to null when the flag is OFF (the default control path)', async () => {
    // no enable() — flag stays off
    expect(digestEmbedClusterEnabled()).toBe(false);
    const deps = makeDeps({ vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0) } });
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
    const deps = makeDeps({ dims: 1024, vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0) } });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toBeNull();
    expect(deps.queryStoredVectors).not.toHaveBeenCalled(); // rejected before the join
  });

  it('excludes a candidate whose vector has the wrong width instead of failing the whole leg', async () => {
    enable();
    const deps = makeDeps({
      vectorsById: {
        'wi:1': vecFor(0),
        'wi:2': new Array(10).fill(0.01), // wrong width — must not blow up the cosine pass
        'wi:3': vecFor(1),
      },
    });
    // wi:2 is excluded (wrong width); only wi:1/wi:3 remain, orthogonal ⇒ no cluster.
    expect(await clusterFrictionByEmbedding(reworded, deps)).toEqual([]);
  });

  it('fail-opens to null when fewer than 2 candidates have a usable stored vector', async () => {
    enable();
    // Only wi:1 has backfilled; wi:2/wi:3 haven't — not enough to cluster.
    const deps = makeDeps({ vectorsById: { 'wi:1': vecFor(0) } });
    expect(await clusterFrictionByEmbedding(reworded, deps)).toBeNull();
  });

  it('skips a not-yet-backfilled candidate (per-row fail-open) rather than forfeiting the leg', async () => {
    enable();
    // wi:3 has no stored vector at all (never backfilled) — wi:1/wi:2 still cluster.
    const deps = makeDeps({ vectorsById: { 'wi:1': vecFor(0), 'wi:2': vecFor(0) } });
    const clusters = await clusterFrictionByEmbedding(reworded, deps);
    expect(clusters).toEqual([{ signature: dedupSignature(reworded[0].title), ids: ['wi:1', 'wi:2'] }]);
  });

  it('fail-opens to null on too few candidates (nothing to cluster)', async () => {
    enable();
    const deps = makeDeps({ vectorsById: { 'wi:1': vecFor(0) } });
    expect(await clusterFrictionByEmbedding([reworded[0]], deps)).toBeNull();
  });
});
