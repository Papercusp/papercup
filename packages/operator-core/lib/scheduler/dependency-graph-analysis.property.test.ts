/**
 * Independent-oracle properties for dependency-graph-analysis.
 *
 * The subject uses Tarjan SCCs plus reverse propagation. The oracle below uses
 * a Floyd-Warshall transitive closure plus plain breadth-first walks; it imports
 * no helper from the analyser, so agreement is evidence rather than a tautology.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { analyzeDependencyGraph, type DependencyReachability } from './dependency-graph-analysis';

interface GraphCase {
  n: number;
  edges: Array<readonly [number, number]>; // blocked -> blocker
  terminal: boolean[];
  roots: DependencyReachability[];
}

const nodeRef = (index: number) => `N-${index}`;

const graphCaseArb: fc.Arbitrary<GraphCase> = fc.integer({ min: 1, max: 7 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    edges: fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), {
      maxLength: n * n,
      selector: ([blocked, blocker]) => `${blocked}:${blocker}`,
    }),
    terminal: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    roots: fc.array(fc.constantFrom<DependencyReachability>('reachable', 'unknown', 'impossible'), {
      minLength: n,
      maxLength: n,
    }),
  }),
);

function transitiveClosure(c: GraphCase): boolean[][] {
  const reach = Array.from({ length: c.n }, () => Array.from({ length: c.n }, () => false));
  for (const [blocked, blocker] of c.edges) reach[blocked]![blocker] = true;
  for (let k = 0; k < c.n; k++) {
    for (let i = 0; i < c.n; i++) {
      if (!reach[i]![k]) continue;
      for (let j = 0; j < c.n; j++) reach[i]![j] = reach[i]![j] || reach[k]![j];
    }
  }
  return reach;
}

/** Cyclic SCCs as sorted member-index strings, independently derived from closure. */
function oracleSccs(c: GraphCase): string[] {
  const reach = transitiveClosure(c);
  const unseen = new Set(Array.from({ length: c.n }, (_, index) => index));
  const out: string[] = [];
  while (unseen.size > 0) {
    const first = Math.min(...unseen);
    const members = [...unseen].filter((candidate) => reach[first]![candidate] && reach[candidate]![first]);
    if (members.length === 0) {
      unseen.delete(first);
      continue;
    }
    for (const member of members) unseen.delete(member);
    if (members.length > 1 || reach[first]![first]) out.push(members.sort((a, b) => a - b).join(','));
  }
  return out.sort();
}

function reverseClosure(c: GraphCase, seeds: readonly number[]): Set<number> {
  const dependants = Array.from({ length: c.n }, () => new Set<number>());
  for (const [blocked, blocker] of c.edges) dependants[blocker]!.add(blocked);
  const seen = new Set<number>();
  const queue = [...seeds].filter((index) => !c.terminal[index]);
  for (const seed of queue) seen.add(seed);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependant of dependants[current]!) {
      if (c.terminal[dependant] || seen.has(dependant)) continue;
      seen.add(dependant);
      queue.push(dependant);
    }
  }
  return seen;
}

function oracleVerdicts(c: GraphCase): DependencyReachability[] {
  // Structural SCC reporting retains historical edges through terminal nodes,
  // but settlement removes those nodes from the active unsatisfiable-cycle view.
  const activeReach = transitiveClosure({
    ...c,
    edges: c.edges.filter(([blocked, blocker]) => !c.terminal[blocked] && !c.terminal[blocker]),
  });
  const cyclicSeeds = Array.from({ length: c.n }, (_, index) => index).filter(
    (index) => !c.terminal[index] && activeReach[index]![index],
  );
  const impossibleSeeds = [
    ...cyclicSeeds,
    ...Array.from({ length: c.n }, (_, index) => index).filter(
      (index) => !c.terminal[index] && c.roots[index] === 'impossible',
    ),
  ];
  const unknownSeeds = Array.from({ length: c.n }, (_, index) => index).filter(
    (index) => !c.terminal[index] && c.roots[index] === 'unknown',
  );
  const impossible = reverseClosure(c, impossibleSeeds);
  const unknown = reverseClosure(c, unknownSeeds);
  return Array.from({ length: c.n }, (_, index): DependencyReachability => {
    if (c.terminal[index]) return 'reachable';
    if (impossible.has(index)) return 'impossible';
    if (unknown.has(index)) return 'unknown';
    return 'reachable';
  });
}

