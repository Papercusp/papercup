import { describe, expect, it } from 'vitest';
import { orderByDependencies } from './index.js';

/** Build a `dependenciesOf` from a plain adjacency record. */
function deps(graph: Record<string, string[]>) {
  return (n: string) => graph[n] ?? [];
}

/**
 * The invariant the whole lib exists to provide: every dependency of a node
 * appears STRICTLY EARLIER than it, unless the two are in the same cycle group
 * (where no order is more correct than any other).
 *
 * Returns the violations rather than asserting, so the calibration test below
 * can prove this check actually fails on a wrong order — an invariant checker
 * that cannot fail would let every test below pass vacuously.
 */
function violations(
  order: string[],
  graph: Record<string, string[]>,
  groupOf: Map<string, number>,
): string[] {
  const position = new Map(order.map((n, i) => [n, i]));
  const bad: string[] = [];
  for (const node of order) {
    for (const dep of graph[node] ?? []) {
      if (!position.has(dep)) continue; // external
      if (dep === node) continue; // self-edge imposes nothing
      const sameGroup = groupOf.get(dep) === groupOf.get(node);
      if (!sameGroup && position.get(dep)! > position.get(node)!) {
        bad.push(`${node} processed before its dependency ${dep}`);
      }
    }
  }
  return bad;
}

function groupIndex(groups: { nodes: string[] }[]): Map<string, number> {
  const m = new Map<string, number>();
  groups.forEach((g, i) => g.nodes.forEach((n) => m.set(n, i)));
  return m;
}

