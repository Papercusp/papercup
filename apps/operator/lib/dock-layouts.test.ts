/**
 * Unit tests for dock-layouts pure logic (no PG calls).
 * Live PG round-trip is verified manually + via the API smoke from Phase 0.
 */

import { describe, expect, it } from 'vitest';
import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  LayoutValidationError,
  OPAQUE_SCHEMA_VERSION,
  defaultAdvHarnessesLayout,
  defaultDashboardLayout,
  defaultPiTerminalsLayout,
  validateLayoutDoc,
  type LayoutDoc,
} from './dock-layouts';

describe('dock-layouts validation', () => {
  it('accepts a valid LayoutDoc', () => {
    const doc: LayoutDoc = {
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      root: {
        kind: 'tabs',
        id: 'root',
        activePanelId: 'a',
        panels: [{ id: 'a', type: 'data:features' }],
      },
    };
    expect(() => validateLayoutDoc(doc)).not.toThrow();
  });

  it('rejects null', () => {
    expect(() => validateLayoutDoc(null)).toThrow(LayoutValidationError);
  });

  it('rejects unsupported schemaVersion', () => {
    expect(() =>
      validateLayoutDoc({ schemaVersion: 99, root: {} } as unknown),
    ).toThrow(/unsupported schemaVersion 99/);
  });

  it('accepts opaque schemaVersion 0 without structural validation', () => {
    // Opaque body bypasses LayoutDoc shape checks — used by pi-tab.
    const opaque = {
      schemaVersion: OPAQUE_SCHEMA_VERSION,
      // Pi-tab's actual dockview JSON has totally different structure.
      grid: { root: { type: 'branch', data: [] } },
      anything: 123,
    };
    expect(() => validateLayoutDoc(opaque)).not.toThrow();
  });

  it('rejects missing root', () => {
    expect(() =>
      validateLayoutDoc({ schemaVersion: 1 } as unknown),
    ).toThrow(/layout\.root required/);
  });

  it('rejects tabs with activePanelId not in panels', () => {
    const doc = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'r',
        activePanelId: 'missing',
        panels: [{ id: 'a', type: 'data:features' }],
      },
    };
    expect(() => validateLayoutDoc(doc)).toThrow(/activePanelId/);
  });

  it('rejects panel missing type', () => {
    const doc = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'r',
        activePanelId: 'a',
        panels: [{ id: 'a' }],
      },
    };
    expect(() => validateLayoutDoc(doc)).toThrow(/missing type/);
  });

  it('rejects group with non-array children', () => {
    const doc = {
      schemaVersion: 1,
      root: { kind: 'group', id: 'r', children: 'bad' },
    };
    expect(() => validateLayoutDoc(doc)).toThrow(/missing children/);
  });

  it('rejects floating with non-numeric coords', () => {
    const doc = {
      schemaVersion: 1,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'data:features' }] },
      floating: [{ id: 'f', x: 'no', y: 0, width: 100, height: 100, panels: [], activePanelId: 'a' }],
    };
    expect(() => validateLayoutDoc(doc)).toThrow(/bad x\/y/);
  });

  it('walks nested groups recursively', () => {
    const doc: LayoutDoc = {
      schemaVersion: 1,
      root: {
        kind: 'group',
        id: 'outer',
        direction: 'row',
        children: [
          {
            kind: 'group',
            id: 'inner',
            direction: 'col',
            children: [
              {
                kind: 'tabs',
                id: 't',
                activePanelId: 'a',
                panels: [{ id: 'a', type: 'data:features' }],
              },
            ],
          },
        ],
      },
    };
    expect(() => validateLayoutDoc(doc)).not.toThrow();
  });

  it('reports the bad inner panel in nested layout', () => {
    const doc = {
      schemaVersion: 1,
      root: {
        kind: 'group',
        id: 'outer',
        children: [
          {
            kind: 'tabs',
            id: 'inner',
            activePanelId: 'a',
            panels: [{ id: 'a' }], // missing type
          },
        ],
      },
    };
    expect(() => validateLayoutDoc(doc)).toThrow(/missing type/);
  });
});

describe('default seeds', () => {
  it('defaultDashboardLayout returns a valid LayoutDoc', () => {
    const seed = defaultDashboardLayout('sheets');
    expect(() => validateLayoutDoc(seed)).not.toThrow();
    expect(seed.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
    expect(seed.root.kind).toBe('group');
  });

  it('defaultDashboardLayout propagates harnessSlug to all panels', () => {
    const seed = defaultDashboardLayout('sheets');
    const seen: string[] = [];
    function walk(n: typeof seed.root): void {
      if (n.kind === 'tabs') {
        for (const p of n.panels) {
          if (p.params && 'harnessSlug' in p.params) {
            seen.push(p.params.harnessSlug as string);
          }
        }
      } else {
        for (const c of n.children) walk(c);
      }
    }
    walk(seed.root);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'sheets')).toBe(true);
  });

  it('defaultPiTerminalsLayout returns a valid LayoutDoc', () => {
    const seed = defaultPiTerminalsLayout();
    expect(() => validateLayoutDoc(seed)).not.toThrow();
    expect(seed.root.kind).toBe('tabs');
  });

  it('defaultDashboardLayout has unique panel ids', () => {
    const seed = defaultDashboardLayout('sheets');
    const ids: string[] = [];
    function walk(n: typeof seed.root): void {
      if (n.kind === 'tabs') {
        for (const p of n.panels) ids.push(p.id);
      } else {
        for (const c of n.children) walk(c);
      }
    }
    walk(seed.root);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaultAdvHarnessesLayout is the two-row Features|Issues-over-Detail shape', () => {
    const seed = defaultAdvHarnessesLayout('papercup');
    expect(() => validateLayoutDoc(seed)).not.toThrow();
    expect(seed.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
    // Root is a column: [ top row, detail ].
    expect(seed.root.kind).toBe('group');
    if (seed.root.kind !== 'group') throw new Error('root not a group');
    expect(seed.root.direction).toBe('col');
    expect(seed.root.children).toHaveLength(2);

    // Top: a row group containing Features (left) + Issues (right).
    const [topRow, detail] = seed.root.children;
    expect(topRow.kind).toBe('group');
    if (topRow.kind !== 'group') throw new Error('top not a group');
    expect(topRow.direction).toBe('row');
    const topTypes = topRow.children.map((c) => (c.kind === 'tabs' ? c.panels[0]?.type : null));
    expect(topTypes).toEqual(['adv:features', 'adv:issues']);

    // Bottom: Detail, full width.
    expect(detail.kind).toBe('tabs');
    if (detail.kind !== 'tabs') throw new Error('detail not tabs');
    expect(detail.panels[0]?.type).toBe('adv:detail');
  });

  it('defaultAdvHarnessesLayout propagates harnessSlug + has unique ids', () => {
    const seed = defaultAdvHarnessesLayout('papercup');
    const slugs: string[] = [];
    const ids: string[] = [];
    function walk(n: typeof seed.root): void {
      if (n.kind === 'tabs') {
        for (const p of n.panels) {
          ids.push(p.id);
          if (p.params && 'harnessSlug' in p.params) slugs.push(p.params.harnessSlug as string);
        }
      } else {
        for (const c of n.children) walk(c);
      }
    }
    walk(seed.root);
    expect(slugs).toEqual(['papercup', 'papercup', 'papercup']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
