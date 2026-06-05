/**
 * Adapter between LayoutDoc (our stored logical schema) and dockview's
 * native serialization shape. Used by HarnessDock on mount (LayoutDoc →
 * dockview JSON via api.fromJSON) and on save (dockview.toJSON →
 * LayoutDoc via toLayoutDoc).
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4.4
 *
 * Why an adapter at all (not store raw dockview JSON):
 *   - Schema versioning is ours, not dockview's
 *   - Validation at the boundary
 *   - Programmatic seeds (defaultDashboardLayout) are easier with the
 *     simpler logical shape
 *   - Decoupled from dockview's internal API churn
 */

import type {
  LayoutDoc,
  GroupNode,
  TabStrip,
  PanelInstance,
} from '@papercusp/operator-core/lib/dock-layouts';

// ───────── Dockview wire shape (minimal, as documented in dockview v6) ─────────
// Refs:
//   - dockview-core/src/dockview/dockview.ts (SerializedDockview shape)
// We only model the subset we need; extra fields pass through.

type DvSerializedPanel = {
  id: string;
  contentComponent: string;
  title?: string;
  params?: Record<string, unknown>;
  // dockview uses an internal `tabComponent` too — we leave it default.
};

type DvSerializedGridLeaf = {
  type: 'leaf';
  data: {
    views: string[];           // panel ids
    activeView?: string;       // panel id
    id: string;                // group id
  };
  size?: number;
};

type DvSerializedGridBranch = {
  type: 'branch';
  data: DvSerializedGridNode[];
  size?: number;
};

type DvSerializedGridNode = DvSerializedGridLeaf | DvSerializedGridBranch;

type DvSerializedGrid = {
  root: DvSerializedGridNode;
  height: number;
  width: number;
  orientation: 'HORIZONTAL' | 'VERTICAL';
};

type DvSerializedFloatingGroup = {
  data: DvSerializedGridLeaf;     // floating groups are always leaves
  position: { left: number; top: number; width: number; height: number };
};

export type DockviewLayout = {
  grid: DvSerializedGrid;
  panels: Record<string, DvSerializedPanel>;
  activeGroup?: string;
  floatingGroups?: DvSerializedFloatingGroup[];
};

// ───────── LayoutDoc → dockview ─────────

export function toDockviewJson(doc: LayoutDoc): DockviewLayout {
  const panels: Record<string, DvSerializedPanel> = {};

  // Walk the tree, collect panels, build the grid.
  function leafFromTabs(t: TabStrip): DvSerializedGridLeaf {
    for (const p of t.panels) {
      panels[p.id] = panelToDv(p);
    }
    return {
      type: 'leaf',
      data: {
        views: t.panels.map((p) => p.id),
        activeView: t.activePanelId,
        id: t.id,
      },
      // Preserve the seed's proportional size. dockview emits `size` on
      // leaves when it serializes (toLayoutDoc reads it back), so dropping
      // it here made the round-trip asymmetric: a seed where two sibling
      // tabs-leaves each declare size 0.5 rendered as min-width + remainder
      // instead of 50/50. Carrying size through fixes the first-render
      // proportions for any leaf-level split (e.g. /adv/harnesses).
      size: t.size,
    };
  }

  function nodeToBranch(n: GroupNode | TabStrip | null | undefined): DvSerializedGridNode {
    // Defensive: a malformed node yields an empty branch instead of throwing
    // (`n.kind` on undefined). Callers pass a validated LayoutDoc, but this is
    // the other render-path walker that touches `.kind`, so guard it too.
    if (!n) return { type: 'branch', data: [] };
    if (n.kind === 'tabs') return leafFromTabs(n);
    const children = (n.children ?? []).map(nodeToBranch);
    return {
      type: 'branch',
      data: children,
      size: n.size,
    };
  }

  const rootNode = nodeToBranch(doc.root);
  // dockview's grid orientation: if the root group is 'col', the top-level
  // orientation is VERTICAL (children stack vertically); 'row' = HORIZONTAL.
  const rootDir =
    doc.root?.kind === 'group' ? doc.root.direction ?? 'row' : 'row';

  const floatingGroups: DvSerializedFloatingGroup[] = (doc.floating ?? []).map((f) => {
    const leaf: DvSerializedGridLeaf = {
      type: 'leaf',
      data: {
        views: f.panels.map((p) => p.id),
        activeView: f.activePanelId,
        id: f.id,
      },
    };
    for (const p of f.panels) panels[p.id] = panelToDv(p);
    return {
      data: leaf,
      position: { left: f.x, top: f.y, width: f.width, height: f.height },
    };
  });

  return {
    grid: {
      root: rootNode,
      orientation: rootDir === 'col' ? 'VERTICAL' : 'HORIZONTAL',
      // height/width are dockview internals — set to 0 here; dockview
      // overrides them on mount based on the container size.
      height: 0,
      width: 0,
    },
    panels,
    floatingGroups: floatingGroups.length > 0 ? floatingGroups : undefined,
  };
}