describe('orderByDependencies', () => {
  it('emits a dependency before the node that depends on it', () => {
    const graph = { a: ['b'], b: ['c'], c: [] };
    const { order } = orderByDependencies({ nodes: ['a', 'b', 'c'], dependenciesOf: deps(graph) });
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('is not fooled by input order — the same graph declared leaves-last still orders leaves first', () => {
    const graph = { a: ['b'], b: ['c'], c: [] };
    const { order } = orderByDependencies({ nodes: ['c', 'b', 'a'], dependenciesOf: deps(graph) });
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('orders a diamond so the shared dependency comes first and the join comes last', () => {
    const graph = { top: ['left', 'right'], left: ['base'], right: ['base'], base: [] };
    const { order, cycles } = orderByDependencies({
      nodes: ['top', 'left', 'right', 'base'],
      dependenciesOf: deps(graph),
    });
    expect(cycles).toEqual([]);
    expect(order[0]).toBe('base');
    expect(order[order.length - 1]).toBe('top');
  });

  it('holds the dependencies-first invariant across a wider mixed graph', () => {
    const graph: Record<string, string[]> = {
      app: ['router', 'store'],
      router: ['util'],
      store: ['util', 'log'],
      util: ['log'],
      log: [],
      orphan: [],
    };
    const nodes = Object.keys(graph);
    const { order, groups } = orderByDependencies({ nodes, dependenciesOf: deps(graph) });
    expect(order).toHaveLength(nodes.length);
    expect(violations(order, graph, groupIndex(groups))).toEqual([]);
  });

  it('CALIBRATION: the invariant check reports violations for a wrong order', () => {
    // Guards the tests above from passing vacuously — if `violations` could not
    // fail, every "no violations" assertion would be worthless.
    const graph: Record<string, string[]> = { app: ['util'], util: ['log'], log: [] };
    const naive = ['app', 'util', 'log']; // plain declaration order — wrong
    const groupOf = new Map(naive.map((n, i) => [n, i]));
    expect(violations(naive, graph, groupOf)).toEqual([
      'app processed before its dependency util',
      'util processed before its dependency log',
    ]);
  });

  describe('cycles', () => {
    it('groups a cycle into one batch instead of throwing', () => {
      const graph = { a: ['b'], b: ['a'] };
      const { groups, cycles, order } = orderByDependencies({
        nodes: ['a', 'b'],
        dependenciesOf: deps(graph),
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].cyclic).toBe(true);
      expect(groups[0].nodes).toEqual(['a', 'b']);
      expect(cycles).toEqual([['a', 'b']]);
      expect(order).toEqual(['a', 'b']);
    });

    it('places a cycle after the dependencies it rests on and before its dependents', () => {
      const graph: Record<string, string[]> = {
        top: ['ring1'],
        ring1: ['ring2', 'base'],
        ring2: ['ring1'],
        base: [],
      };
      const { groups, order } = orderByDependencies({
        nodes: ['top', 'ring1', 'ring2', 'base'],
        dependenciesOf: deps(graph),
      });
      expect(violations(order, graph, groupIndex(groups))).toEqual([]);
      expect(order[0]).toBe('base');
      expect(order[order.length - 1]).toBe('top');
      const ring = groups.find((g) => g.cyclic);
      expect(ring?.nodes).toEqual(['ring1', 'ring2']);
    });

    it('separates two independent cycles into two groups', () => {
      const graph = { a: ['b'], b: ['a'], x: ['y'], y: ['x'] };
      const { cycles } = orderByDependencies({
        nodes: ['a', 'b', 'x', 'y'],
        dependenciesOf: deps(graph),
      });
      expect(cycles).toHaveLength(2);
      expect(cycles.map((c) => c.sort())).toEqual(
        expect.arrayContaining([
          ['a', 'b'],
          ['x', 'y'],
        ]),
      );
    });

    it('ignores a self-dependency rather than reporting a one-node cycle', () => {
      const graph = { solo: ['solo'] };
      const { groups, cycles, order } = orderByDependencies({
        nodes: ['solo'],
        dependenciesOf: deps(graph),
      });
      expect(cycles).toEqual([]);
      expect(groups[0].cyclic).toBe(false);
      expect(order).toEqual(['solo']);
    });
  });

  describe('edges pointing outside the node set', () => {
    it('reports an unknown dependency as external instead of dropping it silently', () => {
      const graph = { app: ['react', 'util'], util: [] };
      const { order, external } = orderByDependencies({
        nodes: ['app', 'util'],
        dependenciesOf: deps(graph),
      });
      expect(external).toEqual(['react']);
      expect(order).toEqual(['util', 'app']);
    });

    it('reports each distinct external dependency once', () => {
      const graph = { a: ['ext'], b: ['ext'] };
      const { external } = orderByDependencies({
        nodes: ['a', 'b'],
        dependenciesOf: deps(graph),
      });
      expect(external).toEqual(['ext']);
    });
  });

  describe('identity', () => {
    it('collapses duplicate nodes to their first occurrence', () => {
      const graph = { a: ['b'], b: [] };
      const { order } = orderByDependencies({
        nodes: ['a', 'b', 'a'],
        dependenciesOf: deps(graph),
      });
      expect(order).toEqual(['b', 'a']);
    });

    it('matches object nodes to object dependencies through `key`', () => {
      interface File {
        path: string;
        imports: string[];
      }
      const files: File[] = [
        { path: 'app.ts', imports: ['util.ts'] },
        { path: 'util.ts', imports: [] },
      ];
      const { order, external } = orderByDependencies({
        nodes: files,
        // A fresh object per edge — only `key` can match it to the node set.
        dependenciesOf: (f) => f.imports.map((path) => ({ path, imports: [] })),
        key: (f) => f.path,
      });
      expect(external).toEqual([]);
      expect(order.map((f) => f.path)).toEqual(['util.ts', 'app.ts']);
    });

    it('without `key`, a reconstructed object dependency reads as external', () => {
      // Documents the sharp edge the `key` doc-comment warns about, so a change
      // in this behaviour is a deliberate decision rather than a silent one.
      const a = { path: 'a' };
      const { external } = orderByDependencies({
        nodes: [a],
        dependenciesOf: () => [{ path: 'a' }],
      });
      expect(external).toHaveLength(1);
    });
  });

  describe('robustness', () => {
    it('handles an empty node set', () => {
      const { order, groups, cycles, external } = orderByDependencies({
        nodes: [],
        dependenciesOf: () => [],
      });
      expect(order).toEqual([]);
      expect(groups).toEqual([]);
      expect(cycles).toEqual([]);
      expect(external).toEqual([]);
    });

    it('walks a 10k-node chain without overflowing the stack', () => {
      // The reason the traversal is iterative. A recursive Tarjan throws
      // RangeError here, far from anything that looks like the cause.
      const size = 10_000;
      const nodes = Array.from({ length: size }, (_, i) => `n${i}`);
      const dependenciesOf = (n: string) => {
        const i = Number(n.slice(1));
        return i + 1 < size ? [`n${i + 1}`] : [];
      };
      const { order, cycles } = orderByDependencies({ nodes, dependenciesOf });
      expect(order).toHaveLength(size);
      expect(cycles).toEqual([]);
      expect(order[0]).toBe(`n${size - 1}`);
      expect(order[size - 1]).toBe('n0');
    });

    it('walks a 10k-node cycle without overflowing the stack', () => {
      const size = 10_000;
      const nodes = Array.from({ length: size }, (_, i) => `n${i}`);
      const dependenciesOf = (n: string) => [`n${(Number(n.slice(1)) + 1) % size}`];
      const { groups, cycles } = orderByDependencies({ nodes, dependenciesOf });
      expect(groups).toHaveLength(1);
      expect(cycles[0]).toHaveLength(size);
    });

    it('is deterministic across repeated runs', () => {
      const graph: Record<string, string[]> = {
        a: ['b', 'c'],
        b: ['d'],
        c: ['d'],
        d: [],
        e: ['a'],
      };
      const nodes = Object.keys(graph);
      const first = orderByDependencies({ nodes, dependenciesOf: deps(graph) }).order;
      const second = orderByDependencies({ nodes, dependenciesOf: deps(graph) }).order;
      expect(second).toEqual(first);
    });
  });
});
