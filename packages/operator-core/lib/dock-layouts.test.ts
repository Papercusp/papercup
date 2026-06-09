/**
 * Unit tests for dock-layouts pure logic (no PG calls).
 * Live PG round-trip is verified manually + via the API smoke from Phase 0.
 */

import { describe, expect, it } from 'vitest';
import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  LayoutValidationError,
  OPAQUE_SCHEMA_VERSION,
  defaultAdvCreateLayout,
  defaultAdvGitLayout,
  defaultAdvHarnessesLayout,
  defaultDashboardLayout,
  defaultPiTerminalsLayout,
  defaultWorkbenchLayout,
  isWellFormedLayout,
  seedForDockName,
  validateLayoutDoc,
  type LayoutDoc,
  type PanelInstance,
} from './dock-layouts';

/** Collect every panel in a layout tree (depth-first). */
function allPanels(doc: LayoutDoc): PanelInstance[] {
  const out: PanelInstance[] = [];
  const walk = (n: LayoutDoc['root']) => {
    if (n.kind === 'tabs') out.push(...n.panels);
    else for (const c of n.children) walk(c);
  };
  walk(doc.root);
  return out;
}

describe('defaultWorkbenchLayout (native-terminal-desktop-2026-06-06 — terminal is a native sibling, not a pane)', () => {
  it('is a well-formed 2-pane layout', () => {
    const doc = defaultWorkbenchLayout();
    expect(isWellFormedLayout(doc)).toBe(true);
    expect(doc.root.kind).toBe('group');
    const root = doc.root as Extract<LayoutDoc['root'], { kind: 'group' }>;
    expect(root.direction).toBe('row');
    expect(root.children).toHaveLength(2);
  });

  it('has exactly the app · voice · hives GUI panes (pui/terminal retired to a native sibling window, D-002/D-008)', () => {
    const types = allPanels(defaultWorkbenchLayout()).map((p) => p.type);
    // hive-directory rides as a second TAB in the voice pane (p2p-hive-directory
    // P-007) — without a seed entry the registered panel type is unreachable.
    expect(types).toEqual(['workbench:app', 'workbench:voice', 'workbench:hive-directory']);
    // The retired operator-chat pane must NOT be present.
    expect(types).not.toContain('workbench:operator');
    expect(types).not.toContain('data:chat');
  });

  // GUARD (native-terminal-desktop P-009): the desktop terminal is a NATIVE
  // sibling window, never a webview pane. No xterm.js / iframe-/pi terminal pane
  // may be reintroduced into the workbench seed.
  it('GUARD: seeds NO terminal pane (no xterm.js terminal as a dockview pane)', () => {
    const banned = ['workbench:pui', 'data:pi', 'workbench:terminal', 'data:terminal'];
    for (const slug of ['', 'papercup', 'workbench', 'workbench:demo']) {
      const doc = slug.startsWith('workbench') ? seedForDockName(slug) : defaultWorkbenchLayout(slug);
      const types = allPanels(doc).map((p) => p.type);
      for (const b of banned) {
        expect(types, `seed "${slug}" must not contain ${b}`).not.toContain(b);
      }
    }
  });

  it('bakes the app pane src to /adv and routes harnessSlug to voice', () => {
    const doc = defaultWorkbenchLayout('papercup');
    const byType = (t: string) => allPanels(doc).find((p) => p.type === t)!;
    expect(byType('workbench:app').params?.src).toBe('/adv');
    expect(byType('workbench:voice').params?.harnessSlug).toBe('papercup');
    // The /adv app pane self-manages its harness, so it carries no slug.
    expect(byType('workbench:app').params?.harnessSlug).toBeUndefined();
  });

  it('seedForDockName routes "workbench" to the workbench seed, not the dashboard', () => {
    const seeded = seedForDockName('workbench');
    expect(allPanels(seeded).map((p) => p.type)).toContain('workbench:app');
    // A "workbench:<slug>" name bakes the slug into the voice pane.
    const withSlug = seedForDockName('workbench:demo');
    const voice = allPanels(withSlug).find((p) => p.type === 'workbench:voice')!;
    expect(voice.params?.harnessSlug).toBe('demo');
  });
});

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