function panelToDv(p: PanelInstance): DvSerializedPanel {
  return {
    id: p.id,
    contentComponent: p.type,
    title: p.title,
    params: p.params,
  };
}

// ───────── dockview → LayoutDoc ─────────

export function toLayoutDoc(dv: DockviewLayout): LayoutDoc {
  // Dockview's gridview alternates orientation at each branch depth: if
  // the root is HORIZONTAL (=row), level-0 children stack horizontally;
  // a branch within stacks vertically (perpendicular); deeper branches
  // alternate again. We reverse that walk to recover direction per node.
  const rootDir: 'row' | 'col' = dv.grid.orientation === 'VERTICAL' ? 'col' : 'row';
  const root = gridNodeToNode(dv.grid.root, dv.panels, rootDir);
  const floating = (dv.floatingGroups ?? []).map((fg) => ({
    id: fg.data.data.id,
    x: fg.position.left,
    y: fg.position.top,
    width: fg.position.width,
    height: fg.position.height,
    panels: fg.data.data.views.map((id) => dvPanelToInstance(id, dv.panels[id])),
    activePanelId: fg.data.data.activeView ?? fg.data.data.views[0] ?? '',
  }));
  return {
    schemaVersion: 1,
    root,
    floating: floating.length > 0 ? floating : undefined,
  };
}

function gridNodeToNode(
  n: DvSerializedGridNode,
  panels: Record<string, DvSerializedPanel>,
  currentDir: 'row' | 'col',
): GroupNode | TabStrip {
  if (n.type === 'leaf') {
    return {
      kind: 'tabs',
      id: n.data.id,
      activePanelId: n.data.activeView ?? n.data.views[0] ?? '',
      panels: n.data.views.map((id) => dvPanelToInstance(id, panels[id])),
      // Carry the leaf size back through the save path. toDockviewJson's
      // leafFromTabs emits `size` (the forward direction, fixed in 26fac5cd),
      // but this reverse direction previously dropped it — so dockview.toJSON
      // → toLayoutDoc → persist lost every per-pane width, and the next load
      // gave the first sibling leaves min-width (100px) + remainder to the
      // last. Capturing it here makes the round-trip symmetric so a seeded
      // 25/25/50 split (e.g. /adv harness Features/Issues/Detail) survives a
      // save/reload instead of collapsing.
      size: n.size,
    };
  }
  const childDir: 'row' | 'col' = currentDir === 'row' ? 'col' : 'row';
  return {
    kind: 'group',
    id: cryptoId('g'),
    direction: currentDir,
    children: n.data.map((c) => gridNodeToNode(c, panels, childDir)),
    size: n.size,
  };
}

function dvPanelToInstance(
  id: string,
  p: DvSerializedPanel | undefined,
): PanelInstance {
  if (!p) {
    return { id, type: '__missing__', params: { __orphan: true } };
  }
  return {
    id: p.id,
    type: p.contentComponent,
    title: p.title,
    params: p.params,
  };
}

function cryptoId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}-${(crypto as Crypto).randomUUID().slice(0, 8)}`;
    }
  } catch {}
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ───────── Round-trip helper for tests ─────────

export function roundTrip(doc: LayoutDoc): LayoutDoc {
  return toLayoutDoc(toDockviewJson(doc));
}
