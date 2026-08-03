/**
 * dep-graph-model.ts — the PURE core of the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-005 scoping/budget, P-007 depth, P-013 budget).
 *
 * ── WHY A PURE MODULE SEPARATE FROM THE COMPONENT ───────────────────────────────────────
 * Everything that decides WHAT the user sees — which subgraph, in what order, what gets
 * hidden when the corpus is too big — lives here, with no React, no elkjs and no DOM. That
 * makes the load-bearing behaviour unit-testable at the fast tier, and it keeps the component
 * to wiring. elkjs in particular must NOT be imported at module scope: D-005 requires it to be
 * lazily loaded (it is a GWT-transpiled ~1MB bundle), so it is dynamically imported inside the
 * component's layout effect and never referenced here.
 *
 * ── THE CENTRAL CONSTRAINT: "VIEW ALL … COULD BE THOUSANDS" ─────────────────────────────
 * The owner asked to be able to view all the plan and work items, "which could be thousands"
 * (D-003). A Sugiyama layered DAG of thousands of nodes is not merely slow — it is unreadable,
 * and React Flow renders a DOM node per node on top of that. D-001 anticipated this and said
 * plainly that rendering the unfiltered graph "and calling it done" implements the decision
 * WRONGLY.
 *
 * The reconciliation this module implements: FILTERS AND SELECTION ARE THE NAVIGATION. The
 * pane always renders a BOUNDED subgraph, and "view all" means every part of the corpus is
 * REACHABLE — never that it is all laid out at once.
 *
 * ── ABSENCE IS REPORTED, NEVER SILENT ───────────────────────────────────────────────────
 * When the budget elides nodes, `hiddenCount` says how many and `truncated` says it happened,
 * so the UI can render "N more — filter to see them". A pane that silently drops nodes is
 * strictly worse than one that refuses: the user cannot tell a sparse graph from a clipped
 * one, which is the same "absence rendered as zero" failure AdvSyncHealthPanel was built to
 * avoid.
 */

/** A node as the graph needs it. A structural subset of the list's row — same corpus (D-003). */
export interface DepGraphItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  /**
   * The plan this item came from (`work_items.source_plan_slug`, surfaced as
   * `WorkItemRow.planSlug` — see listEnrichedWorkItems, work-items.ts:89), or null
   * for an item that did not originate in a plan.
   *
   * This is what makes a PLAN item distinguishable from any other work item
   * (dependency-health-pane-2026-08-02 P-012 / D-003 req 2: "all the plan and work
   * items"). It is deliberately NOT a separate node kind: a plan item IS a
   * work_items row in this system — `plans:start` mints one per item, and the
   * owner's 2026-07-27 identity decision was to reuse that work-item id rather than
   * give plan items an id space of their own. So both "kinds" are already one
   * corpus, and the graph distinguishes them by PROVENANCE, not by type.
   *
   * ⚠ Do NOT reach for `source_plan_item_ids` to do this instead: it is populated on
   * 1 of 1,178 plan-derived papercusp rows (measured 2026-08-03), so it looks like
   * the precise linkage and is in practice empty.
   */
  planSlug?: string | null;
}

/** An edge as `workItems.depEdges` returns it. `blockerId: null` = dangling (INV-13). */
export interface DepGraphEdgeInput {
  blockedId: string;
  blockerId: string | null;
  blockerRef: string;
  blockerStatus: string | null;
}

export interface DepGraphNode extends DepGraphItem {
  /** Longest blocker-chain length above this node. 0 = nothing blocks it. */
  depth: number;
  /** True when this node's ref could not be resolved to a real row — a placeholder. */
  dangling?: boolean;
}

export interface DepGraphEdge {
  id: string;
  /** The BLOCKER (edges are drawn blocker → blocked, the direction work flows). */
  source: string;
  /** The BLOCKED item. */
  target: string;
  /** A blocker already terminal no longer gates — drawn subdued rather than hidden. */
  satisfied: boolean;
  /** The blocker ref resolved to no row: a finding, not a tidy edge (INV-13). */
  dangling: boolean;
}

export interface DepSubgraph {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  /** Nodes elided by the budget. Rendered as "N more", never silently dropped. */
  hiddenCount: number;
  truncated: boolean;
  /** Nodes in the graph BEFORE the budget — the honest denominator for a count label. */
  totalInScope: number;
}