describe('isWellFormedLayout (non-throwing guard for the render path)', () => {
  const validDoc: LayoutDoc = {
    schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
    root: {
      kind: 'tabs',
      id: 'root',
      activePanelId: 'a',
      panels: [{ id: 'a', type: 'data:features' }],
    },
  };

  it('accepts a well-formed v1 layout', () => {
    expect(isWellFormedLayout(validDoc)).toBe(true);
  });

  it('accepts every default seed', () => {
    expect(isWellFormedLayout(defaultDashboardLayout('papercup'))).toBe(true);
    expect(isWellFormedLayout(defaultAdvHarnessesLayout('papercup'))).toBe(true);
    expect(isWellFormedLayout(defaultAdvGitLayout('papercup'))).toBe(true);
    expect(isWellFormedLayout(defaultAdvCreateLayout())).toBe(true);
    expect(isWellFormedLayout(defaultPiTerminalsLayout())).toBe(true);
  });

  it('defaultAdvCreateLayout seeds the two fixed regions (filter | main)', () => {
    const doc = defaultAdvCreateLayout();
    expect(() => validateLayoutDoc(doc)).not.toThrow();
    const types = JSON.stringify(doc);
    for (const t of ['create:filter', 'create:main']) {
      expect(types).toContain(t);
    }
  });

  // The exact corruption that crashed /adv: a v1 body whose `root` is null.
  it('rejects a v1 body with a null root', () => {
    expect(isWellFormedLayout({ schemaVersion: 1, root: null })).toBe(false);
  });

  it('rejects a v1 body with no root key', () => {
    expect(isWellFormedLayout({ schemaVersion: 1 })).toBe(false);
  });

  it('rejects a layout with a null node inside children', () => {
    expect(
      isWellFormedLayout({
        schemaVersion: 1,
        root: { kind: 'group', id: 'g', children: [null] },
      }),
    ).toBe(false);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(isWellFormedLayout(null)).toBe(false);
    expect(isWellFormedLayout(undefined)).toBe(false);
    expect(isWellFormedLayout('nope')).toBe(false);
    expect(isWellFormedLayout(42)).toBe(false);
  });

  it('rejects an opaque (v0) body — no structural guarantee for the render path', () => {
    expect(isWellFormedLayout({ schemaVersion: OPAQUE_SCHEMA_VERSION, blob: 1 })).toBe(false);
  });

  it('rejects an unknown schemaVersion', () => {
    expect(isWellFormedLayout({ schemaVersion: 99, root: validDoc.root })).toBe(false);
  });

  it('narrows the type (predicate) when true', () => {
    const maybe: unknown = validDoc;
    if (isWellFormedLayout(maybe)) {
      // Type-level assertion: maybe is LayoutDoc here.
      expect(maybe.root.kind).toBe('tabs');
    } else {
      throw new Error('expected well-formed');
    }
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

// Regression guard for the seed/reset drift that prompted extracting this
// helper: adv-create was wired into getLayout's read-miss seed but missing
// from resetLayout, so a hard reset silently reseeded the Create dock to the
// dashboard layout. getLayout + resetLayout now both delegate here, so these
// assertions cover both paths at once. (Pi is handled by each caller, not
// here — see seedForDockName's doc-comment.)
describe('seedForDockName (shared seed/reset routing)', () => {
  it('routes adv-create2 (exact + prefixed) to the create seed', () => {
    expect(seedForDockName('adv-create2')).toEqual(defaultAdvCreateLayout());
    expect(seedForDockName('adv-create2:papercup')).toEqual(defaultAdvCreateLayout());
  });
  it('routes adv-git2 to the git seed, propagating the slug', () => {
    expect(seedForDockName('adv-git2')).toEqual(defaultAdvGitLayout(''));
    expect(seedForDockName('adv-git2:papercup')).toEqual(defaultAdvGitLayout('papercup'));
  });
  it('routes adv-harnesses to the harnesses seed, propagating the slug', () => {
    expect(seedForDockName('adv-harnesses')).toEqual(defaultAdvHarnessesLayout(''));
    expect(seedForDockName('adv-harnesses:papercup')).toEqual(
      defaultAdvHarnessesLayout('papercup'),
    );
  });
  it('falls back to the dashboard seed for dashboard:/default/unknown names', () => {
    expect(seedForDockName('dashboard:papercup')).toEqual(defaultDashboardLayout('papercup'));
    expect(seedForDockName('default')).toEqual(defaultDashboardLayout(''));
    expect(seedForDockName('something-unknown')).toEqual(defaultDashboardLayout(''));
  });
});
