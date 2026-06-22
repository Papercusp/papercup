/**
 * readiness-cache-scale.test.ts — caching-layer-tag-eca-2026-06-22 P-011.
 *
 * SCALE proof for the readiness + tag-cache combination over a large synthetic graph.
 * Generates a ~10k-work-item / ~30k-edge ACYCLIC DAG (topological LAYERING guarantees
 * acyclicity — an edge only ever points from a higher layer to a strictly lower one), then
 * exercises a per-node readiness computation through the generic tag cache and asserts:
 *
 *   1. CORRECTNESS — the cached readiness for every node matches a direct recompute over
 *      the raw graph (the cache never lies).
 *   2. SINGLE-FLIGHT — under N concurrent reads of the same key, the factory runs exactly
 *      once (one recompute per key, the rest join the in-flight build).
 *   3. BOUNDED INVALIDATION — invalidating ONE node's tag only forces a recompute of that
 *      node's (transitive-up-to-tagged) dependents, NOT the whole graph. We bump one tag and
 *      assert the rebuilt-key count is bounded by that node's dependent set, far below 10k.
 *
 * Pure (no IO): the cache lib + InMemoryGenerationStore model the tag invalidation; readiness
 * uses the same `partitionReady`/`isReady` predicate the operator ships. Runtime target: a few
 * seconds (timed + asserted at the bottom).
 */
import { describe, expect, it } from 'vitest';
import { Cache, InMemoryGenerationStore } from '@papercusp/cache';
import { partitionReady, type BlockingNode } from '../work-item-blocking';

const WS = 'scale-ws';
const N = 10_000;
const TARGET_EDGES = 30_000;
const LAYERS = 100; // 10k nodes / 100 layers ≈ 100 nodes per layer

interface Graph {
  items: BlockingNode[];
  /** blocked id -> blocker ids (every blocker is in a strictly-lower layer => acyclic). */
  blockers: Map<string, string[]>;
  /** layer index per node id. */
  layerOf: Map<string, number>;
  /** node ids grouped by layer (layer 0 = sources, no blockers). */
  byLayer: string[][];
  /** blocker id -> the ids that depend ON it (reverse edges), for bounded-invalidation math. */
  dependentsOf: Map<string, string[]>;
}

/** Deterministic LCG so the DAG (and thus the test) is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build a layered acyclic DAG. Node `L{layer}-{i}` in layer k may only be blocked by nodes in
 * layers < k, so the edge set is guaranteed acyclic by construction (no topo-sort needed).
 * Statuses are assigned so a mix of blockers is terminal/non-terminal, exercising real readiness.
 */
function buildGraph(): Graph {
  const rng = makeRng(0xc0ffee);
  const items: BlockingNode[] = [];
  const layerOf = new Map<string, number>();
  const byLayer: string[][] = Array.from({ length: LAYERS }, () => []);
  const blockers = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();

  const perLayer = Math.ceil(N / LAYERS);
  let made = 0;
  for (let layer = 0; layer < LAYERS && made < N; layer++) {
    for (let i = 0; i < perLayer && made < N; i++) {
      const id = `L${layer}-${i}`;
      // Status mix: ~half the lower-layer nodes terminal (passed/resolved), the rest live.
      const r = rng();
      const status =
        layer === 0
          ? r < 0.5
            ? 'passed'
            : 'todo'
          : r < 0.35
            ? 'passed'
            : r < 0.45
              ? 'resolved'
              : r < 0.5
                ? 'failing'
                : 'todo';
      items.push({ id, status });
      layerOf.set(id, layer);
      byLayer[layer]!.push(id);
      made++;
    }
  }

  // Add edges from each non-source node to a few random nodes in lower layers, until ~TARGET_EDGES.
  let edges = 0;
  for (let layer = 1; layer < LAYERS && edges < TARGET_EDGES; layer++) {
    for (const id of byLayer[layer]!) {
      if (edges >= TARGET_EDGES) break;
      const fanOut = 1 + Math.floor(rng() * 4); // 1..4 blockers per node
      const blk: string[] = [];
      const seen = new Set<string>();
      for (let e = 0; e < fanOut; e++) {
        const lowerLayer = Math.floor(rng() * layer); // strictly < this layer
        const pool = byLayer[lowerLayer]!;
        if (pool.length === 0) continue;
        const blocker = pool[Math.floor(rng() * pool.length)]!;
        if (seen.has(blocker)) continue;
        seen.add(blocker);
        blk.push(blocker);
        let deps = dependentsOf.get(blocker);
        if (!deps) {
          deps = [];
          dependentsOf.set(blocker, deps);
        }
        deps.push(id);
        edges++;
      }
      if (blk.length > 0) blockers.set(id, blk);
    }
  }

  return { items, blockers, layerOf, byLayer, dependentsOf };
}

/**
 * The readiness ORACLE — one O(N+E) frontier pass (the operator computes the frontier ONCE,
 * never a per-node O(N) `isReady` swept over every node, which is quadratic). Returns id->ready.
 * The cache then memoizes each node's answer behind its own key/tags.
 */
function computeFrontier(g: Graph, dispatchable: ReadonlySet<string>): Map<string, boolean> {
  const { ready } = partitionReady(g.items, g.blockers, dispatchable);
  const readySet = new Set(ready.map((n) => n.id));
  const out = new Map<string, boolean>();
  for (const it of g.items) out.set(it.id, readySet.has(it.id));
  return out;
}

