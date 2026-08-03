/**
 * dependency-graph.property.test.ts — the acyclicity guard, over RANDOM graphs.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-010).
 * @covers INV-08
 *
 * WHY RANDOM SHAPES. Every other test of this guard picks its graph by hand, and a
 * hand-picked graph is picked by someone who already has a theory of where the bug
 * would be. The escapes this plan exists to prevent were all in shapes nobody thought
 * to draw — EI-9108 was a seven-deep chain, a depth no fixture in the repo had. So the
 * subject here is not "does the guard reject a cycle" (the hand-written cases in
 * dbos/work-item-deps-store.test.ts prove that) but "does it hold over graphs nobody
 * chose", including diamonds, wide fan-in, deep chains and disconnected components.
 *
 * WHAT MAKES THIS NOT A TAUTOLOGY — the trap this plan keeps re-finding. A property
 * test that GENERATES a graph from its own model of the rule and then checks it against
 * that same model proves only that the model agrees with itself; it stays green with the
 * production guard deleted. The defence here is that the ORACLE is independent of the
 * SUBJECT and formulated differently:
 *
 *   subject  `wouldCreateCycle`  — production, detects a CYCLE
 *   oracle   `reaches()` below   — this file, computes REACHABILITY by DFS
 *
 * They are different questions ("is there a loop" vs "can m get to k"), related by a
 * proof rather than by shared code: adding `k depends on m` closes a loop exactly when
 * m already reaches k. If the guard's traversal is wrong, the two disagree. `reaches`
 * deliberately imports nothing from the subsystem — the moment it did, this file would
 * be worthless.
 *
 * EDGE DIRECTION, stated once because it is easy to invert. The map is
 * blocked → [blockers]: `m.get(X)` lists what X WAITS ON. So a cycle is a loop in the
 * waits-on relation, and generating a DAG in topological order (node i may wait only on
 * nodes j < i) makes acyclicity structural rather than asserted.
 *
 * Unit tier: `wouldCreateCycle` is pure, so this opens no connection and spawns nothing.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/scheduler/dependency-graph.property.test.ts
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { wouldCreateCycle } from '../dbos/work-item-deps-store';

/** Node i's id. The guard is string-keyed; the generators think in indices. */
const nodeId = (i: number) => `WI-${i}`;

/** A generated DAG: `blockers[i]` are the indices node i waits on, all < i. */
type Dag = readonly (readonly number[])[];

/**
 * DAGs in topological order: node i may wait only on nodes with a strictly smaller
 * index. Acyclicity is therefore a property of the CONSTRUCTION, not something this
 * file asserts — which is what lets a violation be attributed to the guard.
 *
 * Sizes stay small (≤9) on purpose: cycle bugs are shape bugs, not scale bugs, and a
 * small graph shrinks to a readable counterexample. Depth is what mattered historically,
 * and a 9-node chain is deeper than anything in the hand-written corpus.
 */
const dagArb: fc.Arbitrary<Dag> = fc
  .integer({ min: 2, max: 9 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.subarray(Array.from({ length: i }, (_, j) => j)),
      ),
    ),
  );

/** A DAG paired with one of its node indices. */
const dagAndNodeArb = dagArb.chain((dag) =>
  fc.tuple(fc.constant(dag), fc.integer({ min: 0, max: dag.length - 1 })),
);

function toMap(dag: Dag): ReadonlyMap<string, readonly string[]> {
  return new Map(dag.map((bs, i) => [nodeId(i), bs.map(nodeId)]));
}

/**
 * THE INDEPENDENT ORACLE. Can `from` reach `target` by following waits-on edges?
 *
 * A plain iterative DFS over the generated arrays. It knows nothing about the guard, the
 * store, or the ref vocabulary — deliberately, since its whole value is being a second
 * implementation. Note it starts at `from`'s blockers, so `reaches(d, k, k)` is true only
 * for a node genuinely on a loop, not merely by starting where it ends.
 */
