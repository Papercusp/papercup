import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db-encryption', () => ({ dbEncryptionKeyFilePath: () => '/mounted/secrets/db-key' }));
vi.mock('../superuser-token', () => ({ superuserTokenPath: () => '/scoped/home/superuser-token' }));
vi.mock('../workspace-registry', () => ({
  workspacesRoot: () => '/relocated/workspaces',
  readRegistry: () => ({ workspaces: [{ id: 'registered-project' }] }),
}));
vi.mock('../scratch-uri', () => ({ scratchRoot: () => '/relocated/cache/spills' }));
import { databaseCensusEntries, secretCensusProducers, unitCensusEntries, unitCensusDeclarations, verifyHostStateCensus, workspaceRegistryCensusProducer, scratchCensusProducer } from './state-census-producers';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import type { Sql } from 'postgres';

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('derives scratch cache ownership from the relocated writer root', () => {
    const result = scratchCensusProducer();
    expect(result.roots[0].path).toBe('/relocated/cache');
    expect(result.declarations[0]).toMatchObject({ name: 'spills', classification: 'cache', prune: true });
  });
  it('derives unit classification from installer sources, not installed-unit observations', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-producer-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]');
      await symlink('/dev/null', join(path, 'masked.service'));
      await writeFile(join(path, 'data.mount'), '[Mount]');
      await writeFile(join(path, 'README.md'), 'not a unit');
      const declarations = await unitCensusDeclarations(path, 'user');
      expect(declarations.map(entry => entry.name).sort()).toEqual(['app.service', 'data.mount', 'masked.service']);
      expect(declarations[0].classification).toBe('config');
      expect(declarations[0].producer).toBe(`unit-definition:${path}`);
      expect((await unitCensusDeclarations(path, 'user', 'dev-only'))[0].classification).toBe('dev-only');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('uses the registry writer root without blanket-classifying sibling workspaces', () => {
    const producer = workspaceRegistryCensusProducer();
    expect(producer.roots).toEqual([{ id: 'workspace-registry', path: '/relocated/workspaces' }]);
    expect(producer.declarations).toEqual([{
      kind: 'path', root: 'workspace-registry', name: 'registry.json',
      classification: 'config', producer: 'workspace-registry',
    }, {
      kind: 'path', root: 'workspace-registry', name: 'registered-project',
      classification: 'state', producer: 'workspace-registry',
    }]);
  });
  it('verifies filesystem and all catalogs together and fails on a new host entry', async () => {
    const path = await mkdtemp(join(tmpdir(), 'host-census-'));
    try {
      await writeFile(join(path, 'config'), 'fixture');
      const declarations: CensusDeclaration[] = [
        { kind: 'path', root: 'home', name: 'config', classification: 'config', producer: 'fixture' },
        { kind: 'database', root: 'cluster', name: 'db', classification: 'state', producer: 'fixture' },
        { kind: 'unit', root: 'systemd-user', name: 'app.service', classification: 'config', producer: 'fixture' },
        { kind: 'secret', root: 'vault', name: 'key', classification: 'secret', producer: 'fixture' },
      ];
      const input = { roots: [{ id: 'home', path }], declarations,
        readDatabases: async () => declarations.filter(entry => entry.kind === 'database'),
        readUnits: async () => declarations.filter(entry => entry.kind === 'unit'),
        readSecrets: async () => declarations.filter(entry => entry.kind === 'secret'),
      };
      expect((await verifyHostStateCensus(input)).inventory).toHaveLength(4);
      await writeFile(join(path, 'unowned'), 'new state');
      await expect(verifyHostStateCensus(input)).rejects.toThrow('unclassified:path:home:unowned');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('inventories disabled installed units and distinguishes system/user scopes', async () => {
    const read = async () => '[{"unit_file":"backup.service","state":"disabled"}]';
    expect(await unitCensusEntries('user', read)).toEqual([
      { kind: 'unit', root: 'systemd-user', name: 'backup.service' },
    ]);
    expect((await unitCensusEntries('system', read))[0].root).toBe('systemd-system');
  });
  it('rejects malformed or failed unit catalogs instead of treating them as empty', async () => {
    for (const body of ['{}', '[{}]', 'not-json']) {
      await expect(unitCensusEntries('user', async () => body)).rejects.toThrow();
    }
    await expect(unitCensusEntries('user', async () => { throw new Error('systemd unavailable'); }))
      .rejects.toThrow('systemd unavailable');
  });
  it('inventories every returned database without silently classifying unexpected databases', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [{ datname: 'papercusp' }, { datname: 'unexpected' }]);
    const entries = await databaseCensusEntries(sql as unknown as Sql, 'cluster-123');
    expect(entries).toEqual([
      { kind: 'database', root: 'cluster-123', name: 'papercusp' },
      { kind: 'database', root: 'cluster-123', name: 'unexpected' },
    ]);
    expect(sql.mock.calls[0][0].join('')).toContain('WHERE NOT datistemplate');
  });

  it('propagates catalog failures and refuses unqualified cluster identity', async () => {
    const sql = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(databaseCensusEntries(sql as unknown as Sql, 'cluster-123')).rejects.toThrow('unavailable');
    await expect(databaseCensusEntries(sql as unknown as Sql, '')).rejects.toThrow('cluster identity');
  });
  it('uses producer-resolved paths rather than assuming both secrets live in the default home', () => {
    const result = secretCensusProducers();
    expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home']);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
      .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token']]);
  });
});
