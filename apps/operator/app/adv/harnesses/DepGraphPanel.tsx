'use client';

/**
 * DepGraphPanel — the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-002/P-004/P-005/P-006/P-013/P-014).
 *
 * Owner's ask (2026-08-01 23:56, verbatim): "adding a graph view panel to our work tab that
 * shows all the same data as our work items list view but in graph form, modeling the work
 * items and blockedbys as their dependency[…]" — plus, next day: "…view all the plan and work
 * items which could be thousands. like other tabs this should also have a pot selector to
 * filter, and all the filters from the work item list pane should also be brought over."
 *
 * ── IT SHARES THE LIST'S DATA, IT DOES NOT RE-FETCH IT ──────────────────────────────────
 * Nodes come from the SAME `workItems.byHarness` subscription the grid uses, with the SAME
 * `limit` (WORK_ITEMS_PAGE) so React Query dedups the two into ONE stream. That is deliberate
 * on two counts: "the same data as the list" is the requirement, and a second multi-MB fetch
 * would starve the desktop webview's ~6-connection-per-host cap — the known "stuck on Loading"
 * failure DetailPanel avoids the same way. Only the EDGES are a new query.
 *
 * ── SELECTION IS URL STATE, AND THAT IS NOT A STYLE CHOICE ──────────────────────────────
 * Selection lives in the `sel` nuqs param — the very param WorkItemsPanel's row-click writes
 * and DetailPanel reads. So clicking a node drives the Detail pane, clicking a row re-scopes
 * the graph, and all three stay in lockstep for free. Per the repo rule, user-meaningful state
 * goes in the URL because `ui:get_state`/`ui:dispatch` read the URL: selection held in
 * useState would be invisible to agents.
 *
 * ── elkjs IS LAZY, BY DECISION ──────────────────────────────────────────────────────────
 * D-005 (owner: "lets use elkjs") requires it never enter the initial chunk — it is a
 * GWT-transpiled ~1MB bundle shipping in a DESKTOP app. It is therefore `import()`ed inside
 * the layout effect, on first render of a non-empty graph, and cached across re-layouts.
 *
 * The worker entry (elk-worker) is deliberately NOT used yet: layout runs on a subgraph
 * bounded by DEP_GRAPH_NODE_BUDGET (300 nodes), where ELK is a few tens of ms — while a worker
 * would need a bundled worker URL that survives the strict desktop CSP, which is real risk for
 * no measured gain. If the budget ever rises enough for layout to block the frame, the worker
 * is the next step and the seam is one import.
 *
 * ── ABSENCE IS NEVER RENDERED AS ZERO ───────────────────────────────────────────────────
 * A graph clipped by the node budget says so ("N more — filter to see them"). An empty graph
 * says WHY it is empty (no items / no dependencies / filtered away). A reader must always be
 * able to tell "nothing to show" from "too much to show".
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { readListMeta } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { Button } from '../../harness/Button';
import { useColumnFilters, ColumnFilterBar } from '../../harness/filters';
import { WORK_ITEMS_PAGE, type WorkItemRow } from './WorkItemsPanel';
import { workItemFilterColumns, WORK_ITEM_FILTER_NS } from './work-item-columns';
import {
  buildDepSubgraph,
  DEP_GRAPH_NODE_BUDGET,
  type DepGraphEdge,
  type DepGraphNode,
} from './dep-graph-model';

/** One row of `workItems.depEdges` (see lib/sync-resolver/dependency-graph-edges.ts). */
interface DepEdgeRow {
  blockedId: string;
  blockerId: string | null;
  blockerRef: string;
  blockedKind: string;
  blockerKind: string | null;
  blockerStatus: string | null;
  // Endpoint hydration (WI-36045) — what makes an edge drawable when its endpoint fell
  // outside the list's 500-row window. Optional here so an in-flight cached payload from
  // before this shipped degrades to id-labelled nodes rather than erroring the panel.
  blockedTitle?: string | null;
  blockedStatus?: string | null;
  blockedPlanSlug?: string | null;
  blockerTitle?: string | null;
  blockerPlanSlug?: string | null;
}

