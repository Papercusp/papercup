import { describe, expect, it } from 'vitest';
import { defaultDashboardLayout, validateLayoutDoc, type LayoutDoc } from '@papercusp/operator-core/lib/dock-layouts';
import { roundTrip, toDockviewJson, toLayoutDoc } from './layout-adapter';

describe('layout-adapter', () => {
  it('round-trips a tab-only layout preserving panel ids and types', () => {
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'r',
        activePanelId: 'b',
        panels: [
          { id: 'a', type: 'data:features', params: { slug: 'sheets' } },
          { id: 'b', type: 'data:issues' },
        ],
      },
    };
    const back = roundTrip(doc);
    expect(back.schemaVersion).toBe(1);
    expect(back.root.kind).toBe('tabs');
    if (back.root.kind === 'tabs') {
      expect(back.root.id).toBe('r');
      expect(back.root.activePanelId).toBe('b');
      expect(back.root.panels.map((p) => p.id)).toEqual(['a', 'b']);
      expect(back.root.panels.map((p) => p.type)).toEqual(['data:features', 'data:issues']);
      expect(back.root.panels[0].params).toEqual({ slug: 'sheets' });
    }
  });

  it('round-trips the default dashboard layout (classic-mirroring shape)', () => {
    const doc = defaultDashboardLayout('sheets');
    const back = roundTrip(doc);
    // Top-level is git rail + main-stack = 2 children.
    expect(back.root.kind).toBe('group');
    if (back.root.kind === 'group') {
      expect(back.root.children.length).toBe(2);
    }
    // Validate the round-trip is itself a legal layout
    expect(() => validateLayoutDoc(back)).not.toThrow();
  });

  it('preserves panel params across round-trip', () => {
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'r',
        activePanelId: 'a',
        panels: [{ id: 'a', type: 'view:harness-overview', params: { harnessSlug: 'sheets', phase: 'testing' } }],
      },
    };
    const back = roundTrip(doc);
    if (back.root.kind === 'tabs') {
      expect(back.root.panels[0].params).toEqual({ harnessSlug: 'sheets', phase: 'testing' });
    }
  });

  it('handles empty/missing floating array', () => {
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'x' }] },
    };
    const dv = toDockviewJson(doc);
    expect(dv.floatingGroups).toBeUndefined();
    const back = toLayoutDoc(dv);
    expect(back.floating).toBeUndefined();
  });

  it('serializes floating groups', () => {
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'x' }] },
      floating: [
        {
          id: 'fg1',
          x: 100,
          y: 50,
          width: 480,
          height: 360,
          activePanelId: 'b',
          panels: [{ id: 'b', type: 'view:vscode' }],
        },
      ],
    };
    const dv = toDockviewJson(doc);
    expect(dv.floatingGroups?.length).toBe(1);
    expect(dv.floatingGroups?.[0].position).toEqual({ left: 100, top: 50, width: 480, height: 360 });
    expect(dv.panels['b']).toBeDefined();
    expect(dv.panels['b'].contentComponent).toBe('view:vscode');
    const back = toLayoutDoc(dv);
    expect(back.floating?.[0]).toMatchObject({ id: 'fg1', x: 100, y: 50, width: 480, height: 360 });
  });

  it('handles orphaned panel id in dockview JSON without throwing', () => {
    // Simulates: layout references panel `lost` but the panels map is missing it.
    const dv = {
      grid: {
        orientation: 'HORIZONTAL' as const,
        height: 0,
        width: 0,
        root: {
          type: 'leaf' as const,
          data: { views: ['lost'], activeView: 'lost', id: 'r' },
        },
      },
      panels: {},
    };
    const back = toLayoutDoc(dv);
    if (back.root.kind === 'tabs') {
      expect(back.root.panels[0].type).toBe('__missing__');
    }
  });

  it('preserves nested branch direction on round-trip (alternating depth)', () => {
    // row → col → row → col …
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'group',
        id: 'lvl0',
        direction: 'row',
        children: [
          {
            kind: 'group',
            id: 'lvl1',
            direction: 'col',
            children: [
              {
                kind: 'group',
                id: 'lvl2',
                direction: 'row',
                children: [
                  {
                    kind: 'tabs',
                    id: 't',
                    activePanelId: 'a',
                    panels: [{ id: 'a', type: 'x' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const back = roundTrip(doc);
    expect(back.root.kind).toBe('group');
    if (back.root.kind === 'group') {
      expect(back.root.direction).toBe('row');
      const inner1 = back.root.children[0];
      expect(inner1.kind).toBe('group');
      if (inner1.kind === 'group') {
        expect(inner1.direction).toBe('col');
        const inner2 = inner1.children[0];
        if (inner2.kind === 'group') {
          expect(inner2.direction).toBe('row');
        }
      }
    }
  });

  it('preserves leaf (tabs) size across round-trip — the /adv harness 3-panel split', () => {
    // Regression: toLayoutDoc previously dropped leaf size, so a seeded
    // 400/400/800 (=25/25/50) split persisted with no per-pane size and
    // reloaded with the first two panes at min-width (100px). Mirrors
    // defaultAdvHarnessesLayout's shape.
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'group',
        id: 'root',
        direction: 'row',
        children: [
          { kind: 'tabs', id: 'features-cell', size: 400, activePanelId: 'f', panels: [{ id: 'f', type: 'adv:features' }] },
          { kind: 'tabs', id: 'issues-cell', size: 400, activePanelId: 'i', panels: [{ id: 'i', type: 'adv:issues' }] },
          { kind: 'tabs', id: 'detail-cell', size: 800, activePanelId: 'd', panels: [{ id: 'd', type: 'adv:detail' }] },
        ],
      },
    };
    const back = roundTrip(doc);
    expect(back.root.kind).toBe('group');
    if (back.root.kind === 'group') {
      const sizes = back.root.children.map((c) => c.size);
      expect(sizes).toEqual([400, 400, 800]);
    }
  });

  it('builds a usable dockview JSON for the dashboard seed', () => {
    const doc = defaultDashboardLayout('sheets');
    const dv = toDockviewJson(doc);
    expect(dv.grid.root.type).toBe('branch');
    // All panels referenced in leaves must exist in dv.panels
    const referenced: string[] = [];
    function collectLeafIds(n: typeof dv.grid.root): void {
      if (n.type === 'leaf') {
        referenced.push(...n.data.views);
      } else {
        for (const c of n.data) collectLeafIds(c);
      }
    }
    collectLeafIds(dv.grid.root);
    for (const id of referenced) {
      expect(dv.panels[id]).toBeDefined();
    }
  });
});
