/**
 * dep-graph-model.test.ts — the pure core of the dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-005 / P-007 / P-013).
 *
 * These are the assertions that decide what a user actually sees, so they are written against
 * BEHAVIOUR (which nodes survive, what is reported hidden) rather than against internals.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDepSubgraph,
  computeDepths,
  isBlockerSatisfied,
  DEP_GRAPH_NODE_BUDGET,
  type DepGraphItem,
  type DepGraphEdgeInput,
} from './dep-graph-model';

const item = (id: string, over: Partial<DepGraphItem> = {}): DepGraphItem => ({
  id,
  kind: 'feature',
  title: `title ${id}`,
  state: 'open',
  ...over,
});

const edge = (blockedId: string, blockerId: string | null, over: Partial<DepGraphEdgeInput> = {}): DepGraphEdgeInput => ({
  blockedId,
  blockerId,
  blockerRef: blockerId ?? 'MISSING',
  blockerStatus: null,
  ...over,
});

describe('isBlockerSatisfied — terminality is PER FAMILY', () => {
  // The two vocabularies genuinely differ, and collapsing them is a mistake already made once
  // in this subsystem (D-019): `closed` is terminal for an issue and NOT for a feature.
  it.each([
    ['feature', 'passed', true],
    ['feature', 'deprecated', true],
    ['feature', 'done', true],
    ['feature', 'dropped', true],
    ['feature', 'closed', false],
    ['feature', 'resolved', false],
    ['bug', 'resolved', true],
    ['bug', 'closed', true],
    ['bug', 'done', true],
    ['bug', 'dropped', true],
    ['bug', 'passed', false],
    ['bug', 'deprecated', false],
  ])('%s blocker at %s → satisfied=%s', (kind, status, expected) => {
    expect(isBlockerSatisfied(kind, status)).toBe(expected);
  });

  it('treats a missing status as NOT satisfied — absence is not terminality', () => {
    expect(isBlockerSatisfied('feature', null)).toBe(false);
  });
});

describe('computeDepths', () => {
  it('measures the LONGEST chain, not the shortest', () => {
    // C is reachable from A directly (1 hop) and via B (2 hops). Depth must be 2 — the point
    // is "how buried is this", and the shortest path would under-report exactly the deep
    // chains this pane exists to surface.
    const depths = computeDepths(['A', 'B', 'C'], [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'A', target: 'C' },
    ]);
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
    expect(depths.get('C')).toBe(2);
  });

  it('handles the seven-deep chain that motivated the pane (EI-9108)', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `N${i}`);
    const edges = ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
    expect(computeDepths(ids, edges).get('N7')).toBe(7);
  });

  // The writer enforces acyclicity, but this renders whatever is in the DB — including rows
  // predating that guard. A cycle must not hang the render path.
  it('TERMINATES on a cycle instead of looping forever', () => {
    const depths = computeDepths(['A', 'B', 'C'], [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
    ]);
    expect(depths.size).toBe(3);
  });

  it('does not blow the stack on a very deep chain', () => {
    // Iterative by design — a recursive implementation dies here, and a corpus of thousands
    // can legitimately contain a long chain.
    const ids = Array.from({ length: 5000 }, (_, i) => `N${i}`);
    const edges = ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
    expect(() => computeDepths(ids, edges)).not.toThrow();
    expect(computeDepths(ids, edges).get('N4999')).toBe(4999);
  });
});

describe('buildDepSubgraph — default scoping keeps the picture meaningful', () => {
  it('shows only nodes that PARTICIPATE IN AN EDGE, not the whole corpus', () => {
    // This is the property that makes the pane usable against ~1.8k items: an isolated work
    // item has no dependency story, and including them all is what makes it a hairball.
    const items = [item('A'), item('B'), ...Array.from({ length: 500 }, (_, i) => item(`ISO-${i}`))];
    const g = buildDepSubgraph({ items, edges: [edge('B', 'A')] });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(g.truncated).toBe(false);
  });

  it('draws edges blocker → blocked (the direction work flows)', () => {
    const g = buildDepSubgraph({ items: [item('A'), item('B')], edges: [edge('B', 'A')] });
    expect(g.edges).toEqual([expect.objectContaining({ source: 'A', target: 'B' })]);
  });

  it('marks an edge SATISFIED when its blocker is terminal, but still renders it', () => {
    const g = buildDepSubgraph({
      items: [item('A', { state: 'done' }), item('B')],
      edges: [edge('B', 'A', { blockerStatus: 'done' })],
    });
    // Hiding it would erase the lineage that explains why B became free.
    expect(g.edges[0]).toMatchObject({ satisfied: true });
  });
});

describe('buildDepSubgraph — selection scopes to the connected component', () => {
  it('renders only the selected node lineage when a selection exists', () => {
    const items = [item('A'), item('B'), item('C'), item('X'), item('Y')];
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('Y', 'X')]; // two components
    const g = buildDepSubgraph({ items, edges, selectedId: 'B' });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('follows the component in BOTH directions — ancestors AND descendants', () => {
    // A one-directional walk would show what blocks you but not what you block, which is half
    // the lineage and the half that answers "what does finishing this unblock?".
    const g = buildDepSubgraph({
      items: [item('A'), item('B'), item('C')],
      edges: [edge('B', 'A'), edge('C', 'B')],
      selectedId: 'B',
    });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('falls back to the default scope when the selection is not in the graph', () => {
    const g = buildDepSubgraph({
      items: [item('A'), item('B')],
      edges: [edge('B', 'A')],
      selectedId: 'NOT-HERE',
    });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });
});

describe('buildDepSubgraph — the budget bounds the render and REPORTS what it hid', () => {
  it('never exceeds the budget', () => {
    // A wide fan-in: one blocked item with `budget * 2` distinct blockers.
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    expect(g.nodes.length).toBeLessThanOrEqual(DEP_GRAPH_NODE_BUDGET);
  });

  it('REPORTS the elision instead of silently dropping nodes', () => {
    // "Absence rendered as zero" is the failure this guards: a clipped graph must be
    // distinguishable from a genuinely sparse one.
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    expect(g.truncated).toBe(true);
    expect(g.hiddenCount).toBe(g.totalInScope - g.nodes.length);
    expect(g.hiddenCount).toBeGreaterThan(0);
    // totalInScope is the honest denominator — the pre-budget size, not the rendered size.
    expect(g.totalInScope).toBe(n + 1);
  });

  it('keeps the DEEPEST nodes when it has to choose — depth is the signal', () => {
    // A long chain plus many shallow leaves, with a budget too small for both. The chain is
    // what a flat list cannot show, so it is what must survive.
    const chain = Array.from({ length: 10 }, (_, i) => item(`C-${i}`));
    const leaves = Array.from({ length: 50 }, (_, i) => item(`L-${i}`));
    const chainEdges = chain.slice(1).map((c, i) => edge(c.id, chain[i]!.id));
    const leafEdges = leaves.map((l) => edge(l.id, 'C-0'));
    const g = buildDepSubgraph({
      items: [...chain, ...leaves],
      edges: [...chainEdges, ...leafEdges],
      budget: 12,
    });

    const kept = new Set(g.nodes.map((n) => n.id));
    expect(kept.has('C-9')).toBe(true); // the deepest node survives
    expect(g.truncated).toBe(true);
  });

  it('drops edges whose endpoints were budgeted out, leaving no half-edges', () => {
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    const ids = new Set(g.nodes.map((x) => x.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe('buildDepSubgraph — a dangling blocker is rendered as a BREAK, not dropped', () => {
  it('materialises a placeholder node carrying the unresolved ref', () => {
    // INV-13. An inner join here would make exactly the broken edges invisible in the pane
    // built to show broken edges.
    const g = buildDepSubgraph({
      items: [item('A')],
      edges: [edge('A', null, { blockerRef: 'EI-gone' })],
    });

    const placeholder = g.nodes.find((n) => n.dangling);
    expect(placeholder).toBeDefined();
    expect(placeholder!.title).toBe('EI-gone');
    expect(g.edges[0]).toMatchObject({ dangling: true });
  });

  it('does not treat a dangling blocker as satisfied', () => {
    // "Unresolvable" and "finished" are opposite findings; conflating them would render a
    // broken edge as a completed one.
    const g = buildDepSubgraph({ items: [item('A')], edges: [edge('A', null)] });
    expect(g.edges[0]!.satisfied).toBe(false);
  });
});

describe('buildDepSubgraph — respects the caller\'s already-filtered row set', () => {
  it('omits an edge whose blocker was filtered out of the row set', () => {
    // The shared `wif`/`wq` filters (P-010) produce `items`; an edge pointing at a row the user
    // filtered away must NOT resurrect that row into the picture. The edge goes, and since A
    // then participates in no edge it falls out of the default scope too.
    const g = buildDepSubgraph({ items: [item('A')], edges: [edge('A', 'FILTERED-OUT')] });
    expect(g.edges).toEqual([]);
    expect(g.nodes).toEqual([]);
  });

  it('keeps a DANGLING blocker even though it is also absent from the row set', () => {
    // The two look identical from `items` alone — neither id is there — but they are opposite
    // findings: a filtered-out row is a user choice, an unresolvable ref is a defect. The
    // resolver distinguishes them (blockerId null vs set) and this must not re-conflate them.
    const filtered = buildDepSubgraph({ items: [item('A')], edges: [edge('A', 'FILTERED-OUT')] });
    const broken = buildDepSubgraph({ items: [item('A')], edges: [edge('A', null, { blockerRef: 'EI-gone' })] });

    expect(filtered.edges).toEqual([]);
    expect(broken.edges).toHaveLength(1);
  });

  it('omits an edge whose BLOCKED side is not in the row set', () => {
    const g = buildDepSubgraph({ items: [item('A')], edges: [edge('NOT-IN-VIEW', 'A')] });
    expect(g.edges).toEqual([]);
    expect(g.nodes).toEqual([]);
  });

  // dependency-health-pane-2026-08-02 P-008 — the integrity view as a FILTER MODE.
  describe('integrity mode (P-008)', () => {
    it('keeps ONLY dangling and satisfied edges, dropping healthy ones', () => {
      const items = [item('A'), item('B'), item('C'), item('D')];
      const g = buildDepSubgraph({
        items,
        edges: [
          edge('B', 'A'), // healthy: live blocker, unresolved work — gates something
          edge('C', null, { blockerRef: 'EI-gone' }), // dangling
          // Satisfied is read from the EDGE's blockerStatus against the BLOCKER's family
          // vocabulary (isBlockerSatisfied) — NOT from the blocker item's own `state`.
          // D is kind 'feature', so 'passed' is its terminal form, not 'done' (D-019).
          edge('C', 'D', { blockerStatus: 'passed' }),
        ],
        healthOnly: true,
      });
      expect(g.edges).toHaveLength(2);
      expect(g.edges.every((e) => e.dangling || e.satisfied)).toBe(true);
      // The healthy edge's exclusive endpoint drops out with it.
      expect(g.nodes.map((n) => n.id)).not.toContain('B');
    });

    it('is OFF by default — the pane is a graph view first, a diagnostic second', () => {
      const g = buildDepSubgraph({ items: [item('A'), item('B')], edges: [edge('B', 'A')] });
      expect(g.edges).toHaveLength(1);
    });

    it('narrows what the BUDGET measures, so the mode can rescue an over-budget graph', () => {
      // The ordering matters: filter-then-budget means asking the narrower question makes a
      // too-large corpus drawable. Budget-then-filter would elide findings to make room for
      // healthy nodes — backwards for a health view, and silently so.
      const n = DEP_GRAPH_NODE_BUDGET + 40;
      const items = [item('HUB'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
      const edges = Array.from({ length: n }, (_, i) => edge('HUB', `B-${i}`));
      // One genuinely broken edge hiding in a corpus far past the budget.
      edges.push(edge('HUB', null, { blockerRef: 'EI-gone' }));

      const all = buildDepSubgraph({ items, edges });
      const healthy = buildDepSubgraph({ items, edges, healthOnly: true });

      expect(all.truncated).toBe(true);
      expect(healthy.truncated).toBe(false);
      expect(healthy.edges).toHaveLength(1);
      expect(healthy.edges[0]?.dangling).toBe(true);
    });

    it('reports a clean graph as EMPTY rather than inventing a finding', () => {
      const g = buildDepSubgraph({
        items: [item('A'), item('B')],
        edges: [edge('B', 'A')],
        healthOnly: true,
      });
      expect(g.edges).toEqual([]);
      expect(g.nodes).toEqual([]);
    });
  });

  // dependency-health-pane-2026-08-02 P-012 (D-003 req 2: "all the plan and work items").
  //
  // Plan items are NOT a second node kind here — a plan item IS a work_items row
  // (plans:start mints one per item; the owner's 2026-07-27 identity decision reused the
  // work-item id rather than giving plan items their own id space). So the graph already
  // contains them, and P-012 reduces to carrying their PROVENANCE through to the renderer.
  // These pin that the carry actually happens, since a dropped field would look identical
  // to "this harness has no plan-derived items" — silent, and wrong in the quiet direction.
  describe('plan provenance (P-012)', () => {
    it('carries planSlug through onto the built nodes', () => {
      const g = buildDepSubgraph({
        items: [item('A', { planSlug: 'my-plan' }), item('B')],
        edges: [edge('B', 'A')],
      });
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      expect(byId.get('A')?.planSlug).toBe('my-plan');
      // Absent provenance must stay falsy, never become the string "null"/"undefined" —
      // the renderer branches on truthiness to decide whether to draw the marker.
      expect(byId.get('B')?.planSlug ?? null).toBeNull();
    });

    it('does not invent provenance for a DANGLING placeholder node', () => {
      // A dangling node is synthesised from an unresolved ref, so it has no row and
      // therefore no plan. Marking it as plan-derived would assert provenance the system
      // does not have — the exact over-claim the dangling class exists to avoid.
      const g = buildDepSubgraph({
        items: [item('A', { planSlug: 'my-plan' })],
        edges: [edge('A', null, { blockerRef: 'EI-gone' })],
      });
      const ghost = g.nodes.find((n) => n.dangling);
      expect(ghost).toBeDefined();
      expect(ghost?.planSlug ?? null).toBeNull();
    });
  });
});
