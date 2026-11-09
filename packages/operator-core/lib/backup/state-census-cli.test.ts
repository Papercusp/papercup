import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRootCensus, discoverRootCensusInputs, readMigrationCensusColumns, readWorkspaceCensusAccounts, readWorkspaceSetupHomes, readRetainedReapTaskIds } from '../../../../scripts/state-census-roots.mts';
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
  it('recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-latch-census-'));
    const terminalStates = ['exited', 'killed', 'timed_out', 'stranded', 'ended_unobserved'];
    const rejected = ['missing', 'null', 'array', 'string', 'wrong-key', 'wrong-task', 'wrong-source',
      'running', 'unknown-state', 'zero-fire', 'invalid-fire'];
    const ids = ['ledger', ...terminalStates, ...rejected];
    const latch = (taskId: string, overrides = {}) => ({ eventKey: `task:terminal:${taskId}`,
      lastFiredBy: 'task-manager', lastPayload: { taskId, state: 'stranded' }, fireCount: '1', ...overrides });
    const readTasks = vi.fn(async (_workspace: string, _ids: string[]) => [{ taskId: 'ledger' }, { taskId: 'unrequested' }]);
    const readTerminalLatches = vi.fn(async (_keys: string[]) => [
      ...terminalStates.map(state => latch(state, { lastPayload: { taskId: state, state } })),
      latch('null', { lastPayload: null }), latch('array', { lastPayload: [] }),
      latch('string', { lastPayload: JSON.stringify({ taskId: 'string', state: 'stranded' }) }),
      latch('wrong-key', { eventKey: 'task:other:wrong-key' }),
      latch('wrong-task', { lastPayload: { taskId: 'missing', state: 'stranded' } }),
      latch('wrong-source', { lastFiredBy: 'another-writer' }),
      latch('running', { lastPayload: { taskId: 'running', state: 'running' } }),
      latch('unknown-state', { lastPayload: { taskId: 'unknown-state', state: 'terminal' } }),
      latch('zero-fire', { fireCount: 0 }), latch('invalid-fire', { fireCount: 'NaN' }),
      latch('unrequested'),
    ]);
    try {
      const directory = join(home, '.papercusp', 'reap-archive', '2026-10-11');
      mkdirSync(directory, { recursive: true });
      for (const id of ids) writeFileSync(join(directory, `${id}.tail.log`), 'archived tail without sidecar');
      const producer = await censusProducers.reapArchiveCensusProducer(home, [], taskIds =>
        readRetainedReapTaskIds(taskIds, [{ id: 'active' }, { id: 'inactive' }, { id: 'active' }],
          { readTasks, readTerminalLatches, readReaperMessages: async () => [] }));
      expect(readTasks.mock.calls).toHaveLength(2);
      expect(readTasks).toHaveBeenCalledWith('active', expect.arrayContaining(ids));
      expect(readTasks).toHaveBeenCalledWith('inactive', expect.arrayContaining(ids));
      expect(readTerminalLatches).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining(
        ids.filter(id => id !== 'ledger').map(id => `task:terminal:${id}`)));
      expect(readTerminalLatches.mock.calls[0][0]).not.toContain('task:terminal:ledger');
      const census = await collectStateCensus({ ...producer, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.name.endsWith('.tail.log') && entry.classification === 'state')
        .map(entry => entry.name.split('/').at(-1)).sort()).toEqual(['ledger', ...terminalStates].map(id => `${id}.tail.log`).sort());
      expect(census.residue.map(entry => entry.name.split('/').at(-1)).sort())
        .toEqual(rejected.map(id => `${id}.tail.log`).sort());
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('bounds reaper identity reads, skips needless latches and propagates unavailable evidence', async () => {
    const readTasks = vi.fn(async (_workspace: string, ids: string[]) => ids.map(taskId => ({ taskId })));
    const readTerminalLatches = vi.fn(async (_keys: string[]) => []);
    const readers = { readTasks, readTerminalLatches };
    expect(await readRetainedReapTaskIds([], [], readers)).toEqual([]);
    await expect(readRetainedReapTaskIds(Array.from({ length: 1001 }, (_, n) => `${n}`), [], readers))
      .rejects.toThrow('batch bound exceeded');
    expect(readTasks).not.toHaveBeenCalled(); expect(readTerminalLatches).not.toHaveBeenCalled();
    expect(await readRetainedReapTaskIds(['known', 'known'], [{ id: 'active' }], readers)).toEqual(['known']);
    expect(readTasks).toHaveBeenCalledExactlyOnceWith('active', ['known']);
    expect(readTerminalLatches).not.toHaveBeenCalled();
    await expect(readRetainedReapTaskIds(['unknown'], [], {
      readTerminalLatches: async () => { throw new Error('latch evidence unavailable'); },
    })).rejects.toThrow('latch evidence unavailable');
  });

  it('recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-message-census-'));
    const ids = ['known', 'failed', 'literal.id', 'literalXid', 'foreign', 'forged', 'unrelated', 'missing', 'prefix'];
    const summary = (outcomes: string) => '[task-reaper] reaped 1/2 agent-session scope(s). '
      + 'Log tails archived under ~/.papercusp/reap-archive/. ' + outcomes;
    const message = (outcomes: string, overrides = {}) => ({ workspaceId: 'active', writerKey: 'task-manager',
      from: 'task-manager', summary: summary(outcomes), ...overrides });
    const readReaperMessages = vi.fn(async (_scopes: string[], _ids: string[]) => [
      message('✓ known (quiet-zombie) · ✗ failed (terminal-residue) · ✓ literal.id (managed-residue)'),
      message('✓ foreign (quiet-zombie)', { workspaceId: 'foreign' }),
      message('✓ forged (quiet-zombie)', { writerKey: 'other' }),
      message('✓ forged (quiet-zombie)', { from: 'other' }),
      message('✓ unrelated (quiet-zombie)', { summary: 'unrelated ' + summary('✓ unrelated (quiet-zombie)') }),
      message('✓ unrelated (quiet-zombie)', { summary: '[task-reaper] reaped ✓ unrelated (quiet-zombie)' }),
      message('✓ prefix-extra (quiet-zombie) · ✓ missing (unknown-kind) · ✓ unrequested (quiet-zombie)'),
    ]);
    try {
      const directory = join(home, '.papercusp', 'reap-archive', '2026-08-25');
      mkdirSync(directory, { recursive: true });
      for (const id of ids) writeFileSync(join(directory, `${id}.tail.log`), 'old archive without receipt');
      const producer = await censusProducers.reapArchiveCensusProducer(home, [], taskIds => readRetainedReapTaskIds(
        taskIds, [{ id: 'active' }, { id: 'active' }], {
          readTasks: async () => [], readTerminalLatches: async () => [], readReaperMessages,
        }));
      expect(readReaperMessages).toHaveBeenCalledExactlyOnceWith(['active'], expect.arrayContaining(ids));
      const census = await collectStateCensus({ ...producer, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'state' && entry.name.endsWith('.tail.log'))
        .map(entry => entry.name.split('/').at(-1)).sort()).toEqual(['failed.tail.log', 'known.tail.log', 'literal.id.tail.log']);
      expect(census.residue).toHaveLength(ids.length - 3);
      await expect(readRetainedReapTaskIds(['known'], [{ id: 'active' }], {
        readTasks: async () => [], readTerminalLatches: async () => [],
        readReaperMessages: async () => Array.from({ length: 2000 }, () => message('✓ known (quiet-zombie)')),
      })).rejects.toThrow('Reaper message evidence bound exceeded');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

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
      const nestedPeer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'retained-app', 'hyperbee');
      mkdirSync(join(nestedPeer, 'db'), { recursive: true });
      writeFileSync(join(nestedPeer, 'CORESTORE'), 'device/platform=linux\ndevice/inode=456\ndevice/created=789\n');
      writeFileSync(join(nestedPeer, 'db', 'persistent-log'), 'preserved state');
      const unprovenPeer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'unproven-app', 'hyperbee');
      mkdirSync(join(unprovenPeer, 'db'), { recursive: true });
      writeFileSync(join(unprovenPeer, 'db', 'unknown-log'), 'unproven');
      const lock = { pid: process.pid, token: '2f8f5ba0-d4ba-4c88-8884-2f2a7969683a',
        startedAt: '2026-11-09T00:00:00.000Z' };
      const lockSuffix = '.single-instance.lock';
      const acceptedLocks = new Map([
        [`${peer}${lockSuffix}`, JSON.stringify({ ...lock, processIdentity: 'linux:fixture-start' })],
        [`${nestedPeer}${lockSuffix}`, JSON.stringify({ ...lock, processIdentity: null })],
        [`${restoredPeer}${lockSuffix}`, JSON.stringify(lock)],
      ]);
      for (const [path, content] of acceptedLocks) writeFileSync(path, content);
      const lockInodes = [...acceptedLocks.keys()].map(path => lstatSync(path).ino);
      const rejectedContents = new Map([
        ['empty', ''], ['malformed', '{'], ['array', '[]'], ['null', 'null'],
        ['oversized', JSON.stringify(lock).padEnd(4097, ' ')],
        ...Object.entries({ 'string-pid': { pid: '123' }, 'zero-pid': { pid: 0 },
          'negative-pid': { pid: -1 }, 'fractional-pid': { pid: 1.5 },
          'unsafe-pid': { pid: Number.MAX_SAFE_INTEGER + 1 }, 'missing-token': { token: undefined },
          'invalid-token': { token: 'unproven' }, 'invalid-date': { startedAt: '2026-02-30T00:00:00.000Z' },
          'missing-date': { startedAt: undefined }, 'non-iso-date': { startedAt: '2026-11-09' },
          'numeric-identity': { processIdentity: 1 }, 'empty-identity': { processIdentity: '' },
          'oversized-identity': { processIdentity: 'x'.repeat(1025) },
          'control-identity': { processIdentity: 'linux:\n' }, 'extra-field': { unknown: true },
        }).map(([name, fields]) => [name, JSON.stringify({ ...lock, ...fields })] as [string, string]),
      ]);
      const rejectedLocks: string[] = [`${unprovenPeer}${lockSuffix}`];
      writeFileSync(rejectedLocks[0], JSON.stringify(lock));
      for (const kind of [...rejectedContents.keys(), 'symlink', 'directory',
        ...(process.platform === 'linux' ? ['fifo'] : [])]) {
        const store = join(directory, 'registry', 'fixture', '.papercusp', `lock-case-${kind}`, 'hyperbee');
        mkdirSync(join(store, 'db'), { recursive: true });
        writeFileSync(join(store, 'CORESTORE'), 'device/platform=linux\ndevice/inode=123\ndevice/created=456\n');
        const path = `${store}${lockSuffix}`;
        rejectedLocks.push(path);
        if (kind === 'symlink') symlinkSync(`${peer}${lockSuffix}`, path);
        else if (kind === 'directory') mkdirSync(path);
        else if (kind === 'fifo') expect(spawnSync('mkfifo', [path]).status).toBe(0);
        else writeFileSync(path, rejectedContents.get(kind)!);
      }
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
      expect(report.representedPeers).toHaveLength(3 + rejectedLocks.length - 1);
      for (const path of acceptedLocks.keys()) {
        const name = path.slice(directory.length + 1).split('\\').join('/');
        expect(report.inventory.find((entry: { name: string }) => entry.name === name))
          .toMatchObject({ classification: 'cache', producers: ['corestore-single-instance-lock'] });
        expect(report.residue.some((entry: { name: string }) => entry.name === name)).toBe(false);
      }
      for (const path of rejectedLocks) {
        const name = path.slice(directory.length + 1).split('\\').join('/');
        expect(report.residue.some((entry: { name: string }) => entry.name === name), name).toBe(true);
      }
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/hyperbee')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/.restored/snapshot/clone/'))).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app/hyperbee')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/unproven-app/'))).toBe(false);
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
      for (const [path, content] of acceptedLocks) expect(readFileSync(path, 'utf8')).toBe(content);
      expect([...acceptedLocks.keys()].map(path => lstatSync(path).ino)).toEqual(lockInodes);
      expect(readlinkSync(rejectedLocks.find(path => path.includes('lock-case-symlink'))!)).toBe(`${peer}${lockSuffix}`);
      for (const [kind, content] of rejectedContents) {
        expect(readFileSync(rejectedLocks.find(path => path.includes(`lock-case-${kind}/`))!, 'utf8')).toBe(content);
      }
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