/**
 * The node budget. Chosen for READABILITY first: past a few hundred nodes a layered DAG is a
 * crossing-dominated hairball whatever renders it, so a bigger budget would buy an unusable
 * picture and a slow one. Exported so a test can pin behaviour without hardcoding the number.
 */
export const DEP_GRAPH_NODE_BUDGET = 300;

/** Blocker statuses that no longer gate. PER FAMILY — the two lists genuinely differ. */
const FEATURE_TERMINAL = new Set(['passed', 'deprecated', 'done', 'dropped']);
const ISSUE_TERMINAL = new Set(['resolved', 'closed', 'done', 'dropped']);
const ISSUE_KINDS = new Set(['bug', 'change', 'task']);

/**
 * Is this blocker satisfied (terminal)?
 *
 * ⚠ Terminality is PER FAMILY and the two vocabularies are NOT the same set — `closed` is
 * terminal for an issue and NOT for a feature. Collapsing them into one union list is a real,
 * already-made mistake: it is exactly what `dependency-fixture.ts` did until property-based
 * tests caught it disagreeing with the shipped oracle on four of six states (D-019). Kind is
 * passed rather than family so the caller never has to re-derive the mapping.
 */
export function isBlockerSatisfied(kind: string | null | undefined, status: string | null): boolean {
  if (!status) return false;
  const terminal = kind && ISSUE_KINDS.has(kind) ? ISSUE_TERMINAL : FEATURE_TERMINAL;
  return terminal.has(status);
}

/**
 * Longest-path depth per node, over blocker → blocked edges.
 *
 * Depth is the signal this pane exists to surface: the subsystem's worst escape (EI-9108) was a
 * SEVEN-DEEP blockedBy chain served as claimable, which a flat list cannot show and a layered
 * DAG shows at a glance (D-001).
 *
 * Iterative (explicit stack), not recursive: a deep chain in a corpus of thousands would blow
 * the JS stack, and this runs in the render path. Cycles cannot hang it — a node already on the
 * active path is skipped, so a cycle contributes no depth rather than looping forever. The edge
 * writer enforces acyclicity, but this module must not DEPEND on that: it renders whatever is
 * in the database, including data that predates the guard.
 */
export function computeDepths(
  nodeIds: Iterable<string>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
  const blockersOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = blockersOf.get(e.target);
    if (list) list.push(e.source);
    else blockersOf.set(e.target, [e.source]);
  }

  const depth = new Map<string, number>();
  const onPath = new Set<string>();

  for (const start of nodeIds) {
    if (depth.has(start)) continue;
    // Post-order iterative DFS: visit children, then resolve the parent from them.
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: start, expanded: false }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (depth.has(frame.id)) {
        stack.pop();
        onPath.delete(frame.id);
        continue;
      }
      if (!frame.expanded) {
        frame.expanded = true;
        onPath.add(frame.id);
        for (const b of blockersOf.get(frame.id) ?? []) {
          // Skip a node already on the active path — that is a cycle.
          if (!onPath.has(b) && !depth.has(b)) stack.push({ id: b, expanded: false });
        }
        continue;
      }
      let best = 0;
      for (const b of blockersOf.get(frame.id) ?? []) {
        const d = depth.get(b);
        if (d !== undefined) best = Math.max(best, d + 1);
      }
      depth.set(frame.id, best);
      onPath.delete(frame.id);
      stack.pop();
    }
  }
  return depth;
}

