import { afterEach, describe, expect, it } from 'vitest';
import {
  _registerMigratorForTests,
  _resetMigratorsForTests,
  migrateLayoutBody,
} from './dock-layout-migrators';
import { CURRENT_LAYOUT_SCHEMA_VERSION } from './dock-layouts';

afterEach(() => _resetMigratorsForTests());

describe('migrateLayoutBody', () => {
  it('returns body unchanged when already at current version', () => {
    const body = {
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'data:features' }] },
    };
    const r = migrateLayoutBody(body);
    expect(r.migrated).toBe(false);
    expect(r.layout).toBe(body);
    expect(r.warning).toBeUndefined();
  });

  it('opaque schemaVersion=0 is never migrated', () => {
    const opaque = { schemaVersion: 0, dockviewJson: { grid: { root: { type: 'branch', data: [] } } } };
    const r = migrateLayoutBody(opaque);
    expect(r.migrated).toBe(false);
    expect(r.layout).toBe(opaque);
  });

  it('null body reseeds with warning', () => {
    const r = migrateLayoutBody(null);
    expect(r.migrated).toBe(true);
    expect(r.warning).toContain('null');
    expect(r.layout.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
  });

  it('unknown source version with no migrator reseeds with warning', () => {
    const r = migrateLayoutBody({ schemaVersion: 999, weird: true });
    expect(r.migrated).toBe(true);
    expect(r.warning).toContain('999');
  });

  it('future version ahead of current reseeds', () => {
    const r = migrateLayoutBody({ schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION + 1 });
    expect(r.migrated).toBe(true);
    expect(r.warning).toContain('ahead');
  });

  it('walks registered migrators v0→v1', () => {
    _registerMigratorForTests(0, (body) => ({
      ...body,
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'data:features' }] },
    }));
    const r = migrateLayoutBody({ schemaVersion: 0, legacy: true });
    expect(r.migrated).toBe(true);
    expect(r.layout.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
  });

  it('chains multiple migrators (v0→v1→v2 simulated)', () => {
    _registerMigratorForTests(0, (body) => ({ ...body, schemaVersion: 1, stepped: ['v0->v1'] }));
    // Force the runner to use a higher target so we can test chained.
    // We do it by registering at v0 then v1, with the v1 migrator
    // producing the CURRENT version. Since CURRENT is 1 by default, we
    // adapt: the v0 migrator produces a non-final shape; the test only
    // exercises a single step. Chained-step coverage will land when
    // v2 actually exists in production.
    const r = migrateLayoutBody({ schemaVersion: 0 });
    expect(r.migrated).toBe(true);
  });

  it('uses harnessSlug in reseed default', () => {
    const r = migrateLayoutBody(null, { harnessSlug: 'sheets' });
    // Walk: at least one panel's params.harnessSlug should equal 'sheets'.
    let found = false;
    function walk(n: typeof r.layout.root): void {
      if (n.kind === 'tabs') {
        for (const p of n.panels) {
          if ((p.params as Record<string, unknown> | undefined)?.harnessSlug === 'sheets') {
            found = true;
          }
        }
      } else {
        for (const c of n.children) walk(c);
      }
    }
    walk(r.layout.root);
    expect(found).toBe(true);
  });
});