const NODE_W = 210;
const NODE_H = 46;

/**
 * How many title characters fit on one node line, at the node's width and the 11px
 * title size. Deliberately DERIVED from NODE_W rather than a second hardcoded number
 * (the pair went out of sync at 190px/28ch, which is why titles truncated so hard —
 * P-006): ~5.6px per character at 11px in the UI face, less the 10px gutters.
 */
const TITLE_CHARS = Math.floor((NODE_W - 20) / 5.6);

/**
 * State → a coarse bucket the node's status dot is coloured by (P-006).
 *
 * ⚠ Terminality here is intentionally NOT `isBlockerSatisfied`: that oracle answers a
 * different question (does this blocker still GATE, per family) and depends on the row's
 * kind. This is a display bucket for a node's own state across both vocabularies, so it
 * folds every terminal token from either family into one 'done' bucket and never claims
 * to be the gating oracle. Anything unrecognised falls to 'open' rather than being
 * silently coloured as something it is not.
 */
const STATE_DONE = new Set(['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped']);
const STATE_BAD = new Set(['blocked', 'failing', 'needs_human', 'needs-human']);
const STATE_ACTIVE = new Set(['in_progress', 'in-progress', 'wip', 'validating']);
function stateBucket(state: string): 'done' | 'bad' | 'active' | 'open' {
  if (STATE_DONE.has(state)) return 'done';
  if (STATE_BAD.has(state)) return 'bad';
  if (STATE_ACTIVE.has(state)) return 'active';
  return 'open';
}

interface Positioned {
  nodes: Array<DepGraphNode & { x: number; y: number }>;
  edges: DepGraphEdge[];
  width: number;
  height: number;
}

/** Cached elk instance — the module is ~1MB, so it is imported once per session at most. */
let elkPromise: Promise<{ layout: (g: unknown) => Promise<unknown> }> | null = null;
async function getElk() {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((m) => {
      const Ctor = (m.default ?? m) as new () => { layout: (g: unknown) => Promise<unknown> };
      return new Ctor();
    });
  }
  return elkPromise;
}

/**
 * ELK options for a left-to-right LAYERED DAG (D-001).
 *
 * `layered` is the Sugiyama family the decision names. NETWORK_SIMPLEX layering plus
 * BRANDES_KOEPF node placement is ELK's standard high-quality combination, and crossing
 * minimisation is what we adopted ELK for over dagre in the first place (D-005).
 */
const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.spacing.nodeNode': '24',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.spacing.edgeNode': '16',
};

