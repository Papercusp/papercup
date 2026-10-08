import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db-encryption', () => ({ dbEncryptionKeyFilePath: () => '/mounted/secrets/db-key' }));
vi.mock('../superuser-token', () => ({ superuserTokenPath: () => '/scoped/home/superuser-token' }));
vi.mock('../workspace-registry', () => ({
  workspacesRoot: () => '/relocated/workspaces',
  readRegistry: () => ({ workspaces: [{ id: 'registered-project' }] }),
}));
vi.mock('../scratch-uri', () => ({ scratchRoot: () => '/relocated/cache/spills' }));
vi.mock('../oauth/providers', () => ({ googleOAuthClientPath: () => '/fixture/config/papercusp/google-oauth-client.json' }));
vi.mock('../identity/keychain', () => ({ identityDir: () => '/fixture/sensitive/identity' }));
vi.mock('../cupboard/ledger-anchor-eas', () => ({ anchorKeyFilePath: () => '/fixture/sensitive/anchor-key' }));
import { databaseCensusEntries, physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, secretCensusProducers, unitCensusEntries, unitCensusDeclarations, verifyHostStateCensus, workspaceRegistryCensusProducer, scratchCensusProducer, installedRootCensusProducers, mergeNestedCensusRoots, postgresStorageDeclaration, gitStorageDeclaration } from './state-census-producers';
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { templateDatabaseCensusDeclarations } from './state-census-producers';
import { hostedConfigurationCensusProducers, configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations } from './state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations } from './state-census-producers';
import { identityKeychainCensusProducer, anchorSecretCensusProducer } from './state-census-producers';
import { peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, stripRangeCacheCensusProducer, virtualenvCacheDeclaration } from './state-census-producers';

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('uses the anchor producer path without resolving a backend or reading private key bytes', () => {
    expect(anchorSecretCensusProducer()).toEqual({ roots: [{ id: 'anchor-key-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'anchor-key-parent', name: 'anchor-key', classification: 'secret', producer: 'ledger-anchor-key' }] });
  });
  it('retains the keychain writer directory as sensitive state without pruning it', () => {
    expect(identityKeychainCensusProducer()).toEqual({ roots: [{ id: 'identity-keychain-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'identity-keychain-parent', name: 'identity', classification: 'secret', producer: 'identity-keychain', descendants: true }] });
  });
  it('derives retained database schema footprints from literal migration arrays without executing source', () => {
    const tables = migrationProducerTables('// CREATE TABLE fake (id text)\nexport const APP_MIGRATIONS = [`CREATE TABLE IF NOT EXISTS records (id text)`, `CREATE TABLE receipts (id text)`] as const;\nthrow new Error("must not execute");');
    expect(tables).toEqual(['public.records', 'public.receipts']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const sources = [{ producer: 'fixture:migrations', tables }];
    expect(migrationDatabaseCensusDeclarations(entry, ['public.records'], sources)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, tables, sources)[0]).toMatchObject({ name: 'arbitrary', classification: 'state', producer: 'fixture:migrations' });
    expect(migrationDatabaseCensusDeclarations(entry, tables, [{ producer: 'fixture:migrations', tables: [...tables, 'public.new_feature'] }])[0])
      .toMatchObject({ classification: 'state', producer: 'fixture:migrations:migration-prefix:2/3' });
  });
  it('joins local service database config with the measured catalogue and excludes remote endpoints', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-census-'));
    try {
      await writeFile(join(path, 'app.service'), '[Service]\nEnvironment="APP_DATABASE_URL=postgresql://user:private@127.0.0.1:5432/app" "OTHER_DATABASE_URL=postgresql://remote:private@example.com/app"\n');
      const units = await unitCensusDeclarations(path, 'user');
      const databases = [{ kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' }];
      const result = await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'app', classification: 'state', producer: 'unit-database-config:systemd-user:app.service:APP_DATABASE_URL' });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(await unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator')).toEqual([]);
      await writeFile(join(path, 'runtime.env'), 'APP_DATABASE_URL=postgresql://user:private@localhost:5432/app\n');
      await writeFile(join(path, 'app.service'), `[Service]\nEnvironmentFile=${join(path, 'runtime.env')}\nEnvironmentFile=-${join(path, 'missing.env')}\n`);
      expect(await unitDatabaseCensusDeclarations(units, databases, 'postgresql://localhost/operator')).toHaveLength(1);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('derives hosted config paths from writer overrides and keeps credentials secret', async () => {
    const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/deploy-hosted-control-plane.sh', import.meta.url), 'utf8');
    expect(writer).toContain('PAPERCUSP_HOSTED_CP_ENV_FILE');
    expect(writer).toContain('hosted-control-plane.env');
    vi.stubEnv('PAPERCUSP_HOSTED_CP_ENV_FILE', '/fixture/credentials/hosted.env');
    vi.stubEnv('PUI_PORTAL_LINKS_ENV', '/fixture/config/links.env');
    try {
      const result = hostedConfigurationCensusProducers();
      expect(result.declarations.find(entry => entry.producer === 'deploy-hosted-control-plane')).toMatchObject({ name: 'hosted.env', classification: 'secret' });
      expect(result.declarations.find(entry => entry.producer === 'publish-tui-release')).toMatchObject({ name: 'links.env', classification: 'config' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('qualifies operator state from the configured URL and pins the SU side-db to its writer', async () => {
    const source = await readFile(new URL('../../../../libs/papercusp/packages/locks/src/su-lock-store.ts', import.meta.url), 'utf8');
    expect(source).toContain("'/papercusp_su$1'");
    expect(configuredOperatorDatabaseCensusDeclarations('postgres-cluster:123', 'postgresql://user:password@localhost:5432/relocated')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'relocated', classification: 'state', producer: 'embedded-pg-discovery-operator' },
      { kind: 'database', root: 'postgres-cluster:123', name: 'papercusp_su', classification: 'state', producer: 'su-lock-store' },
    ]);
    expect(() => configuredOperatorDatabaseCensusDeclarations('port:5432', 'postgresql://localhost/db')).toThrow('identity');
  });
  it('uses the template producer readiness marker rather than treating similar database names as disposable', async () => {
    const source = await readFile(new URL('../../../../libs/test-config/src/pg-migrate.ts', import.meta.url), 'utf8');
    expect(source).toContain("const TEMPLATE_READY_MARK = 'pc-template-ready';");
    const sql = vi.fn(async () => [{ datname: 'tmpl_fixture', marker: 'pc-template-ready' },
      { datname: 'tmpl_customer', marker: null }, { datname: 'customer', marker: 'pc-template-ready' }]);
    expect(await templateDatabaseCensusDeclarations(sql as unknown as Sql, 'postgres-cluster:123')).toEqual([
      { kind: 'database', root: 'postgres-cluster:123', name: 'tmpl_fixture', classification: 'dev-only', producer: 'pg-migrate-template-ready' },
    ]);
    await expect(templateDatabaseCensusDeclarations(sql as unknown as Sql, 'port:5432')).rejects.toThrow('identity');
  });
  it('qualifies arbitrarily named Python environments by marker and package layout', async () => {
    const path = await mkdtemp(join(tmpdir(), 'virtualenv-census-'));
    try {
      const environment = join(path, 'arbitrary');
      await mkdir(join(environment, 'lib', 'python3.12', 'site-packages'), { recursive: true });
      await mkdir(join(environment, 'bin'));
      await writeFile(join(environment, 'bin', 'python'), 'fixture');
      await writeFile(join(environment, 'pyvenv.cfg'), 'home = /usr/bin\nversion_info = 3.12.3\ninclude-system-site-packages = false\n');
      expect(await virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).toMatchObject({ name: 'arbitrary', classification: 'cache', prune: true });
      await rm(join(environment, 'lib'), { recursive: true });
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, 'arbitrary')).rejects.toThrow();
      await expect(virtualenvCacheDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins analysis-cache ownership to the actual writer and honors relocation', async () => {
    const writer = await readFile(new URL('../../../../scripts/lib/strip-comments-and-strings.mjs', import.meta.url), 'utf8');
    expect(writer).toContain('process.env.PAPERCUSP_STRIP_CACHE_DIR');
    expect(writer).toContain("path.join(os.homedir(), '.papercusp', 'cache', 'strip-ranges')");
    vi.stubEnv('PAPERCUSP_STRIP_CACHE_DIR', '/fixture/analysis/cache');
    try {
      expect(stripRangeCacheCensusProducer()).toMatchObject({ roots: [{ path: '/fixture/analysis' }],
        declarations: [{ name: 'cache', classification: 'cache', prune: true }] });
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains only completed direct restore clones and refuses active or symlinked targets', async () => {
    const path = await mkdtemp(join(tmpdir(), 'restore-census-'));
    try {
      const target = join(path, '.restored', 'snapshot', 'clone');
      await mkdir(target, { recursive: true });
      const rows = [{ id: '123', target, phase: 'done' }, { id: '124', target: join(path, '.restored', 'active', 'clone'), phase: 'started' }];
      const sql = vi.fn(async () => rows) as unknown as Sql;
      const declarations = await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }]);
      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toMatchObject({ name: '.restored/snapshot/clone', classification: 'state', recoveryStorage: { restoreEventId: '123' } });
      await rm(target, { recursive: true });
      await symlink(path, target, 'dir');
      expect(await restoredCloneCensusDeclarations(sql, 'workspace', path, [{ id: 'home', path }])).toEqual([]);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('preserves published portal generations only after matching their producer manifest', async () => {
    const path = await mkdtemp(join(tmpdir(), 'release-census-'));
    try {
      await mkdir(join(path, 'generation'));
      const manifest = { schemaVersion: 2, release: 'generation', buildId: 'build', sourceRoot: '/source', publishedAt: '2026-10-08T00:00:00Z' };
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify(manifest));
      await writeFile(join(path, 'generation', 'standalone-entry.mjs'), 'fixture');
      const owner = await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation');
      expect(owner.classification).toBe('state');
      expect(owner.releaseStorage?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, sourceRoot: 'C:\\portal' }));
      expect((await portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).classification).toBe('state');
      await writeFile(join(path, 'generation', '.papercusp-release.json'), JSON.stringify({ ...manifest, release: 'other' }));
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, 'generation')).rejects.toThrow('manifest');
      await expect(portalReleaseStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('reads peer marker evidence without modifying storage and rejects malformed or linked markers', async () => {
    const path = await mkdtemp(join(tmpdir(), 'peer-census-'));
    try {
      await mkdir(join(path, 'hyperbee', 'db'), { recursive: true });
      const marker = 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n';
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), marker);
      const declaration = await peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee');
      expect(declaration.peerStorage?.markerSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(join(path, 'hyperbee', 'CORESTORE'), 'utf8')).toBe(marker);
      await writeFile(join(path, 'hyperbee', 'CORESTORE'), 'not a device file');
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow('marker');
      await rm(join(path, 'hyperbee', 'CORESTORE'));
      await writeFile(join(path, 'elsewhere'), marker);
      await symlink(join(path, 'elsewhere'), join(path, 'hyperbee', 'CORESTORE'));
      await expect(peerStorageDeclaration({ id: 'fixture', path }, 'hyperbee')).rejects.toThrow();
      await expect(peerStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('measures primary Git metadata and preserves linked pointers within the same inventory root', async () => {
    const path = await mkdtemp(join(tmpdir(), 'git-storage-census-'));
    try {
      const git = join(path, 'primary', '.git');
      await mkdir(join(git, 'objects'), { recursive: true });
      await mkdir(join(git, 'refs'), { recursive: true });
      await writeFile(join(git, 'HEAD'), `${'a'.repeat(40)}\n`);
      const primary = await gitStorageDeclaration({ id: 'fixture', path }, 'primary');
      expect(primary.gitStorage?.head).toBe('a'.repeat(40));
      const linked = join(git, 'worktrees', 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(join(linked, 'HEAD'), `${'a'.repeat(40)}\n`);
      await writeFile(join(linked, 'commondir'), '../..\n');
      await mkdir(join(path, 'linked'));
      await writeFile(join(path, 'linked', '.git'), `gitdir: ${linked}\n`);
      const pointer = await gitStorageDeclaration({ id: 'fixture', path }, 'linked');
      expect(pointer.producer).toBe('git-worktree-pointer');
      expect(pointer.gitStorage).toBeUndefined();
      const worktree = await gitStorageDeclaration({ id: 'fixture', path }, 'linked', true);
      expect(worktree.name).toBe('linked');
      expect(worktree.gitStorage?.head).toBe('a'.repeat(40));
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('refuses repository traversal before invoking Git', async () => {
    await expect(gitStorageDeclaration({ id: 'fixture', path: '/fixture' }, '../outside'))
      .rejects.toThrow('Invalid repository path');
  });
  it('refuses unverified PG storage and traversal paths before creating ownership', async () => {
    const path = await mkdtemp(join(tmpdir(), 'pg-storage-owner-'));
    try {
      await writeFile(join(path, 'PG_VERSION'), 'not-postgres');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '.')).rejects.toThrow('Invalid PG storage version');
      await expect(postgresStorageDeclaration({ id: 'fixture', path }, '../outside')).rejects.toThrow('Invalid PG storage path');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('pins baseline classification to the current producer identity format', async () => {
    const producer = await readFile(new URL('../../../../libs/test-config/src/baseline-schema-global-setup.ts', import.meta.url), 'utf8');
    expect(producer).toContain('const dbName = `papercusp_it_baseline_${randomBytes(6).toString(\'hex\')}`;');
  });
  it('classifies only exact producer-shaped integration baselines, not similar production names', () => {
    const entries = ['papercusp_it_baseline_123456abcdef', 'papercusp_it_baseline_customer', 'scratch_customer'].map(name =>
      ({ kind: 'database' as const, root: 'cluster', name }));
    expect(integrationBaselineCensusDeclarations(entries).map(entry => entry.name))
      .toEqual(['papercusp_it_baseline_123456abcdef']);
  });
  it('qualifies catalog entries with measured physical PG identity, not a port or DB name', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray): Promise<Record<string, string>[]> => [])
      .mockResolvedValueOnce([{ system_identifier: '123456789' }])
      .mockResolvedValueOnce([{ datname: 'app' }]);
    expect(await physicalDatabaseCensusEntries(sql as unknown as Sql)).toEqual([
      { kind: 'database', root: 'postgres-cluster:123456789', name: 'app' },
    ]);
    await expect(physicalDatabaseCensusEntries(vi.fn(async () => []) as unknown as Sql))
      .rejects.toThrow('physical database cluster identity');
  });
  it('merges nested roots without losing child-relative secret ownership or conflating prefixes', () => {
    const parent = join(tmpdir(), 'nested-census', 'app');
    const sibling = `${parent}-other`;
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'child', path: join(parent, 'secrets') }, { id: 'parent', path: parent },
      { id: 'sibling', path: sibling },
    ], declarations: [{ kind: 'path', root: 'child', name: 'key', classification: 'secret', producer: 'key' }] });
    expect(result.roots.map(root => root.id)).toEqual(['parent', 'sibling']);
    expect(result.roots.map(root => root.path)).toEqual([parent, sibling]);
    expect(result.declarations[0]).toMatchObject({ root: 'parent', name: 'secrets/key', classification: 'secret' });
  });
  it('composes writer roots and rewrites declaration identities consistently', () => {
    const result = installedRootCensusProducers();
    expect(new Set(result.roots.map(root => root.path)).size).toBe(result.roots.length);
    expect(result.declarations.every(entry => result.roots.some(root => root.id === entry.root))).toBe(true);
    expect(result.declarations.some(entry => entry.name === 'db-key' && entry.classification === 'secret')).toBe(true);
  });
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
    expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home', '/fixture/config/papercusp']);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
      .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token'],
        ['google-oauth-client.json', 'secret', 'google-oauth-desktop-client']]);
  });
});
