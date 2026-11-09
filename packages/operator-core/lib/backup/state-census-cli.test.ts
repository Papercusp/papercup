import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRootCensus, discoverRootCensusInputs, readMigrationCensusColumns, readWorkspaceCensusAccounts, readWorkspaceSetupHomes } from '../../../../scripts/state-census-roots.mts';
import { collectStateCensus } from '../../../../packages/backup/src/state-census';
import { archiveReapTail } from '../task-manager/reap-archive';
import * as censusProducers from './state-census-producers';

// Filesystem-only census must load without the live account/task runtime.
vi.mock('../deployment/account-pool-store', () => { throw new Error('host account store unavailable'); });
vi.mock('../task-manager/store', () => { throw new Error('host task store unavailable'); });

// Some credential writers resolve their home at module load. Isolate before
// collection, so the in-process census cannot enumerate the developer's home.
const fixtureHome = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'root-census-cli-'));
  for (const [key, value] of Object.entries({ HOME: directory, PAPERCUSP_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, '.config'), PAPERCUSP_WORKSPACES_ROOT: path.join(directory, 'registry'),
    PAPERCUSP_SCRATCH_ROOT: path.join(directory, 'spills'), PAPERCUSP_STRIP_CACHE_DIR: path.join(directory, 'analysis-cache'),
    PAPERCUSP_FS_MUTEX_LOCK_DIR: path.join(directory, '.papercusp', 'fs-mutex-locks'),
    // Committed-test runners set these to shared host paths. Both census
    // executions must read fixture files, even when those variables are set.
    AFFECTED_TASK_HISTORY_PATH: path.join(directory, 'affected-cache', 'durations.json'),
    AFFECTED_TASK_VERDICT_CACHE_PATH: path.join(directory, 'affected-cache', 'verdict.json'),
    PAPERCUSP_DB_ENCRYPTION_KEY_FILE: path.join(directory, 'db-key') })) vi.stubEnv(key, value as string);
  return directory;
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(fixtureHome, { recursive: true, force: true }); });