function reaches(dag: Dag, from: number, target: number): boolean {
  const seen = new Set<number>();
  const stack = [...dag[from]!];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n === target) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...dag[n]!);
  }
  return false;
}

/** Every node that transitively waits on `target` — i.e. every id that would close a loop. */
const dependantsOf = (dag: Dag, target: number): number[] =>
  dag.map((_, i) => i).filter((i) => i !== target && reaches(dag, i, target));

describe('acyclicity guard over random DAGs (P-010) — @covers INV-08', () => {
  it('never reports a cycle for a graph that has none, at any shape or depth', () => {
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        // Re-asserting a node's EXISTING blockers is the commonest real write (an
        // idempotent re-sync). It must stay a no-op however deep the graph.
        expect(wouldCreateCycle(toMap(dag), nodeId(k), dag[k]!.map(nodeId))).toBe(false);
      }),
    );
  });

  it('accepts ANY set of topological predecessors — the guard is not merely order-blind', () => {
    fc.assert(
      fc.property(
        dagAndNodeArb.chain(([dag, k]) =>
          fc.tuple(
            fc.constant(dag),
            fc.constant(k),
            // Any subset of strictly-lower-indexed nodes is cycle-free by construction,
            // whether or not those edges are currently present.
            fc.subarray(Array.from({ length: k }, (_, j) => j)),
          ),
        ),
        ([dag, k, newBlockers]) => {
          expect(wouldCreateCycle(toMap(dag), nodeId(k), newBlockers.map(nodeId))).toBe(false);
        },
      ),
    );
  });

  it('reports a cycle for EVERY blocker that already depends on the target', () => {
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        const closers = dependantsOf(dag, k);
        // Vacuous unless something actually depends on k. `fc.pre` discards rather than
        // passes, so a run with no dependant is not counted as evidence — a silent
        // `return true` here would let an all-empty sample look like a green property.
        fc.pre(closers.length > 0);
        for (const m of closers) {
          expect(
            wouldCreateCycle(toMap(dag), nodeId(k), [...dag[k]!.map(nodeId), nodeId(m)]),
            `adding ${nodeId(k)} -> ${nodeId(m)} must be refused: ${nodeId(m)} already reaches it`,
          ).toBe(true);
        }
      }),
    );
  });

  it('agrees with reachability EXACTLY — no false accept and no false reject', () => {
    // The sharpest form: rather than checking the two classes separately, assert the
    // guard's verdict IS the oracle's verdict for every candidate blocker in the graph.
    // A guard that simply answered `true` more often would pass the previous case and
    // fail this one.
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        const map = toMap(dag);
        for (let m = 0; m < dag.length; m++) {
          if (m === k) continue;
          expect(
            wouldCreateCycle(map, nodeId(k), [nodeId(m)]),
            `${nodeId(k)} waiting on ${nodeId(m)}`,
          ).toBe(reaches(dag, m, k));
        }
      }),
    );
  });

  it('drops a self-edge instead of calling it a cycle', () => {
    // A self-edge is a legitimate no-op the callers rely on (workItemBlockingEdge returns
    // null for one). Reporting it as a cycle would turn a quiet skip into a refused write.
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        expect(wouldCreateCycle(toMap(dag), nodeId(k), [nodeId(k)])).toBe(false);
      }),
    );
  });

  it('rejects at EDGE granularity: dropping the offending blockers accepts the rest (D-012)', () => {
    // D-012's actual obligation, and the half that row-shape reasoning misses. It is not
    // enough to refuse a bad set; the SAFE members of that same set must still be
    // writable, or one bad edge silently drops a whole promotion.
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        const closers = dependantsOf(dag, k);
        fc.pre(closers.length > 0);

        const safe = Array.from({ length: k }, (_, j) => j);
        const mixed = [...safe, ...closers];
        const map = toMap(dag);

        // The mixed set is refused...
        expect(wouldCreateCycle(map, nodeId(k), mixed.map(nodeId))).toBe(true);
        // ...and the same set with ONLY the offenders removed is accepted. Note this is
        // the full safe remainder, not some minimal subset: the guard must not be
        // over-broad about what it takes down with the bad edge.
        expect(wouldCreateCycle(map, nodeId(k), safe.map(nodeId))).toBe(false);
      }),
    );
  });
});

