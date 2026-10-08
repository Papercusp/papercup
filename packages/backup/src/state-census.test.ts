import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStateCensusComplete, collectStateCensus, generateStateCensus, type CensusDeclaration } from './state-census';

const declaration: CensusDeclaration = {
  kind: 'path', root: 'app-home', name: 'hives', classification: 'state',
  producer: 'hive-store', descendants: true,
};

describe('producer-derived state census', () => {
  it('rejects non-canonical paths and empty producer identities', () => {
    for (const name of ['/outside', '../outside', 'hives/../outside', 'hives//project', 'hives\\project']) {
      expect(() => generateStateCensus([{ ...declaration, name }], [declaration]))
        .toThrow('Non-canonical census path');
    }
    expect(() => generateStateCensus([declaration], [{ ...declaration, producer: ' ' }]))
      .toThrow('Missing census producer');
  });
  it('keeps an explicit cache root in inventory while pruning its rebuildable contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await mkdir(join(root, 'cache'));
      await writeFile(join(root, 'cache', 'derived'), 'rebuildable');
      const census = await collectStateCensus({
        roots: [{ id: 'app-home', path: root }], readCatalogs: async () => [],
        declarations: [{ ...declaration, name: 'cache', classification: 'cache', prune: true }],
      });
      expect(census.ok).toBe(true);
      expect(census.inventory.map(entry => entry.name)).toEqual(['cache']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses pruning state, secrets or unowned subtree descendants', async () => {
    for (const invalid of [declaration, { ...declaration, classification: 'secret' as const },
      { ...declaration, classification: 'cache' as const, descendants: false }]) {
      await expect(collectStateCensus({ roots: [], readCatalogs: async () => [],
        declarations: [{ ...invalid, prune: true }],
      })).rejects.toThrow('explicitly owned rebuildable subtree');
    }
  });

  it('collects a real fixture and detects newly introduced unclassified paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await mkdir(join(root, 'hives'));
      await writeFile(join(root, 'hives', 'project'), 'state');
      const read = () => collectStateCensus({
        roots: [{ id: 'app-home', path: root }], declarations: [declaration],
        readCatalogs: async () => [],
      });
      expect((await read()).ok).toBe(true);
      await writeFile(join(root, 'unknown'), 'new state');
      const changed = await read();
      expect(() => assertStateCensusComplete(changed)).toThrow('unknown');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('inventories symlinks without traversing outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await symlink(root, join(root, 'cycle'));
      const census = await collectStateCensus({
        roots: [{ id: 'app-home', path: root }], declarations: [],
        readCatalogs: async () => [],
      });
      expect(census.inventory.map(entry => entry.name)).toEqual(['cycle']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects unreadable inventory and catalog sources instead of certifying an empty census', async () => {
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => { throw new Error('catalog unavailable'); },
    })).rejects.toThrow('catalog unavailable');
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await expect(collectStateCensus({ roots: [{ id: 'home', path: join(root, 'missing') }],
        declarations: [], readCatalogs: async () => [],
      })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails drift verification when a new path has no producer declaration', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'app-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'new-state' },
    ], [declaration]);
    expect(census.residue).toHaveLength(1);
    expect(() => assertStateCensusComplete(census)).toThrow('unclassified:path:app-home:new-state');
  });

  it('does not conflate roots or directory-name prefixes', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'config-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'hives-old/project' },
    ], [declaration]);
    expect(census.residue).toHaveLength(2);
  });

  it('fails on conflicting declarations instead of choosing the first', () => {
    const census = generateStateCensus([declaration], [declaration,
      { ...declaration, classification: 'cache', producer: 'other' }]);
    expect(census.inventory[0].classification).toBeNull();
    expect(() => assertStateCensusComplete(census)).toThrow('conflicting');
  });

  it('covers each non-path entry only by exact producer identity', () => {
    const entries: CensusDeclaration[] = ['database', 'unit', 'secret'].map(kind => ({
      kind: kind as CensusDeclaration['kind'], root: 'host', name: kind,
      classification: kind === 'secret' ? 'secret' : 'state', producer: kind,
    }));
    const census = generateStateCensus(entries, entries);
    expect(census.ok).toBe(true);
    expect(() => assertStateCensusComplete(census)).not.toThrow();
  });
});
