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
vi.mock('../papercusp-root', () => ({ papercuspRoot: () => '/relocated/workspaces/registered-project/.papercusp' }));
import { databaseCensusEntries, physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, secretCensusProducers, unitCensusEntries, unitCensusDeclarations, verifyHostStateCensus, workspaceRegistryCensusProducer, scratchCensusProducer, installedRootCensusProducers, mergeNestedCensusRoots, postgresStorageDeclaration, gitStorageDeclaration } from './state-census-producers';
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CensusDeclaration } from '@papercusp/backup';
import type { Sql } from 'postgres';
import { templateDatabaseCensusDeclarations } from './state-census-producers';
import { hostedConfigurationCensusProducers, configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations } from './state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations } from './state-census-producers';
import { identityKeychainCensusProducer, anchorSecretCensusProducer, runtimeRetainedCensusProducer, accountCredentialCensusProducer, runtimeSidefileCensusProducer, cliSetupHomeCensusProducer, templateStoreCensusProducer } from './state-census-producers';
import { peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, stripRangeCacheCensusProducer, virtualenvCacheDeclaration, affectedTestCacheCensusProducer } from './state-census-producers';
import { planTemplateStoreCensusProducer, historicalGitBlobIdentityResolver, workspaceTemplateStoreCensusProducer } from './state-census-producers';
import { execFileSync } from 'node:child_process';
import { reapArchiveCensusProducer } from './state-census-producers';
import { archiveReapTail, REAP_TAIL_MAX_BYTES } from '../task-manager/reap-archive';