function runSubject(c: GraphCase): ReturnType<typeof analyzeDependencyGraph> {
  return analyzeDependencyGraph({
    nodes: Array.from({ length: c.n }, (_, index) => ({
      id: { kind: 'feature', ref: nodeRef(index) },
      terminal: c.terminal[index],
      rootVerdict: c.roots[index],
    })),
    edges: c.edges.map(([blocked, blocker]) => ({
      blocked: { kind: 'feature', ref: nodeRef(blocked) },
      blocker: { kind: 'feature', ref: nodeRef(blocker) },
    })),
  });
}

describe('typed dependency analyser over random graphs', () => {
  it('agrees with the independent SCC oracle', () => {
    fc.assert(
      fc.property(graphCaseArb, (c) => {
        const actual = runSubject(c)
          .stronglyConnectedComponents.map((component) =>
            component.members
              .map((member) => Number(member.ref.slice(2)))
              .sort((a, b) => a - b)
              .join(','),
          )
          .sort();
        expect(actual).toEqual(oracleSccs(c));
      }),
      { numRuns: 500 },
    );
  });

  it('agrees exactly with the independent tri-state/reverse-closure oracle', () => {
    fc.assert(
      fc.property(graphCaseArb, (c) => {
        const actual = runSubject(c).verdicts.map((row) => row.verdict);
        expect(actual).toEqual(oracleVerdicts(c));
      }),
      { numRuns: 750 },
    );
  });

  it('returns a real closed edge path for every reported SCC', () => {
    fc.assert(
      fc.property(graphCaseArb, (c) => {
        const edgeSet = new Set(c.edges.map(([blocked, blocker]) => `${blocked}:${blocker}`));
        for (const component of runSubject(c).stronglyConnectedComponents) {
          const path = component.cyclePath.map((member) => Number(member.ref.slice(2)));
          expect(path.length).toBeGreaterThanOrEqual(2);
          expect(path[0]).toBe(path.at(-1));
          for (let i = 0; i < path.length - 1; i++) {
            expect(edgeSet.has(`${path[i]}:${path[i + 1]}`)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is invariant to node and edge ordering', () => {
    fc.assert(
      fc.property(graphCaseArb, (c) => {
        const forward = runSubject(c);
        const reversed = analyzeDependencyGraph({
          nodes: Array.from({ length: c.n }, (_, index) => ({
            id: { kind: 'feature', ref: nodeRef(index) },
            terminal: c.terminal[index],
            rootVerdict: c.roots[index],
          })).reverse(),
          edges: c.edges
            .map(([blocked, blocker]) => ({
              blocked: { kind: 'feature', ref: nodeRef(blocked) },
              blocker: { kind: 'feature', ref: nodeRef(blocker) },
            }))
            .reverse(),
        });
        expect(reversed).toEqual(forward);
      }),
      { numRuns: 300 },
    );
  });
});

describe('independent-oracle calibration', () => {
  type VerdictSubject = (c: GraphCase) => DependencyReachability[];
  const agrees = (subject: VerdictSubject) =>
    fc.property(graphCaseArb, (c) => {
      const expected = oracleVerdicts(c);
      const actual = subject(c);
      return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    });

  it('rejects a fake analyser that calls every node reachable', () => {
    const verdict = fc.check(
      agrees((c) => Array.from({ length: c.n }, () => 'reachable')),
      { numRuns: 300 },
    );
    expect(verdict.failed).toBe(true);
  });

  it('accepts the real analyser under that same agreement property', () => {
    const verdict = fc.check(
      agrees((c) => runSubject(c).verdicts.map((row) => row.verdict)),
      { numRuns: 300 },
    );
    expect(verdict.failed).toBe(false);
  });
});
