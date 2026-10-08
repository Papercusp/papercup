import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStateCensusComplete, collectStateCensus, generateStateCensus, backupCacheCensusDeclarations, databaseCensusSnapshotCoverage, type CensusDeclaration } from './state-census';

const declaration: CensusDeclaration = {
  kind: 'path', root: 'app-home', name: 'hives', classification: 'state',
  producer: 'hive-store', descendants: true,
};

describe('producer-derived state census', () => {
  it('represents measured database storage as preserved state, not a disposable cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-census-'));
    try {
      await mkdir(join(root, 'pg'));
      await writeFile(join(root, 'pg', 'binary-storage'), 'fixture');
      const census = await collectStateCensus({ roots: [{ id: 'home', path: root }],
        declarations: [{ kind: 'path', root: 'home', name: 'pg', classification: 'state', producer: 'postgres',
          descendants: true, databaseStorage: { systemIdentifier: '123', evidenceRef: 'fixture:pg-control' } }],
        maxEntries: 1, readCatalogs: async () => [],
      });
      expect(census.ok).toBe(true);
      expect(census.representedStorage[0]).toMatchObject({ name: 'pg', disposition: 'preserve-state-subtree' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps snapshot evidence fail-closed and separate from ownership classification', () => {
    const entries = [{ kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' }];
    const report = databaseCensusSnapshotCoverage({ entries, systemIdentifier: '123', status: null, nowEpoch: 1000 });
    expect(report[0].coverage.covered).toBe(false);
    expect(generateStateCensus(entries, []).ok).toBe(false);
    expect(databaseCensusSnapshotCoverage({ entries, systemIdentifier: '456',
      status: { ok: true, systemIdentifier: '456', lastSuccessEpoch: 1000, dumped: ['app'] }, nowEpoch: 1000,
    })[0].coverage.covered).toBe(false);
  });
  it('fails closed on entry limits rather than certifying a truncated inventory', async () => {
    const entries = [declaration, { ...declaration, name: 'other' }];
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => entries, maxEntries: 1,
    })).rejects.toThrow('entry bound exceeded');
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => [], maxEntries: 0,
    })).rejects.toThrow('Invalid census entry bound');
  });
  it('derives rebuildable caches but never backup-repository or recovery-debris classification from ignores', () => {
    const declarations = backupCacheCensusDeclarations('home');
    const census = generateStateCensus(['node_modules/pkg', 'projects/a/node_modules/pkg', 'projects/node_modules-old', 'backups', '.broken-old'].map(name =>
      ({ kind: 'path' as const, root: 'home', name })), declarations);
    expect(census.inventory.find(entry => entry.name === 'node_modules/pkg')?.classification).toBe('cache');
    expect(census.inventory.find(entry => entry.name === 'projects/a/node_modules/pkg')?.classification).toBe('cache');
    expect(census.residue.map(entry => entry.name).sort()).toEqual(['.broken-old', 'backups', 'projects/node_modules-old']);
  });
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
      await expect(collectStateCensus({ roots: [{ id: 'fixture-root', path: root }],
        declarations: [], readCatalogs: async () => [], maxEntries: 1,
      })).rejects.toThrow(/root=fixture-root; path=/);
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