describe('NEGATIVE CONTROLS — the properties above can actually fail (P-010, D-019/D-020)', () => {
  // Every property in this file passed on its first run. That is the moment this plan's
  // whole premise says to be suspicious: a test asserted only against a CORRECT subject
  // returns green whether or not it binds anything, which is indistinguishable from
  // working. The honest way to settle it is not to mutate the production guard for
  // thirty seconds and revert — on this shared tree git-sync would happily commit the
  // broken intermediate — but to keep two deliberately wrong guards HERE, permanently,
  // and assert the properties catch them. That stays true for every future reader.
  //
  // `fc.check` returns the verdict instead of throwing, so a FAILURE is the assertion.

  type Guard = (
    current: ReadonlyMap<string, readonly string[]>,
    blocked: string,
    newBlockers: readonly string[],
  ) => boolean;

  /** The regression that matters most: a guard that never refuses anything. */
  const neverRefuses: Guard = () => false;
  /** The opposite failure — over-broad rejection, which breaks D-012's edge granularity. */
  const alwaysRefuses: Guard = () => true;

  /** The exact-agreement property, parameterised over the guard under test. */
  const agreementProperty = (guard: Guard) =>
    fc.property(dagAndNodeArb, ([dag, k]) => {
      const map = toMap(dag);
      for (let m = 0; m < dag.length; m++) {
        if (m === k) continue;
        if (guard(map, nodeId(k), [nodeId(m)]) !== reaches(dag, m, k)) return false;
      }
      return true;
    });

  it('a guard that NEVER reports a cycle is caught', () => {
    expect(fc.check(agreementProperty(neverRefuses)).failed).toBe(true);
  });

  it('a guard that ALWAYS reports a cycle is caught', () => {
    expect(fc.check(agreementProperty(alwaysRefuses)).failed).toBe(true);
  });

  it('and the real guard passes that same property — so the control is calibrated', () => {
    // Without this line the two assertions above would also pass if `agreementProperty`
    // were simply broken and failed against everything.
    expect(fc.check(agreementProperty(wouldCreateCycle)).failed).toBe(false);
  });
});

describe('the generators are honest (P-010)', () => {
  // A property suite is only as good as its inputs, and a generator that silently
  // produced trivial graphs would make every property above vacuously true while
  // looking exactly like a green suite. These are the negative controls FOR THE TESTS.

  it('produces graphs with real depth, not just isolated nodes', () => {
    // Depth = the longest waits-on chain. Asserted as a REACHABLE property over the
    // sample rather than per-run: any single run may legitimately be shallow.
    let deepest = 0;
    fc.assert(
      fc.property(dagArb, (dag) => {
        const depth = (i: number): number =>
          dag[i]!.length === 0 ? 1 : 1 + Math.max(...dag[i]!.map(depth));
        deepest = Math.max(deepest, ...dag.map((_, i) => depth(i)));
        return true;
      }),
      { numRuns: 300 },
    );
    // 4+ is past the shape hand-written fixtures reach; EI-9108's escape was at 7.
    expect(deepest).toBeGreaterThanOrEqual(4);
  });

  it('produces graphs where something actually depends on something else', () => {
    // If `dependantsOf` were always empty, the two `fc.pre` properties above would
    // discard every run and report success having asserted nothing.
    let sawDependant = false;
    fc.assert(
      fc.property(dagAndNodeArb, ([dag, k]) => {
        if (dependantsOf(dag, k).length > 0) sawDependant = true;
        return true;
      }),
      { numRuns: 300 },
    );
    expect(sawDependant).toBe(true);
  });
});