/** Every node reachable from `seed` following edges in BOTH directions (its component). */
function connectedComponent(
  seed: string,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Set<string> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = neighbours.get(a);
    if (l) l.push(b);
    else neighbours.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const seen = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const n of neighbours.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/**
 * Build the bounded subgraph to render.
 *
 * SCOPING, in order of precedence:
 *   1. A SELECTION scopes to that node's connected component — D-001's first mitigation, and
 *      the interaction that makes a huge graph usable: pick a row, see its lineage.
 *   2. Otherwise, only nodes that PARTICIPATE IN AN EDGE are shown. An isolated work item has
 *      no dependency story to tell, and including thousands of them is what makes the picture
 *      unreadable. This is the default that keeps the pane meaningful at corpus scale.
 *
 * `items` is expected to be the caller's ALREADY-FILTERED row set (the shared `wif`/`wq`
 * filters — P-010), so the user's filters compose with this scoping rather than fighting it.
 *
 * BUDGET: if the scoped set still exceeds `budget`, keep the DEEPEST nodes — depth is the
 * signal (P-007), so eliding shallow leaves loses least. The count of what was elided is
 * returned, never swallowed.
 */
export function buildDepSubgraph(opts: {
  items: readonly DepGraphItem[];
  edges: readonly DepGraphEdgeInput[];
  selectedId?: string | null;
  budget?: number;
  /**
   * INTEGRITY MODE (P-008). When true, narrow the graph to the UNHEALTHY edges and their
   * endpoints — the "written but gates nothing" set this plan is named for.
   *
   * An edge qualifies when it is `dangling` (its blockerRef resolves to no row — INV-13's
   * stale class, and also how a wrong-FORM ref surfaces now that the resolver's join is
   * family-aware) or `satisfied` (the blocker is already terminal, so the edge is recorded
   * but gates nothing). Those two ARE the health findings; there is no third detector
   * hiding here, and inventing one would be asserting a signal the data does not carry.
   *
   * It is a MODE ON THIS PANE, never a separate surface (the plan's ## Now: "Do not
   * re-narrow this to a diagnostics pane"), and it composes with — rather than replaces —
   * the caller's `wif` column filters and the `selectedId` scoping, because it narrows the
   * same edge set those already produced.
   *
   * Applied BEFORE the budget on purpose: switching to health mode must genuinely shrink
   * what the budget measures, so a corpus too big to draw becomes drawable by asking the
   * narrower question. Filtering after the budget would elide findings to make room for
   * healthy nodes — exactly backwards for a health view.
   */
  healthOnly?: boolean;
}): DepSubgraph {
  const budget = opts.budget ?? DEP_GRAPH_NODE_BUDGET;
  const byId = new Map(opts.items.map((i) => [i.id, i]));

  // Edges first: they define which nodes are interesting. A dangling blocker becomes a
  // PLACEHOLDER node so the break is visible in the picture rather than an edge to nowhere.
  const allEdges: DepGraphEdge[] = [];
  const danglingRefs = new Map<string, string>();
  for (const e of opts.edges) {
    // The blocked side must be a row we actually have; otherwise it is outside this view.
    if (!byId.has(e.blockedId)) continue;
    const sourceId = e.blockerId ?? `dangling:${e.blockerRef}`;
    if (!e.blockerId) danglingRefs.set(sourceId, e.blockerRef);
    else if (!byId.has(e.blockerId)) continue; // resolved, but filtered out of this view
    allEdges.push({
      id: `${sourceId}->${e.blockedId}`,
      source: sourceId,
      target: e.blockedId,
      satisfied: isBlockerSatisfied(byId.get(e.blockerId ?? '')?.kind, e.blockerStatus),
      dangling: !e.blockerId,
    });
  }

  const rawEdges = opts.healthOnly
    ? allEdges.filter((e) => e.dangling || e.satisfied)
    : allEdges;

  // Which nodes are in scope, before the budget.
  let scopeIds: Set<string>;
  if (opts.selectedId && (byId.has(opts.selectedId) || danglingRefs.has(opts.selectedId))) {
    scopeIds = connectedComponent(opts.selectedId, rawEdges);
  } else {
    scopeIds = new Set<string>();
    for (const e of rawEdges) {
      scopeIds.add(e.source);
      scopeIds.add(e.target);
    }
  }

  const depths = computeDepths(scopeIds, rawEdges);

  let nodes: DepGraphNode[] = [...scopeIds].map((id) => {
    const item = byId.get(id);
    if (item) return { ...item, depth: depths.get(id) ?? 0 };
    // A dangling placeholder — it has no row, so it carries the ref as its label and is
    // flagged so the UI can draw it as a break rather than a work item.
    return {
      id,
      kind: 'unknown',
      title: danglingRefs.get(id) ?? id,
      state: 'missing',
      depth: depths.get(id) ?? 0,
      dangling: true,
    };
  });

  const totalInScope = nodes.length;
  let hiddenCount = 0;
  if (nodes.length > budget) {
    // Deepest first — shallow leaves are the cheapest thing to lose (see P-007).
    nodes = [...nodes].sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id)).slice(0, budget);
    hiddenCount = totalInScope - nodes.length;
  }

  const kept = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => kept.has(e.source) && kept.has(e.target));

  // Stable order so React Flow keys and the a11y tree do not churn between renders.
  nodes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return { nodes, edges, hiddenCount, truncated: hiddenCount > 0, totalInScope };
}