describe('reaper archive writer census', () => {
  it('verifies writer receipts after ledger GC and exposes corrupt, mismatched and linked receipts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-receipt-'));
    try {
      const source = join(home, 'source.log');
      await writeFile(source, Buffer.alloc(REAP_TAIL_MAX_BYTES + 20, 'x'));
      const tail = await archiveReapTail('expired-task', source, home, new Date('2026-10-11T12:00:00Z'));
      expect((await readFile(tail)).length).toBe(REAP_TAIL_MAX_BYTES);
      const receiptPath = `${tail}.receipt.json`;
      const original = await readFile(receiptPath, 'utf8');
      const names = async () => (await reapArchiveCensusProducer(home, [])).declarations.map(row => row.name);
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log');
      expect(await names()).toContain('reap-archive/2026-10-11/expired-task.tail.log.receipt.json');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'y'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(tail, Buffer.alloc(REAP_TAIL_MAX_BYTES, 'x'));
      await writeFile(receiptPath, original.replace('expired-task', 'another-task'));
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(receiptPath, 'null');
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await writeFile(source, original);
      await rm(receiptPath);
      await symlink(source, receiptPath);
      expect(await names()).not.toContain('reap-archive/2026-10-11/expired-task.tail.log');
      await expect(archiveReapTail('../escape', source, home)).rejects.toThrow('Invalid reaper task id');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('requires retained task identity, regular files and the writer size bound for tails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, 'known.tail.log'), 'tail');
      await writeFile(join(archive, 'unknown.tail.log'), 'tail');
      await writeFile(join(archive, 'large.tail.log'), Buffer.alloc(128 * 1024 + 1));
      await symlink(join(archive, 'known.tail.log'), join(archive, 'linked.tail.log'));
      await mkdir(join(archive, 'directory.tail.log'));
      const result = await reapArchiveCensusProducer(home, ['known', 'large', 'linked', 'directory', '../unknown']);
      expect(result.declarations.map(row => row.name)).toEqual([
        'reap-archive', 'reap-archive/2026-10-11', 'reap-archive/2026-10-11/known.tail.log',
      ]);
      expect(result.declarations.every(row => !row.descendants)).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('uses OS home and leaves links, invalid dates and unproven tails as residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'reap-census-'));
    try {
      const archive = join(home, '.papercusp', 'reap-archive');
      await mkdir(join(archive, '2026-10-11'), { recursive: true });
      await mkdir(join(archive, '2026-02-30'));
      await mkdir(join(archive, 'unexpected'));
      await writeFile(join(archive, '2026-10-11', 'unknown.tail.log'), 'fixture');
      await symlink(join(archive, '2026-10-11'), join(archive, '2026-10-12'));
      const producer = await reapArchiveCensusProducer(home);
      expect(producer.roots[0].path).toBe(join(home, '.papercusp'));
      expect(producer.declarations.map(row => row.name)).toEqual(['reap-archive', 'reap-archive/2026-10-11']);
      expect(producer.declarations.every(row => !row.descendants)).toBe(true);
      const otherHome = join(home, 'other');
      await mkdir(join(otherHome, '.papercusp'), { recursive: true });
      await symlink(archive, join(otherHome, '.papercusp', 'reap-archive'));
      expect((await reapArchiveCensusProducer(otherHome)).declarations).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('discovers historical workspace stores without following linked workspace homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-template-census-'));
    try {
      const home = join(root, 'retired', '.papercusp');
      await mkdir(join(home, 'templates', 'app'), { recursive: true });
      await writeFile(join(home, 'templates', 'app', 'template.yaml'), 'manifest');
      await writeFile(join(home, 'templates', 'app', 'old.ts'), 'historical bytes');
      const source = join(root, 'source.ts');
      await writeFile(source, 'current bytes');
      await symlink(join(root, 'retired'), join(root, 'linked-workspace'));
      await mkdir(join(root, 'linked-home'));
      await symlink(home, join(root, 'linked-home', '.papercusp'));
      const resolver = vi.fn(async (path: string, bytes: Buffer) => path === source && bytes.equals(Buffer.from('historical bytes')));
      const result = await workspaceTemplateStoreCensusProducer(root, new Map([['app/old.ts', source]]), resolver);
      expect(result.roots).toEqual([{ id: 'workspace-template-store:retired', path: home }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/old.ts'].sort());
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(result.declarations.every(entry => entry.root === result.roots[0].id && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('proves historical bytes only at the same regular Git source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'historical-template-identity-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
      git('init', '-q');
      await writeFile(join(root, 'source.ts'), 'old source');
      await writeFile(join(root, 'other.ts'), 'other path only');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      await writeFile(join(root, 'source.ts'), 'new source');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new');
      const matches = historicalGitBlobIdentityResolver(root);
      expect(await matches(join(root, 'source.ts'), Buffer.from('old source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('new source'))).toBe(true);
      expect(await matches(join(root, 'source.ts'), Buffer.from('other path only'))).toBe(false);
      expect(await matches(join(root, 'source.ts'), Buffer.from('drift'))).toBe(false);
      expect(await matches(join(root, 'missing.ts'), Buffer.from('old source'))).toBe(false);
      expect(await matches(join(root, '..', 'outside.ts'), Buffer.from('old source'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes exact mirror source while exposing drift, unknown siblings and linked parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-identity-census-'));
    try {
      await mkdir(join(root, 'templates', 'app', 'src'), { recursive: true });
      await writeFile(join(root, 'templates', 'app', 'template.yaml'), 'manifest');
      const source = join(root, 'canonical.ts');
      await writeFile(source, 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'same.ts'), 'canonical source');
      await writeFile(join(root, 'templates', 'app', 'src', 'drift.ts'), 'changed source');
      await writeFile(join(root, 'templates', 'app', 'src', 'unknown.ts'), 'canonical source');
      await symlink(source, join(root, 'templates', 'app', 'src', 'link.ts'));
      await symlink(join(root, 'templates', 'app', 'src'), join(root, 'templates', 'app', 'linked'));
      const expected = new Map(['src/same.ts', 'src/drift.ts', 'src/link.ts', 'linked/same.ts', 'src/missing.ts'].map(name => [`app/${name}`, source]));
      const result = await templateStoreCensusProducer(root, expected);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/app', 'templates/app/template.yaml', 'templates/app/src', 'templates/app/src/same.ts'].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains parsed plan templates while exposing incomplete bundles, links and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-template-census-'));
    try {
      for (const name of ['valid', 'legacy', 'incomplete', 'linked']) await mkdir(join(root, 'plan-templates', name), { recursive: true });
      const valid = join(root, 'plan-templates', 'valid');
      await writeFile(join(valid, 'plan.md'), '---\nslug: fixture\ntitle: Fixture\nstatus: draft\n---\n\n# Fixture\n\n- **P-001** `todo` Build fixture\n');
      await writeFile(join(valid, 'listing.json'), '{}');
      await writeFile(join(valid, 'unknown.ts'), 'source');
      await writeFile(join(root, 'plan-templates', 'legacy', 'plan.md'), '# Legacy');
      await writeFile(join(root, 'plan-templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(valid, 'plan.md'), join(root, 'plan-templates', 'linked', 'plan.md'));
      await symlink(valid, join(root, 'plan-templates', 'linked-dir'));
      const result = await planTemplateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['plan-templates', 'plan-templates/valid', 'plan-templates/valid/plan.md', 'plan-templates/valid/listing.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes installed template metadata without claiming source, bytecode or incomplete bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'template-store-census-'));
    try {
      for (const name of ['valid', 'incomplete', 'linked-manifest']) await mkdir(join(root, 'templates', name), { recursive: true });
      for (const name of ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md', 'source.ts', 'module.pyc']) await writeFile(join(root, 'templates', 'valid', name), 'opaque');
      await writeFile(join(root, 'templates', 'incomplete', 'listing.json'), '{}');
      await symlink(join(root, 'templates', 'valid', 'template.yaml'), join(root, 'templates', 'linked-manifest', 'template.yaml'));
      await symlink(join(root, 'templates', 'valid'), join(root, 'templates', 'linked-bundle'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/valid', ...['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].map(name => `templates/valid/${name}`)].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const writer = await readFile(new URL('../cupboard/install-template-core.ts', import.meta.url), 'utf8');
      expect(writer).toContain("existsSync(join(srcDir, 'template.yaml'))");
      const store = await readFile(new URL('../cupboard/template-store.ts', import.meta.url), 'utf8');
      expect(store).toContain("papercuspPath('templates')");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('recognizes historical versioned metadata only with matching identity and regular paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-template-census-'));
    try {
      const valid = join(root, 'templates', 'legacy', '0.1.0');
      await mkdir(join(valid, '.harness'), { recursive: true });
      await writeFile(join(valid, 'papercusp.json'), JSON.stringify({ name: 'legacy', version: '0.1.0', kind: 'template' }));
      for (const file of ['SPEC.md', 'README.md', '.published.json', 'unexpected.ts', '.harness/config.json', '.harness/unexpected.ts']) await writeFile(join(valid, file), 'fixture');
      await symlink(join(valid, 'SPEC.md'), join(valid, 'AGENTS.md'));
      await symlink(join(valid, 'SPEC.md'), join(valid, '.harness/validation-contract.md'));
      for (const version of ['0.2.0', 'invalid']) {
        await mkdir(join(root, 'templates', 'legacy', version), { recursive: true });
        await writeFile(join(root, 'templates', 'legacy', version, 'papercusp.json'), JSON.stringify({ name: 'wrong', version, kind: 'template' }));
      }
      await symlink(valid, join(root, 'templates', 'legacy', '0.3.0'));
      const result = await templateStoreCensusProducer(root);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['templates', 'templates/legacy', 'templates/legacy/0.1.0', ...['papercusp.json', 'SPEC.md', 'README.md', '.published.json', '.harness', '.harness/config.json'].map(file => `templates/legacy/0.1.0/${file}`)].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves completed setup credentials without claiming copied source or unknown homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-census-'));
    try {
      const parent = join(root, 'deploy-credentials');
      const names = ['.codex-setup-acme-1234abcd', '.setup-acme-1234abcd', '.codex-setup-acme-invalid'];
      for (const name of names) await mkdir(join(parent, name), { recursive: true });
      await writeFile(join(parent, names[0], 'auth.json'), 'opaque credential');
      await writeFile(join(parent, names[0], 'source.ts'), 'source');
      await symlink(join(parent, names[0]), join(parent, '.codex-setup-link-1234abcd'));
      const result = await cliSetupHomeCensusProducer(root);
      expect(result.declarations.map(entry => [entry.name, entry.classification])).toEqual([
        [`deploy-credentials/${names[0]}`, 'state'],
        [`deploy-credentials/${names[0]}/auth.json`, 'secret'],
        [`deploy-credentials/${names[1]}`, 'state'],
      ]);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains exact pacing and gym sidefiles while leaving unknown siblings and links visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidefile-census-'));
    try {
      const pacing = 'google-vertex-gemini-3.1-pro-preview.json';
      const temporary = `${pacing}.tmp-123-12345678-1234-1234-1234-123456789abc`;
      for (const directory of ['provider-pacing', 'template-gym']) await mkdir(join(home, '.papercusp', directory), { recursive: true });
      for (const file of [pacing, `${pacing}.lock`, temporary, `${pacing}.tmp-unknown`, 'unknown']) await writeFile(join(home, '.papercusp', 'provider-pacing', file), 'opaque');
      await writeFile(join(home, '.papercusp', 'template-gym', 'last-run.json'), '{}');
      await symlink(join(home, '.papercusp', 'template-gym', 'last-run.json'), join(home, '.papercusp', 'template-gym', 'runs.jsonl'));
      const result = await runtimeSidefileCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['provider-pacing', ...[pacing, `${pacing}.lock`, temporary].map(file => `provider-pacing/${file}`), 'template-gym', 'template-gym/last-run.json'].sort());
      expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      const hook = await readFile(new URL('../../../../apps/operator/scripts/hooks/omp/coord-hook.ts', import.meta.url), 'utf8');
      expect(hook).toContain(`'${pacing}'`);
      expect(hook).toContain('`${statePath}.tmp-${process.pid}-${randomUUID()}`');
      const gym = await readFile(new URL('../harness/routines/template-gym-runner.ts', import.meta.url), 'utf8');
      for (const name of ['template-gym', 'last-run.json', 'runs.jsonl']) expect(gym).toContain(`'${name}'`);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('owns referenced auth and atomic refresh files while leaving copied source and unknown siblings visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'account-census-'));
    try {
      await mkdir(join(home, 'build'));
      await mkdir(join(home, '__pycache__'));
      for (const name of ['auth.json', 'auth.json.123.tmp', 'auth.json.unknown.tmp', 'unknown']) await writeFile(join(home, name), 'must not read');
      await writeFile(join(home, 'build', 'template.ts'), 'source');
      await writeFile(join(home, '__pycache__', 'module.pyc'), 'bytecode');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }, { credentialRef: 'keychain:external' }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      expect(result.declarations.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      const writer = await readFile(new URL('../inference-gateway/codex-oauth-proxy.ts', import.meta.url), 'utf8');
      expect(writer).toContain('`${target}.${process.pid}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('recognizes exact affected-test cache writers without claiming unrelated files or symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-cache-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      await mkdir(directory, { recursive: true });
      const ordinary = 'papercusp-affected-passing-verdicts-v2-0123456789abcdef.json';
      const committed = 'papercusp-affected-passing-verdicts-v2-committed-fedcba9876543210.json';
      await writeFile(join(directory, ordinary), '{}');
      await writeFile(join(directory, committed), '{}');
      await writeFile(join(directory, 'unknown.json'), '{}');
      await symlink(join(directory, 'unknown.json'), join(directory, 'papercusp-affected-passing-verdicts-v2-aaaaaaaaaaaaaaaa.json'));
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(home, 'history', 'custom.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', join(home, 'verdict', 'custom.json'));
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['custom.json', 'custom.json', ordinary, committed].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path)).toContain(join(home, 'history'));
      const writer = await readFile(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      expect(writer).toContain('papercusp-affected-task-durations-v1.json');
      expect(writer).toContain('papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json');
      const committedWriter = await readFile(new URL('../../../../scripts/lint-as-committed.mjs', import.meta.url), 'utf8');
      expect(committedWriter).toContain('papercusp-affected-passing-verdicts-v2-committed-${scope}.json');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains runtime writer directories under the relocated active workspace without pruning credentials or diagnostics', async () => {
    const result = runtimeRetainedCensusProducer();
    expect(result.roots).toEqual([{ id: 'runtime-retained', path: '/relocated/workspaces/registered-project/.papercusp' }]);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.prune])).toEqual([
      ['deploy-credentials', 'state', undefined], ['crash-reports', 'state', undefined], ['snapshot-fold-checkpoints', 'state', undefined],
    ]);
    const writers = [
      ['../deployment/account-link-cli.ts', "papercuspPath('deploy-credentials'"],
      ['../process-supervision/fatal-diagnostics.ts', "papercuspPath('crash-reports')"],
      ['../sync/hyperbee/boot.ts', "'snapshot-fold-checkpoints'"],
    ];
    for (const [path, marker] of writers) expect(await readFile(new URL(path, import.meta.url), 'utf8')).toContain(marker);
    const installed = installedRootCensusProducers();
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')).toMatchObject({
      root: 'install-root-0', name: 'registered-project/.papercusp/deploy-credentials', classification: 'state',
    });
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')?.descendants).toBeUndefined();
  });
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
  it('continues inspecting surviving units when a discovered transient definition disappears', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unit-db-disappeared-'));
    try {
      const definition = '[Service]\nEnvironment=APP_DATABASE_URL=postgresql://localhost:5432/app\n';
      await writeFile(join(path, 'gone.service'), definition);
      await writeFile(join(path, 'live.service'), definition);
      const units = await unitCensusDeclarations(path, 'user');
      await rm(join(path, 'gone.service'));
      const result = await unitDatabaseCensusDeclarations(units,
        [{ kind: 'database', root: 'postgres-cluster:123', name: 'app' }], 'postgresql://localhost/operator');
      expect(result).toHaveLength(1);
      expect(result[0].producer).toContain('live.service');
      // Unexpected inspection errors still fail closed.
      await writeFile(join(path, 'live.service'), 'x'.repeat(65_537));
      await expect(unitDatabaseCensusDeclarations(units, [], 'postgresql://localhost/operator'))
        .rejects.toThrow('Service database config bound exceeded');
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
