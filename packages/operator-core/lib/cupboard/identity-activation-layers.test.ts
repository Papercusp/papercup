/**
 * agent-economy-flywheel P-016 (D-012): which stack layers the activation gate
 * prices. Each stack entry's whole `extends` chain is walked, so a local layer
 * that extends a Cupboard-installed priced identity cannot load it for free.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';

const fixture = vi.hoisted(() => ({
  installed: '',
  local: '',
  active: new Map<string, { id: string; version: string }>(),
}));

vi.mock('../blueprint/installed-blueprints', async (importOriginal) => {
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    INSTALLED_BLUEPRINTS_DIR: () => fixture.installed,
    // project-local → installed, the same precedence as the operator resolver.
    operatorResolveExtends: () => (id: string) => {
      for (const root of [fixture.local, fixture.installed]) {
        const file = path.join(root, id, 'blueprint.yaml');
        if (existsSync(file)) return file;
      }
      return null;
    },
  };
});
vi.mock('../agent-identities/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localDirs: () => [],
}));
vi.mock('./blueprint-release', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readBlueprintLifecycle: async (_dir: string, id: string) => ({ active: fixture.active.get(id) ?? null, releases: [] }),
}));

const { resolveInstalledIdentityReleaseLayers } = await import('./identity-activation-gate-io');
const { identityReleaseSkuRef } = await import('./identity-per-use-offer');

const root = mkdtempSync(join(tmpdir(), 'identity-activation-layers-'));
fixture.installed = join(root, 'installed');
fixture.local = join(root, 'local');

function write(tier: 'installed' | 'local', doc: Record<string, unknown>): void {
  const dir = join(tier === 'installed' ? fixture.installed : fixture.local, String(doc.id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blueprint.yaml'), toYaml(doc), 'utf8');
}

// installed + released: paid (priced when the offers say so), base (its parent)
write('installed', { id: 'base', slots: [{ slot: 'domain' }] });
write('installed', { id: 'paid', extends: 'base', slots: [{ slot: 'domain' }] });
fixture.active.set('paid', { id: 'paid', version: '1.0.0' });
fixture.active.set('base', { id: 'base', version: '2.0.0' });
// installed WITHOUT a release record: never priced
write('installed', { id: 'hand-copied', slots: [{ slot: 'domain' }] });
// local layers
write('local', { id: 'wrapper', extends: 'paid', slots: [{ slot: 'domain' }] });
write('local', { id: 'plain', slots: [{ slot: 'domain' }] });
write('local', { id: 'diamond', extends: ['paid', 'base'], slots: [{ slot: 'domain' }] });
// a local layer that shadows an installed id resolves locally and is never priced
write('installed', { id: 'shadowed', slots: [{ slot: 'domain' }] });
write('local', { id: 'shadowed', slots: [{ slot: 'domain' }] });
fixture.active.set('shadowed', { id: 'shadowed', version: '1.0.0' });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const sku = (id: string, version: string) => identityReleaseSkuRef({ id, version });

describe('resolveInstalledIdentityReleaseLayers', () => {
  it('prices an installed release on the stack together with its installed parent', async () => {
    const layers = await resolveInstalledIdentityReleaseLayers(['domain:paid'], undefined);
    expect(layers.map((l) => [l.layerRef, l.skuRef])).toEqual([
      ['domain:paid', sku('base', '2.0.0')],
      ['domain:paid', sku('paid', '1.0.0')],
    ]);
  });

  it('prices a priced identity reached through a local layer’s extends, under that stack entry', async () => {
    const layers = await resolveInstalledIdentityReleaseLayers(['domain:wrapper'], undefined);
    expect(layers.map((l) => l.layerRef)).toEqual(['domain:wrapper', 'domain:wrapper']);
    expect(layers.map((l) => l.skuRef)).toContain(sku('paid', '1.0.0'));
  });

  it('charges each release once per stack entry through a diamond', async () => {
    const layers = await resolveInstalledIdentityReleaseLayers(['domain:diamond'], undefined);
    expect(layers.map((l) => l.skuRef).sort()).toEqual([sku('base', '2.0.0'), sku('paid', '1.0.0')].sort());
  });

  it('never prices local layers, shadowed ids, or installed copies without a release record', async () => {
    expect(await resolveInstalledIdentityReleaseLayers(['domain:plain'], undefined)).toEqual([]);
    expect(await resolveInstalledIdentityReleaseLayers(['domain:shadowed'], undefined)).toEqual([]);
    expect(await resolveInstalledIdentityReleaseLayers(['domain:hand-copied'], undefined)).toEqual([]);
  });

  it('skips stack refs no tier resolves, as the compiler would have refused them first', async () => {
    expect(await resolveInstalledIdentityReleaseLayers(['domain:nowhere'], undefined)).toEqual([]);
  });
});