describe('unit census executable exit contract', () => {
  it('retains completed writer inputs when credential discovery fails', async () => {
    mkdirSync(join(fixtureHome, 'registry'), { recursive: true });
    const saved: { phase: string; roots: unknown[]; declarations: unknown[]; catalogEntries: unknown[] }[] = [];
    const credentials = vi.spyOn(censusProducers, 'accountCredentialCensusProducer')
      .mockRejectedValue(new Error('credential source unavailable'));
    try {
      await expect(discoverRootCensusInputs({
        checkpointLogDir: join(fixtureHome, 'checkpoint-history'),
        onDiscoverySnapshot: snapshot => { saved.push(snapshot); },
      })).rejects.toThrow('credential source unavailable');
      expect(saved.map(snapshot => snapshot.phase)).toEqual(['before-account-credentials']);
      expect(saved[0].roots.length).toBeGreaterThan(0);
      expect(saved[0].declarations.length).toBeGreaterThan(0);
      expect(saved[0].catalogEntries).toEqual([]);
      expect(saved[0]).not.toHaveProperty('ok');
      expect(saved[0]).not.toHaveProperty('wholeInstallVerified');
    } finally {
      credentials.mockRestore();
      rmSync(join(fixtureHome, 'registry'), { recursive: true, force: true });
    }
  });
  it('retains independent producer inputs before a later filesystem discovery failure', async () => {
    mkdirSync(join(fixtureHome, 'registry'), { recursive: true });
    let saved: Parameters<NonNullable<NonNullable<Parameters<typeof discoverRootCensusInputs>[0]>['onDiscoverySnapshot']>>[0] | undefined;
    try {
      await expect(discoverRootCensusInputs({
        checkpointLogDir: join(fixtureHome, 'checkpoint-history'),
        onDiscoverySnapshot: async snapshot => {
          saved = JSON.parse(JSON.stringify(snapshot));
          // A consumer cannot mutate the ongoing discovery by retaining inputs.
          snapshot.roots.length = 0;
          snapshot.declarations.length = 0;
        },
        onStage: stage => { if (stage === 'filesystem-storage-markers') throw new Error('filesystem unavailable'); },
      })).rejects.toThrow('filesystem unavailable');
      expect(saved?.phase).toBe('before-filesystem');
      expect(saved?.roots.length).toBeGreaterThan(0);
      expect(saved?.declarations.length).toBeGreaterThan(0);
      expect(saved?.catalogEntries).toEqual([]);
      expect(saved).not.toHaveProperty('ok');
      expect(saved).not.toHaveProperty('wholeInstallVerified');
    } finally { rmSync(join(fixtureHome, 'registry'), { recursive: true, force: true }); }
  });
  it('merges receipt-backed Stripe declarations while preserving an unproven sibling as residue', async () => {
    const directory = join(fixtureHome, '.config', 'papercusp');
    // The root composition scans the workspace registry even with no entries.
    const registry = join(fixtureHome, 'registry');
    mkdirSync(registry, { recursive: true });
    mkdirSync(directory, { recursive: true });
    const spills = join(fixtureHome, 'spills');
    mkdirSync(join(spills, 'cached-copy'), { recursive: true });
    writeFileSync(join(spills, 'cached-copy', 'pyvenv.cfg'), 'not installed virtualenv metadata');
    const mutex = join(fixtureHome, '.papercusp', 'fs-mutex-locks');
    mkdirSync(join(mutex, 'runtime-lease'), { recursive: true });
    writeFileSync(join(mutex, 'runtime-lease', 'pyvenv.cfg'), 'cached marker, never installed storage');
    const owned = join(directory, 'receipt-backed.json');
    const unknown = join(directory, 'unproven.json');
    writeFileSync(owned, 'private fixture', { mode: 0o600 });
    writeFileSync(unknown, 'unproven fixture', { mode: 0o600 });
    const evidence = [{ ref: 'archive:fixture', toolInput: 'fixture', receipt: '{}',
      startedAt: '2026-10-03T05:10:33Z', finishedAt: '2026-10-03T05:10:34Z' }];
    // Detailed writer/receipt/byte admission is exercised by the producer suite;
    // this test guards the canonical census composition boundary.
    const producer = vi.spyOn(censusProducers, 'historicalStripeConfigCensusProducer').mockResolvedValue({
      roots: [{ id: 'stripe-fixture', path: directory }], declarations: [{ kind: 'path', root: 'stripe-fixture',
        name: 'receipt-backed.json', classification: 'secret', producer: 'historical-stripe-test-config:archive:fixture' }],
    });
    try {
      const stages: string[] = [];
      const report = await runRootCensus({ checkpointLogDir: join(fixtureHome, 'checkpoint-history'),
        historicalWriterEvidence: evidence, onStage: stage => stages.push(stage) });
      expect(producer).toHaveBeenCalledWith(evidence);
      expect(report.inventory.some(entry => entry.producers.includes('historical-stripe-test-config:archive:fixture') && entry.classification === 'secret')).toBe(true);
      expect(report.residue.some(entry => entry.name.endsWith('unproven.json'))).toBe(true);
      expect(report.inventory.find(entry => entry.name === 'spills')?.classification).toBe('cache');
      expect(report.inventory.some(entry => entry.name.startsWith('spills/'))).toBe(false);
      expect(report.inventory.find(entry => entry.name === '.papercusp/fs-mutex-locks')?.classification).toBe('cache');
      expect(report.wholeInstallVerified).toBe(false);
      expect(stages[0]).toBe('installed-roots');
      expect(stages.at(-1)).toBe('complete');
      expect(stages).toContain('collect-state-census');
      expect(stages).not.toContain('host-catalogs');
      const inputs = JSON.parse(JSON.stringify(await discoverRootCensusInputs({
        checkpointLogDir: join(fixtureHome, 'checkpoint-history'), historicalWriterEvidence: evidence,
      })));
      expect(inputs).not.toHaveProperty('ok');
      const staged = await collectStateCensus({ roots: inputs.roots, declarations: inputs.declarations,
        readCatalogs: async () => inputs.catalogEntries, representUnknownSubtrees: true });
      expect(staged.inventory).toEqual(report.inventory);
      expect(staged.residue).toEqual(report.residue);
    } finally {
      producer.mockRestore(); rmSync(owned, { force: true }); rmSync(unknown, { force: true });
      rmSync(registry, { recursive: true, force: true });
      rmSync(spills, { recursive: true, force: true });
      rmSync(mutex, { recursive: true, force: true });
    }
  });
  it('scans inactive workspace setup homes without owning copied foreign files', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-setup-census-'));
    try {
      const active = join(parent, 'active');
      const inactive = join(parent, 'inactive');
      const name = 'deploy-credentials/.codex-setup-account-1234abcd';
      for (const home of [active, inactive]) {
        mkdirSync(join(home, name), { recursive: true });
        writeFileSync(join(home, name, 'auth.json'), 'opaque');
        writeFileSync(join(home, name, 'foreign-source.ts'), 'foreign');
      }
      const result = await readWorkspaceSetupHomes([{ id: 'active' }, { id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active);
      expect(result.roots.map(root => root.path)).toEqual([active, inactive]);
      for (const root of result.roots) {
        expect(result.declarations.filter(entry => entry.root === root.id).map(entry => [entry.name, entry.classification]))
          .toEqual([[name, 'state'], [`${name}/auth.json`, 'secret']]);
      }
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('retains credential references from inactive workspace pools and fails on an unreadable pool', async () => {
    const readPool = vi.fn(async (workspace: string) => ({ accounts: [
      { credentialRef: `token:/fixture/${workspace}/credential` },
    ] }));
    expect(await readWorkspaceCensusAccounts([{ id: 'active' }, { id: 'inactive' }, { id: 'active' }], readPool))
      .toEqual([{ credentialRef: 'token:/fixture/active/credential' },
        { credentialRef: 'token:/fixture/inactive/credential' }]);
    expect(readPool.mock.calls).toEqual([['active'], ['inactive']]);
    await expect(readWorkspaceCensusAccounts([{ id: 'unreadable' }], async () => {
      throw new Error('pool unavailable');
    })).rejects.toThrow('pool unavailable');
    expect(await readWorkspaceCensusAccounts([], readPool)).toEqual([]);
    expect(await readWorkspaceCensusAccounts([])).toEqual([]);
    await expect(readWorkspaceCensusAccounts([{ id: 'active' }])).rejects.toThrow();
  });

  it('limits schema reads to exact source tables and preserves the overflow guard', async () => {
    const sources = [{ producer: 'fixture', tables: ['harness_shared.consult_state', 'public.records'] }];
    const matching = [{ table_schema: 'harness_shared', table_name: 'consult_state', column_name: 'routing', data_type: 'jsonb' }];
    const query = vi.fn(async (strings: TemplateStringsArray, tables: string[]) => {
      // A catalog with 20,001 unrelated columns must never enter the result.
      const catalog = [...matching, ...Array.from({ length: 20001 }, () => ({ table_schema: 'unrelated', table_name: 'records', column_name: 'id', data_type: 'text' }))];
      expect(strings.join('?')).toContain("(table_schema || '.' || table_name) = ANY(?)");
      expect(strings.join('?')).toContain('data_type, udt_schema, udt_name');
      return catalog.filter(row => tables.includes(`${row.table_schema}.${row.table_name}`));
    });
    expect(await readMigrationCensusColumns(query as never, sources)).toEqual(matching);
    expect(await readMigrationCensusColumns(query as never, [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readMigrationCensusColumns(vi.fn(async () => Array(20001).fill(matching[0])) as never, sources))
      .rejects.toThrow('Database schema census bound exceeded');
  });
  it('root diagnostic explicitly reports partial scope and fails unknown filesystem ownership', async () => {
    const directory = fixtureHome;
    try {
      mkdirSync(join(directory, 'registry'));
      mkdirSync(join(directory, 'spills'));
      mkdirSync(join(directory, 'analysis-cache'));
      mkdirSync(join(directory, 'affected-cache'));
      writeFileSync(join(directory, 'affected-cache', 'unowned-cache-entry'), 'fixture');
      mkdirSync(join(directory, 'checkpoint-history'));
      mkdirSync(join(directory, '.config', 'papercusp'), { recursive: true });
      const peer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(peer, 'db'), { recursive: true });
      writeFileSync(join(peer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n');
      writeFileSync(join(peer, 'db', 'persistent-log'), 'state');
      const restoredPeer = join(directory, 'registry', 'fixture', '.restored', 'snapshot', 'clone', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(restoredPeer, 'db'), { recursive: true });
      writeFileSync(join(restoredPeer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=789\ndevice/created=123\n');
      const app = join(directory, 'registry', 'fixture', '.papercusp', 'apps-copy', 'portal');
      mkdirSync(join(app, 'scripts'), { recursive: true });
      mkdirSync(join(app, '.next-build-123-456-abcd'));
      writeFileSync(join(app, 'scripts', 'build-standalone.mjs'), 'const buildDistDir = ".next-build";');
      const release = join(directory, 'registry', 'fixture', '.papercusp', 'apps-copy', '.portal-runtime', 'portal', 'releases', 'generation');
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, '.papercusp-release.json'), JSON.stringify({ schemaVersion: 1,
        release: 'generation', buildId: 'fixture', publishedAt: '2026-10-08T00:00:00Z' }));
      writeFileSync(join(release, 'standalone-entry.mjs'), 'fixture');
      // An uninitialized sibling is walked, not mistaken for a valid store.
      mkdirSync(join(directory, 'registry', 'fixture', '.papercusp', 'legacy', 'hyperbee'), { recursive: true });
      writeFileSync(join(directory, 'unknown'), 'fixture');
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      const cloneWriter = readFileSync(join(root, 'packages/operator-core/lib/harness/clone-github.ts'), 'utf8');
      expect(cloneWriter).toContain("join(workspacesRoot(), 'clones')");
      const clone = join(directory, 'registry', 'clones', 'owned');
      const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', '--', root, clone], { encoding: 'utf8' });
      expect(cloned.status, cloned.stderr).toBe(0);
      writeFileSync(join(clone, 'uncommitted-state'), 'preserve');
      mkdirSync(join(directory, 'registry', 'clones', 'unowned'));
      writeFileSync(join(directory, 'registry', 'clones', 'unowned', 'unknown'), 'fixture');
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-roots.mts'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, HOME: directory, PAPERCUSP_HOME: directory,
            XDG_CONFIG_HOME: join(directory, '.config'),
            PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
            PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
            PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
            PAPERCUSP_CHECKPOINT_LOG_DIR: join(directory, 'checkpoint-history'),
            PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') },
        });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.trim(), result.stderr).not.toBe('');
      const report = JSON.parse(result.stdout);
      expect(report.wholeInstallVerified).toBe(false);
      expect(report.scope).toBe('implemented-writer-filesystem-roots-only');
      expect(report.representedPeers).toHaveLength(2);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/hyperbee')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/.restored/snapshot/clone/'))).toBe(true);
      expect(report.representedPeers[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedReleases[0].disposition).toBe('preserve-state-subtree');
      expect(report.representedSubtrees.some((entry: { name: string }) => entry.name === 'checkpoint-history')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name.endsWith('.next-build-123-456-abcd')).classification).toBe('cache');
      expect(report.residue.some((entry: { name: string }) => entry.name === 'unknown')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'affected-cache/unowned-cache-entry')).toBe(true);
      expect(report.representedGit.some((entry: { name: string }) => entry.name === 'registry/clones/owned')).toBe(true);
      expect(report.inventory.find((entry: { name: string }) => entry.name === 'registry/clones').classification).toBe('state');
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/clones/owned/uncommitted-state')).toBe(false);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/clones/unowned')).toBe(true);
      expect(report.representedUnknown.some((entry: { name: string }) => entry.name === 'registry/clones/unowned')).toBe(true);
      // Exercise the same entry inside the Vitest worker so loaded source is
      // observable, rather than treating the child CLI as source identity proof.
      for (const [key, value] of Object.entries({ HOME: directory, PAPERCUSP_HOME: directory,
        XDG_CONFIG_HOME: join(directory, '.config'), PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'),
        PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'), PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
        PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key') })) vi.stubEnv(key, value);
      const inProcess = await runRootCensus({ checkpointLogDir: join(directory, 'checkpoint-history') });
      expect(inProcess.wholeInstallVerified).toBe(false);
      expect(inProcess.ok).toBe(false);
      expect(inProcess.scope).toBe(report.scope);
      expect(inProcess.residue.map(entry => `${entry.kind}:${entry.root}:${entry.name}`).sort())
        .toEqual(report.residue.map((entry: { kind: string; root: string; name: string }) => `${entry.kind}:${entry.root}:${entry.name}`).sort());
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('includes receipt-backed reaper tails in the root census and leaves unproven tails as residue', async () => {
    const directory = fixtureHome;
    try {
      const env = {
        HOME: directory, PAPERCUSP_HOME: directory, XDG_CONFIG_HOME: join(directory, '.config'),
        PAPERCUSP_WORKSPACES_ROOT: join(directory, 'registry'), PAPERCUSP_SCRATCH_ROOT: join(directory, 'spills'),
        PAPERCUSP_STRIP_CACHE_DIR: join(directory, 'analysis-cache'),
        AFFECTED_TASK_HISTORY_PATH: join(directory, 'affected-cache', 'durations.json'),
        AFFECTED_TASK_VERDICT_CACHE_PATH: join(directory, 'affected-cache', 'verdict.json'),
        PAPERCUSP_DB_ENCRYPTION_KEY_FILE: join(directory, 'db-key'),
      };
      mkdirSync(directory, { recursive: true });
      for (const path of [env.PAPERCUSP_WORKSPACES_ROOT, env.PAPERCUSP_SCRATCH_ROOT, env.PAPERCUSP_STRIP_CACHE_DIR,
        join(directory, 'affected-cache'), join(directory, '.config', 'papercusp'), join(directory, '.papercusp', 'secrets'),
        join(directory, 'checkpoint-history')]) {
        mkdirSync(path, { recursive: true });
      }
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const source = join(directory, 'reaper-output.log');
      writeFileSync(source, 'fixture tail bytes');
      await archiveReapTail('task-123', source, directory, new Date('2026-10-11T12:00:00.000Z'));
      const orphan = 'reap-archive/2026-10-11/unproven.tail.log';
      const mergedRootPrefix = '.papercusp/';
      writeFileSync(join(directory, '.papercusp', orphan), 'unproven fixture');

      const report = await runRootCensus({ checkpointLogDir: join(directory, 'checkpoint-history') });
      const inventoryNames = report.inventory.map(entry => entry.name);
      expect(inventoryNames).toContain(`${mergedRootPrefix}reap-archive/2026-10-11/task-123.tail.log`);
      expect(inventoryNames).toContain(`${mergedRootPrefix}reap-archive/2026-10-11/task-123.tail.log.receipt.json`);
      expect(report.residue.some(entry => entry.name === `${mergedRootPrefix}${orphan}`)).toBe(true);
    } finally {
      rmSync(join(directory, '.papercusp', 'reap-archive'), { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')('returns drift exit1 for an unknown installed unit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'census-cli-'));
    try {
      writeFileSync(join(directory, 'systemctl'),
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{unit_file:"fixture-unowned-census-unique.service"}]));\n',
        { mode: 0o755 });
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      const result = spawnSync(process.execPath,
        ['--import', 'tsx', 'scripts/state-census-units.mts', '--system'], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` },
        });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.scope).toBe('systemd-system-only');
      expect(report.ok).toBe(false);
      expect(report.residue.map((entry: { name: string }) => entry.name))
        .toEqual(['fixture-unowned-census-unique.service']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