export default function DepGraphPanel({ params }: PanelComponentProps) {
  const slug = typeof params.harnessSlug === 'string' ? params.harnessSlug : '';
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));

  // INTEGRITY MODE (P-008) — a FILTER MODE on this pane, not a separate surface. In nuqs
  // like every other user-meaningful axis here, so the view is linkable and agent-drivable
  // (`ui:get_state` / `ui:dispatch` read the URL; useState would be invisible to them).
  // Its own param, deliberately: it is orthogonal to the `wif` column filters and composes
  // with them (health ∧ filters), so folding it into `wif` would make "show me the broken
  // edges" mutually exclusive with "show me this plan's items".
  const [health, setHealth] = useQueryState(
    'dgh',
    parseAsStringEnum(['all', 'issues']).withDefault('all'),
  );
  const healthOnly = health === 'issues';

  // SAME queryName + SAME limit as WorkItemsPanel ⇒ one shared subscription (see header).
  const itemsQuery = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug: slug, limit: WORK_ITEMS_PAGE },
    enabled: Boolean(slug),
  });
  const edgesQuery = useSyncQuery<DepEdgeRow>({
    queryName: 'workItems.depEdges',
    args: { harnessSlug: slug },
    enabled: Boolean(slug),
  });

  // `loading ? null : data` — NOT `data ?? null`. A defined-but-EMPTY array is a real answer
  // ("no dependencies") and must not be confused with "not loaded yet"; conflating them is a
  // bug this codebase has already shipped once.
  const items = itemsQuery.loading ? null : itemsQuery.data;
  const edgeRows = edgesQuery.loading ? null : edgesQuery.data;
  const error = itemsQuery.error?.message ?? edgesQuery.error?.message ?? null;

  // FULL FILTER PARITY with the list pane (P-010 / D-003 req 4). The columns come
  // from the SHARED definition module, and the `ns` is the SAME one WorkItemsPanel
  // uses — so both panes read and write ONE `wif` nuqs param. Filtering the grid
  // narrows the graph and vice versa, with no cross-pane wiring: the URL is the bus.
  //
  // Declared BEFORE the early returns below — hooks must run unconditionally.
  const filterColumns = useMemo(() => workItemFilterColumns(), []);
  const cf = useColumnFilters(filterColumns, items ?? [], { ns: WORK_ITEM_FILTER_NS });

  // The graph is built from the FILTERED rows, so a filter genuinely shrinks the
  // node set the budget is measured against — filtering is the primary way a reader
  // gets a clipped graph back under budget (see the truncation chip below).
  const visibleItems = items == null ? null : cf.rows;

  const graph = useMemo(() => {
    if (!visibleItems || !edgeRows) return null;
    return buildDepSubgraph({
      items: visibleItems.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        state: i.state,
        // P-012: carries the plan provenance so the renderer can mark plan items.
        planSlug: i.planSlug,
      })),
      edges: edgeRows,
      selectedId: selectedId || null,
      healthOnly,
      // WI-36045: the model must not guess why `items` is a subset of the corpus. Only the
      // caller knows whether the user filtered, or whether this is just the list's window.
      filterActive: cf.hasActive,
    });
  }, [visibleItems, edgeRows, selectedId, healthOnly, cf.hasActive]);

  const [positioned, setPositioned] = useState<Positioned | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  /** Guards against an out-of-order layout resolving after a newer one (async race). */
  const layoutSeq = useRef(0);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setPositioned(null);
      return;
    }
    const seq = ++layoutSeq.current;
    let cancelled = false;

    (async () => {
      try {
        const elk = await getElk();
        const laid = (await elk.layout({
          id: 'root',
          layoutOptions: ELK_OPTIONS,
          children: graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
          edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
        })) as { children?: Array<{ id: string; x?: number; y?: number }>; width?: number; height?: number };

        if (cancelled || seq !== layoutSeq.current) return;
        const pos = new Map((laid.children ?? []).map((c) => [c.id, c]));
        const nodes = graph.nodes.map((n) => ({
          ...n,
          x: pos.get(n.id)?.x ?? 0,
          y: pos.get(n.id)?.y ?? 0,
        }));
        // P-005 — SIZE THE CANVAS FROM THE NODES, not from ELK's reported extent alone.
        // The rightmost column was rendering sliced mid-card. `laid.width` is whatever the
        // layouter chose to report, and taking it as the SVG width means any disagreement
        // between it and where the nodes actually ended up gets resolved by clipping — the
        // one resolution a reader cannot detect, because a half-drawn card looks like a
        // scroll boundary. Measuring max(x + NODE_W) is the definition of "no node is cut",
        // is independent of ELK's bookkeeping, and can only ever grow the canvas. EDGE_PAD
        // leaves room for the arrowhead + the selected node's 2px stroke, which sit OUTSIDE
        // the node box and would otherwise clip at the exact extent.
        const EDGE_PAD = 8;
        const extentW = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + EDGE_PAD;
        const extentH = nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + EDGE_PAD;
        setPositioned({
          nodes,
          edges: graph.edges,
          width: Math.max(laid.width ?? 0, extentW),
          height: Math.max(laid.height ?? 0, extentH),
        });
        setLayoutError(null);
      } catch (err) {
        if (cancelled || seq !== layoutSeq.current) return;
        // Surface it. A silently blank graph is indistinguishable from "no dependencies",
        // which is the one thing this pane must never do.
        setLayoutError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [graph]);

  /**
   * The ONE way selection is cleared. The button and the Esc key both call this, so the
   * two can never drift apart — which is the whole reason it is a callback rather than
   * two `setSelectedId('')` call sites (P-007/P-008).
   */
  const clearSelection = useCallback(() => {
    void setSelectedId('');
  }, [setSelectedId]);

  // P-008 — Esc deselects. [owner 2026-08-08 verbatim] "pressing esc should also
  // automatically deselect".
  //
  // Document-level, because selection is a PANE-WIDE mode: the user may have clicked an
  // SVG node (not focusable), so a handler bound to the pane's DOM subtree would only fire
  // for the a11y list. The guards are what make a document listener acceptable rather than
  // a key-stealer, and each one is a case Esc already means something else:
  //   • nothing selected      → do nothing AND do not preventDefault, so Esc still reaches
  //                             whatever else would have handled it (the item's own test).
  //   • already handled       → a dialog/menu that called preventDefault wins.
  //   • a Radix layer is open → its popper wrapper is in the DOM; Esc closes THAT first.
  //   • focus is in a field   → Esc is the editor's own cancel.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // ⚠ `e.target` is NOT always an Element — a keydown with nothing focused targets the
      // Document, which has no `closest`/`tagName`. Reading it as an HTMLElement throws
      // INSIDE a document-level listener, i.e. an unhandled exception on a keypress. The
      // instanceof narrowing is the guard, not decoration.
      const t = e.target;
      if (t instanceof Element) {
        const tag = t.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (t instanceof HTMLElement && t.isContentEditable) ||
          t.closest('[role="dialog"], [role="menu"], [role="listbox"]')
        ) {
          return;
        }
      }
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return;
      e.preventDefault();
      clearSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId, clearSelection]);

  /** Unique per mounted pane — two panes in one dock must not share arrowhead marker ids. */
  const rawUid = useId();
  const uid = rawUid.replace(/[^a-zA-Z0-9_-]/g, '');

  if (!slug) return <div className="pc-advpanel__empty">No harness selected.</div>;
  if (error) return <div className="pc-advpanel__empty">Could not load the dependency graph: {error}</div>;
  if (!graph) return <div className="pc-advpanel__empty">Loading dependency graph…</div>;

  // The bar is rendered in BOTH the empty and populated states, and that is load-bearing
  // rather than tidy: filtering is now the primary navigation, so a filter that happens to
  // match nothing must NOT take its own "Clear" affordance off screen with it. Hiding the
  // bar on empty strands the user in a graph they cannot un-filter without editing the URL.
  // P-001 — ANSWER "why 18,647 items but only 122 nodes?" IN THE PANE.
  //
  // The count is only sayable when the graph is UNSCOPED. `totalInScope` means "nodes before
  // the budget", which equals "items that participate in an edge" ONLY when no selection, no
  // health mode and no column filter have narrowed the edge set first; under any of those it
  // is a scoped subset and the sentence "N of TOTAL items have dependencies" becomes false.
  // So the claim is gated on the scoping being absent rather than reworded to survive it — a
  // number that is right in the common case and quietly wrong in the others is worse than no
  // number, and this pane has already paid for one of those (WI-36045).
  //
  // `readListMeta(...)?.total`, NOT `readListTotal(...)`: the latter FALLS BACK to the
  // downloaded array length when the resolver attached no total, which here would silently
  // turn the sentence into "122 of 500 items have dependencies" — the page size dressed up
  // as the corpus. An absent total must read as "I don't know the denominator", so the
  // claim is withheld rather than made from a fallback.
  const corpusTotal = readListMeta(items ?? [])?.total ?? 0;
  const unscoped = !selectedId && !healthOnly && !cf.hasActive;
  const canStateCorpus = unscoped && corpusTotal > 0 && graph.totalInScope > 0;

  const bar = (
    <div className="pc-advpanel__bar pc-advpanel__bar--wrap">
      {selectedId && (
        // P-007 — the exit from a filtered state, given real emphasis and placed FIRST.
        // [owner 2026-08-08 verbatim] "when you have a ndoe selected the clear selection
        // button should be more visible". It used to be a .pc-advpanel__iconbtn — a fixed
        // 28×28 icon box — sitting last in a crowded row, so it read as chrome AND had its
        // text label wrapped by the 28px width. Accent variant, first position: when
        // something IS selected, the way out is the first thing the eye reaches, and with
        // the bar now wrapping it can never be pushed off screen.
        <Button
          variant="accent"
          className="pc-depgraph__clearsel"
          onClick={clearSelection}
          aria-label={`Clear selection (${selectedId}) and show the whole dependency graph. Escape also clears it.`}
        >
          Clear selection
        </Button>
      )}
      <span className="pc-advpanel__chip">
        {canStateCorpus
          ? `${graph.totalInScope.toLocaleString()} of ${corpusTotal.toLocaleString()} items have dependencies`
          : `${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}`}{' '}
        · {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}
      </span>
      {canStateCorpus && (
        // The RULE, not just the number — a reader who wonders "where are the other 18,525?"
        // gets the answer without leaving the pane, which is the item's acceptance test.
        <span className="pc-depgraph__note">Items with no dependency are not drawn</span>
      )}
      {graph.truncated && (
        // Absence is reported, never silent (D-003 / the budget contract).
        <span className="pc-advpanel__chip pc-depgraph__chip--warn" role="status">
          {graph.hiddenCount} more hidden of {graph.totalInScope} — filter or select to narrow
        </span>
      )}
      {graph.filteredEdgeCount > 0 && (
        // WI-36045's detector. The original bug was invisible precisely because dropped edges
        // had no counter — 2 nodes out of 122 read as real data. A filter narrowing the graph
        // is legitimate; a filter narrowing it SILENTLY is what cost a week.
        <span className="pc-advpanel__chip" role="status">
          {graph.filteredEdgeCount} edge{graph.filteredEdgeCount === 1 ? '' : 's'} hidden by
          filters
        </span>
      )}
      {graph.hydratedNodeCount > 0 && (
        // Not a warning: these are real rows, drawn from the same work_items rows the list
        // reads, that simply fall outside its recency window. Stated so a reader is never
        // puzzled by a node they cannot find in the list pane beside it.
        <span className="pc-advpanel__chip" role="status">
          {graph.hydratedNodeCount} outside the list&rsquo;s current page
        </span>
      )}
      {/*
        The integrity view, as a MODE on this pane rather than a second surface
        (dependency-health-pane-2026-08-02 P-008).

        ⚠ THE CLASS IS THE FIX (this pass's P-002). This was `.pc-advpanel__iconbtn`, which
        is a fixed `width:28px; height:28px; flex-shrink:0` ICON box — so a TEXT label inside
        it had 28px to lay out in and wrapped into three fragments: a detached state glyph on
        one line, then "Issues", then "only". That is precisely the artefact in the owner's
        screenshot, and no amount of `nowrap` on a 28px box would have fixed it. `.pc-advpanel__chip`
        is the house toggle recipe (/internal/docs/design#buttons: native button + aria-pressed,
        tinted fill when pressed), it sizes to its label, and it carries the pressed state as a
        FILL rather than as a wrappable text node — so the state can no longer come apart from
        the word it describes. The glyph is gone for the same reason. (design-phase:search_registry
        has no toggle primitive to reuse — checked, empty.)
      */}
      <button
        type="button"
        className="pc-advpanel__chip"
        aria-pressed={healthOnly}
        /* aria-label, not title: `lint:design-primitives` blocks title-only
           tooltips on buttons because a title is invisible to keyboard and
           touch — and this one carried the button's ONLY explanation of what
           "Issues only" means. It was red-pinning the fleet's green gate on
           committed code. The visible text stays; aria-label supersedes it as
           the accessible name and carries the explanation with it. */
        aria-label={
          healthOnly
            ? 'Issues only — showing only edges that gate nothing: broken (blocker missing) or already satisfied. Activate to show all edges.'
            : 'Issues only — show only edges that gate nothing: broken (blocker missing) or already satisfied.'
        }
        onClick={() => void setHealth(healthOnly ? 'all' : 'issues')}
      >
        Issues only
      </button>
      {/* Same control, same `wif` param, same columns as the list pane (P-010). */}
      <ColumnFilterBar
        controller={cf.controller}
        activeChips={cf.activeChips}
        hasActive={cf.hasActive}
        clearAll={cf.clearAll}
      />
    </div>
  );

  if (graph.nodes.length === 0) {
    // Say WHICH empty this is — the filters are the navigation, so "you filtered it away" and
    // "nothing depends on anything" need different next actions from the user. Filters are
    // checked FIRST: when a filter is active it is the most likely cause and the one the
    // reader can act on immediately.
    // Integrity mode reports a CLEAN result as a finding in its own right — "no broken or
    // inert edges" is the good outcome, and must not read like the pane failed to load.
    const why = healthOnly
      ? 'No broken or already-satisfied edges — nothing here gates nothing.'
      : cf.hasActive
        ? // WI-36234: "No work items match the active filters" was a FALSE statement whenever
          // the filters matched plenty — the grid beside it said "432 of 18601 match" — and
          // it is the EDGE set that came up empty. Name the empty thing, because the two
          // cases need different next actions: widen the filter vs. there is no dependency
          // story here to tell.
          visibleItems && visibleItems.length > 0
          ? `None of the ${visibleItems.length.toLocaleString()} items matching the active filters have dependencies.`
          : 'No work items match the active filters.'
        : items && items.length === 0
          ? 'No work items for this harness.'
          : selectedId
            ? `${selectedId} has no dependencies.`
            // NOT "among the visible work items" any more (WI-36045): the graph is no longer
            // limited to the list's window, so an empty graph here really does mean the
            // harness records no dependency edges — a stronger, more useful statement.
            : 'No dependency edges recorded for this harness.';
    return (
      <div className="pc-advpanel pc-depgraph">
        {bar}
        <div className="pc-advpanel__empty">{why}</div>
      </div>
    );
  }

  return (
    <div className="pc-advpanel pc-depgraph">
      {bar}

      {layoutError && <div className="pc-advpanel__empty">Layout failed: {layoutError}</div>}

      {/*
        ACCESSIBILITY (P-006). D-001 flagged that a node-edge SVG is the least accessible of the
        five treatments and that its weakness is STRUCTURAL. So the graph is not the only
        representation: this is a real list, in dependency-depth order, keyboard reachable and
        readable by a screen reader, carrying the SAME depth/lineage information. It drives the
        same selection, so it is an equivalent control surface and not a consolation prize.
      */}
      <ul className="pc-depgraph__a11y" aria-label="Dependency graph, as a list ordered by depth">
        {positioned?.nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              aria-current={n.id === selectedId}
              onClick={() => void setSelectedId(n.id)}
            >
              {n.dangling
                ? `Unresolved blocker ${n.title}`
                : `${n.id} — ${n.title} (depth ${n.depth}, ${n.state})`}
            </button>
          </li>
        ))}
      </ul>

      <div className="pc-depgraph__canvas">
        {positioned && (
          <svg
            width={Math.max(positioned.width, 1)}
            height={Math.max(positioned.height, 1)}
            role="img"
            aria-label={`Dependency graph: ${positioned.nodes.length} items`}
          >
            {/*
              ARROWHEADS (P-004). One marker per edge class, rather than one marker inheriting
              the stroke: `context-stroke` is SVG2 and its support is uneven across the engines
              this ships on, and an arrowhead that silently renders black on a dark panel is
              worse than none. Three explicit markers cost three <defs> children and cannot
              degrade. Marker ids are pane-scoped (`uid`) so two panes in one dock do not
              collide — a duplicate id would make one pane's arrows adopt the other's colour.
            */}
            <defs>
              {(['default', 'satisfied', 'dangling'] as const).map((variant) => (
                <marker
                  key={variant}
                  id={`pc-dg-arrow-${variant}-${uid}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path
                    d="M 0.5 1 L 7 4 L 0.5 7 z"
                    className={`pc-depgraph__arrowhead pc-depgraph__arrowhead--${variant}`}
                  />
                </marker>
              ))}
            </defs>
            {/*
              EDGES ARE STILL THE SECONDARY MARK (D-003 req 1 — the owner's "the edges are much
              too big"). This pass raises CONTRAST and adds DIRECTION; it does NOT raise weight.
              Those are different complaints and both owner-sourced: the stroke stays hairline,
              the opacity comes up off the floor, and an arrowhead says which end blocks which —
              the one thing a dependency graph exists to convey, and the thing 79 undirected
              hairlines could not. Colours stay in CSS custom properties so the tokens govern.
            */}
            <g className="pc-depgraph__edges" fill="none">
              {positioned.edges.map((e) => {
                const a = positioned.nodes.find((n) => n.id === e.source);
                const b = positioned.nodes.find((n) => n.id === e.target);
                if (!a || !b) return null;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                // Stop 2px short of the target so the arrowhead sits BESIDE the node border
                // rather than under it — an arrow drawn onto the card reads as a fleck.
                const x2 = b.x - 2;
                const y2 = b.y + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                const variant = e.dangling ? 'dangling' : e.satisfied ? 'satisfied' : 'default';
                return (
                  <path
                    key={e.id}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    markerEnd={`url(#pc-dg-arrow-${variant}-${uid})`}
                    className={
                      variant === 'default'
                        ? 'pc-depgraph__edge'
                        : `pc-depgraph__edge pc-depgraph__edge--${variant}`
                    }
                  />
                );
              })}
            </g>
            <g className="pc-depgraph__nodes">
              {positioned.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  className={`pc-depgraph__node${n.dangling ? ' pc-depgraph__node--dangling' : ''}${
                    n.planSlug ? ' pc-depgraph__node--plan' : ''
                  }${n.id === selectedId ? ' pc-depgraph__node--selected' : ''}`}
                  onClick={() => void setSelectedId(n.id)}
                >
                  {/* The full title, unabridged, for the truncated card below. An SVG <title>
                      CHILD is not the `title=` ATTRIBUTE the design-primitives lint blocks on
                      action elements — it is the standard accessible name for an SVG group,
                      and the planmark already uses it the same way. */}
                  <title>
                    {n.dangling
                      ? `${n.id} — unresolved blocker`
                      : `${n.id} — ${n.title} (${n.state}, depth ${n.depth})`}
                  </title>
                  <rect width={NODE_W} height={NODE_H} rx={6} />
                  {/* P-012: plan provenance as a left edge-marker rather than a fill or
                      border change. Fill is already spoken for by state and the border by
                      selection/dangling, so distinguishing plan items by either would
                      collide with a signal that is already load-bearing. A separate marker
                      composes with all of them, and stays legible on a small node. */}
                  {n.planSlug && (
                    <rect
                      className="pc-depgraph__node-planmark"
                      width={3}
                      height={NODE_H}
                      rx={1.5}
                    >
                      <title>{`from plan: ${n.planSlug}`}</title>
                    </rect>
                  )}
                  {/* P-006 — STATE ON THE NODE, as a dot rather than a fill or a border.
                      Both of those are already load-bearing here (fill = dangling, border =
                      selection), so colouring either by state would overwrite a signal that
                      is already carrying meaning. A dot composes with all of them and stays
                      legible at this size. Dangling nodes get none: a placeholder for a row
                      that does not exist has no state to report, and inventing one would be
                      asserting data we do not have. */}
                  {!n.dangling && (
                    <circle
                      className={`pc-depgraph__node-state pc-depgraph__node-state--${stateBucket(n.state)}`}
                      cx={NODE_W - 11}
                      cy={13}
                      r={3.5}
                    />
                  )}
                  {/* HIERARCHY (P-006): the TITLE is what a reader recognises, so it is the
                      prominent line; the id is the reference you look up, so it is the small
                      muted label above it. It was the other way round, which is part of why
                      the pane read as a grid of ids. */}
                  <text x={10} y={17} className="pc-depgraph__node-id">
                    {n.id}
                  </text>
                  <text x={10} y={34} className="pc-depgraph__node-title">
                    {n.title.length > TITLE_CHARS ? `${n.title.slice(0, TITLE_CHARS - 1)}…` : n.title}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

export { DEP_GRAPH_NODE_BUDGET };