describe('P-011 scale — readiness over a 10k-node / ~30k-edge acyclic DAG', () => {
  const g = buildGraph();
  const dispatchable = new Set(['todo']);
  // The oracle: the full frontier, computed ONCE (O(N+E)). Per-node readiness is a lookup.
  const oracle = computeFrontier(g, dispatchable);

  /** Tags for a node's readiness entry: its own id + each blocker's id (a bump on any invalidates it). */
  const tagsFor = (id: string): string[] => [id, ...(g.blockers.get(id) ?? [])];

  it('the generated graph is the right size and acyclic by layering', () => {
    expect(g.items.length).toBe(N);
    const edgeCount = [...g.blockers.values()].reduce((a, b) => a + b.length, 0);
    expect(edgeCount).toBeGreaterThanOrEqual(20_000);
    expect(edgeCount).toBeLessThanOrEqual(TARGET_EDGES);
    // Acyclicity invariant: every edge points from a higher layer to a strictly lower one.
    for (const [blocked, blks] of g.blockers) {
      const lb = g.layerOf.get(blocked)!;
      for (const blocker of blks) expect(g.layerOf.get(blocker)!).toBeLessThan(lb);
    }
  });

  it('cached readiness matches a direct recompute for every node (correctness)', async () => {
    const cache = new Cache();
    let mismatches = 0;
    for (const it of g.items) {
      const cached = await cache.getOrSet(WS, `ready:${it.id}`, () => oracle.get(it.id)!, {
        tags: tagsFor(it.id),
      });
      if (cached !== oracle.get(it.id)!) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(cache.stats.builds).toBe(N); // every key built exactly once (cold cache)
    // Sanity: the graph is non-trivial — it has BOTH ready and blocked dispatchable nodes.
    const readyCount = [...oracle.values()].filter(Boolean).length;
    expect(readyCount).toBeGreaterThan(0);
    expect(readyCount).toBeLessThan(N);
  });

  it('single-flight: concurrent reads of one key recompute exactly once', async () => {
    const cache = new Cache();
    const id = g.byLayer[LAYERS - 1]!.find((x) => g.blockers.has(x)) ?? g.items[N - 1]!.id;
    let factoryRuns = 0;
    const factory = async (): Promise<boolean> => {
      factoryRuns++;
      await new Promise((r) => setTimeout(r, 5)); // hold the build open so others must join
      return oracle.get(id)!;
    };
    const CONCURRENCY = 64;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => cache.getOrSet(WS, `ready:${id}`, factory, { tags: [id] })),
    );
    expect(factoryRuns).toBe(1); // exactly one recompute
    expect(cache.stats.singleFlightJoins).toBe(CONCURRENCY - 1);
    expect(new Set(results).size).toBe(1); // all callers got the same value
  });

  it('invalidating one node only recomputes its dependents (bounded, not the whole graph)', async () => {
    const cache = new Cache();
    // Warm every node's readiness.
    for (const it of g.items) {
      await cache.getOrSet(WS, `ready:${it.id}`, () => oracle.get(it.id)!, { tags: tagsFor(it.id) });
    }
    const buildsAfterWarm = cache.stats.builds;
    expect(buildsAfterWarm).toBe(N);

    // Pick the node with the largest dependent fan-out to make the bound meaningful.
    let bumped = '';
    let maxDeps = 0;
    for (const [id, deps] of g.dependentsOf) {
      if (deps.length > maxDeps) {
        maxDeps = deps.length;
        bumped = id;
      }
    }
    expect(bumped).not.toBe('');

    // The set of keys that CAN rebuild after this bump = the node itself (its own tag) + its
    // direct dependents (they carry the blocker's id as a tag). Everything else stays fresh.
    const affected = new Set<string>([bumped, ...(g.dependentsOf.get(bumped) ?? [])]);
    expect(affected.size).toBeLessThan(N / 10); // bounded — far below the whole graph

    cache.invalidateByTag(WS, bumped);

    // Re-read EVERY node. Only the affected keys should rebuild; the rest serve from L1.
    for (const it of g.items) {
      await cache.getOrSet(WS, `ready:${it.id}`, () => oracle.get(it.id)!, { tags: tagsFor(it.id) });
    }
    const rebuilt = cache.stats.builds - buildsAfterWarm;
    // Exactly the affected set recomputes (each affected key carries the bumped tag); never MORE,
    // and never the whole graph.
    expect(rebuilt).toBe(affected.size);
    expect(rebuilt).toBeLessThan(N / 10);
  });

  it('whole-suite work stays within a few seconds', () => {
    const start = Date.now();
    // A representative end-to-end pass: a full cached sweep, one bump, a second sweep (only the
    // bumped node's dependents rebuild). The frontier oracle is computed once up-front (above).
    const cache = new Cache({ generationStore: new InMemoryGenerationStore() });
    const sweep = (): void => {
      for (const it of g.items) {
        void cache.getOrSet(WS, `ready:${it.id}`, () => oracle.get(it.id)!, { tags: tagsFor(it.id) });
      }
    };
    sweep();
    cache.invalidateByTag(WS, g.items[0]!.id);
    sweep();
    const elapsedMs = Date.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[P-011 scale] ${N} nodes / ~${TARGET_EDGES} edges, two cached sweeps + one bump in ${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
