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
} from '../../../lib/dock-layouts';

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
    };
  }

  function nodeToBranch(n: GroupNode | TabStrip): DvSerializedGridNode {
    if (n.kind === 'tabs') return leafFromTabs(n);
    const children = n.children.map(nodeToBranch);
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
    doc.root.kind === 'group' ? doc.root.direction ?? 'row' : 'row';

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
  const root = gridNodeToNode(dv.grid.root, dv.panels);
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
): GroupNode | TabStrip {
  if (n.type === 'leaf') {
    return {
      kind: 'tabs',
      id: n.data.id,
      activePanelId: n.data.activeView ?? n.data.views[0] ?? '',
      panels: n.data.views.map((id) => dvPanelToInstance(id, panels[id])),
    };
  }
  return {
    kind: 'group',
    id: cryptoId('g'),
    direction: 'row', // dockview branch nodes lose the orientation
                      // distinction in their JSON. The root carries it
                      // (we use grid.orientation); nested branches we
                      // default to 'row' — this is a v1 limitation.
    children: n.data.map((c) => gridNodeToNode(c, panels)),
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
