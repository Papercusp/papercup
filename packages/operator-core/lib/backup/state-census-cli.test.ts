import { afterAll, describe, expect, it, vi } from 'vitest';
import { type Stats, mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, symlinkSync, lstatSync, readlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRootCensus, discoverRootCensusInputs, readMigrationCensusColumns, readWorkspaceCensusAccounts, readWorkspaceSetupHomes, readRetainedReapTaskIds } from '../../../../scripts/state-census-roots.mts';
import { collectStateCensus } from '../../../../packages/backup/src/state-census';
import { archiveReapTail } from '../task-manager/reap-archive';
import * as censusProducers from './state-census-producers';
import { setEnvEnabled } from '../harness/env-switcher-prefs';
import { dbEncryptionKeyFilePath, ensureDbEncryptionKeyFile } from '../db-encryption';
import { oauthStateKeyFilePath, ensureOAuthStateKeyFile } from '../oauth/state';

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
  it('enforces an explicit root census budget across filesystem and catalog entries without hiding residue', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bounded-root-census-'));
    try {
      writeFileSync(join(directory, 'owned'), 'fixture');
      writeFileSync(join(directory, 'unknown'), 'residue');
      const inputs = { scope: 'bounded-fixture', roots: [{ id: 'fixture', path: directory }],
        declarations: [{ kind: 'path' as const, root: 'fixture', name: 'owned', producer: 'fixture', classification: 'state' as const }],
        catalogEntries: [{ kind: 'database' as const, root: 'cluster', name: 'unknown-database' }] };
      await expect(runRootCensus({ inputs, maxEntries: 1 })).rejects.toThrow('Census entry bound exceeded: 1; root=fixture');
      await expect(runRootCensus({ inputs, args: ['--max-entries', '2'] })).rejects.toThrow('Census entry bound exceeded: 2');
      const report = await runRootCensus({ inputs, args: ['--max-entries=3'] });
      expect(report.inventory).toHaveLength(3);
      expect(report.residue.map(entry => entry.name).sort()).toEqual(['unknown', 'unknown-database']);
      expect(report.ok).toBe(false);
      expect(report.wholeInstallVerified).toBe(false);
      expect(await runRootCensus({ inputs, maxEntries: 3 })).toEqual(report);
      expect(await runRootCensus({ inputs })).toEqual(report);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects invalid or ambiguous entry budgets before discovery or snapshot side effects', async () => {
    const installed = vi.spyOn(censusProducers, 'installedRootCensusProducers').mockImplementation(() => { throw new Error('discovery started'); });
    const snapshot = vi.fn();
    try {
      for (const value of ['', '0', '-1', '1.5', '1e3', '9007199254740992', '--host-catalogs']) {
        await expect(runRootCensus({ args: ['--max-entries', value], onDiscoverySnapshot: snapshot }))
          .rejects.toThrow('Invalid census entry bound');
      }
      await expect(runRootCensus({ args: ['--max-entries'] })).rejects.toThrow('Invalid census entry bound');
      for (const maxEntries of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(runRootCensus({ maxEntries, onDiscoverySnapshot: snapshot })).rejects.toThrow('Invalid census entry bound');
      }
      await expect(runRootCensus({ args: ['--max-entries=3', '--max-entries', '4'] })).rejects.toThrow('only once');
      await expect(runRootCensus({ maxEntries: 3, args: ['--max-entries=3'] })).rejects.toThrow('only once');
      expect(installed).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
    } finally { installed.mockRestore(); }
  });

  it('retains complete collection inputs and replays them without discovery or host catalog reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'collection-only-census-'));
    const installed = vi.spyOn(censusProducers, 'installedRootCensusProducers').mockImplementation(() => { throw new Error('discovery must not run'); });
    try {
      writeFileSync(join(directory, 'owned'), 'fixture');
      writeFileSync(join(directory, 'unknown'), 'residue');
      const inputs = { scope: 'saved-fixture-input', roots: [{ id: 'fixture', path: directory }],
        declarations: [{ kind: 'path' as const, root: 'fixture', name: 'owned', producer: 'fixture', classification: 'state' as const },
          { kind: 'database' as const, root: 'cluster', name: 'database', producer: 'schema', classification: 'state' as const }],
        catalogEntries: [{ kind: 'database' as const, root: 'cluster', name: 'database' }] };
      let saved: typeof inputs | undefined;
      const phases: string[] = [];
      const report = await runRootCensus({ inputs: JSON.parse(JSON.stringify(inputs)),
        onDiscoverySnapshot: async snapshot => {
          await Promise.resolve();
          expect(snapshot.phase).toBe('before-collection');
          expect(snapshot).not.toHaveProperty('ok');
          saved = JSON.parse(JSON.stringify(snapshot));
        },
        onCollectionProgress: async progress => { expect(saved).toBeDefined(); phases.push(progress.phase); },
      });
      expect(installed).not.toHaveBeenCalled();
      expect(saved).toMatchObject(inputs);
      expect(report.scope).toBe(inputs.scope);
      expect(report.wholeInstallVerified).toBe(false);
      expect(report.residue.map(entry => entry.name)).toEqual(['unknown']);
      expect(report.inventory.find(entry => entry.kind === 'database')?.producers).toEqual(['schema']);
      expect(phases.at(-1)).toBe('complete');
      const replay = await runRootCensus({ inputs: saved });
      expect(replay).toEqual(report);
      await expect(runRootCensus({ inputs, onDiscoverySnapshot: async () => { throw new Error('snapshot unavailable'); },
        onCollectionProgress: () => { throw new Error('collection started too early'); },
      })).rejects.toThrow('snapshot unavailable');
    } finally { installed.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });

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
      expect(readTasks.mock.calls).toHaveLength(3);
      expect(readTasks).toHaveBeenCalledWith('active', expect.arrayContaining(ids));
      expect(readTasks).toHaveBeenCalledWith('inactive', expect.arrayContaining(ids));
      expect(readTasks).toHaveBeenCalledWith('default', expect.arrayContaining(ids));
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
    expect(readTasks.mock.calls).toEqual([['active', ['known']], ['default', ['known']]]);
    expect(readTerminalLatches).not.toHaveBeenCalled();
    await expect(readRetainedReapTaskIds(['unknown'], [], {
      readTasks: async () => [],
      readTerminalLatches: async () => { throw new Error('latch evidence unavailable'); },
    })).rejects.toThrow('latch evidence unavailable');
  });

  it('recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reap-message-census-'));
    const ids = ['known', 'failed', 'literal.id', 'consult', 'sidecar', 'literalXid', 'foreign', 'forged',
      'unrelated', 'missing', 'prefix', 'unarchived'];
    const summary = (outcomes: string) => '[task-reaper] reaped 1/2 agent-session scope(s). '
      + 'Log tails archived under ~/.papercusp/reap-archive/. ' + outcomes;
    const message = (outcomes: string, overrides = {}) => ({ workspaceId: 'active', writerKey: 'task-manager',
      from: 'task-manager', summary: summary(outcomes), ...overrides });
    const readReaperMessages = vi.fn(async (_scopes: string[], _ids: string[]) => [
      message('✓ known (quiet-zombie) · ✗ failed (terminal-residue) · ✓ literal.id (managed-residue)'
        + ' · ✓ consult (consult-settled) · ✓ sidecar (orphaned-sidecar)'),
      message('✓ foreign (orphaned-sidecar)', { workspaceId: 'foreign' }),
      message('✓ forged (orphaned-sidecar)', { writerKey: 'other' }),
      message('✓ forged (orphaned-sidecar)', { from: 'other' }),
      message('✓ unrelated (quiet-zombie)', { summary: 'unrelated ' + summary('✓ unrelated (quiet-zombie)') }),
      message('✓ unrelated (quiet-zombie)', { summary: '[task-reaper] reaped ✓ unrelated (quiet-zombie)' }),
      message('✓ unarchived (orphaned-sidecar)', {
        summary: '[task-reaper] reaped 1/1 agent-session scope(s). ✓ unarchived (orphaned-sidecar)',
      }),
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
      expect(readReaperMessages).toHaveBeenCalledExactlyOnceWith(['active', 'default'], expect.arrayContaining(ids));
      const census = await collectStateCensus({ ...producer, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'state' && entry.name.endsWith('.tail.log'))
        .map(entry => entry.name.split('/').at(-1)).sort()).toEqual([
        'consult.tail.log', 'failed.tail.log', 'known.tail.log', 'literal.id.tail.log', 'sidecar.tail.log',
      ]);
      expect(census.residue).toHaveLength(ids.length - 5);
      await expect(readRetainedReapTaskIds(['known'], [{ id: 'active' }], {
        readTasks: async () => [], readTerminalLatches: async () => [],
        readReaperMessages: async () => Array.from({ length: 2000 }, () => message('✓ known (quiet-zombie)')),
      })).rejects.toThrow('Reaper message evidence bound exceeded');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('retains exact legacy task and message identities when default is absent from the registry', async () => {
    const ids = ['legacy-task', 'legacy-message', 'foreign', 'unrequested'];
    const readTasks = vi.fn(async (workspace: string) => workspace === 'default'
      ? [{ taskId: 'legacy-task' }, { taskId: 'not-requested' }] : []);
    const summary = (id: string) => '[task-reaper] reaped 1/1 agent-session scope(s). '
      + `Log tails archived under ~/.papercusp/reap-archive/. ✓ ${id} (quiet-zombie)`;
    const readReaperMessages = vi.fn(async () => [
      { workspaceId: 'default', writerKey: 'task-manager', from: 'task-manager', summary: summary('legacy-message') },
      { workspaceId: 'unregistered-foreign', writerKey: 'task-manager', from: 'task-manager', summary: summary('foreign') },
      { workspaceId: 'default', writerKey: 'another-writer', from: 'task-manager', summary: summary('unrequested') },
    ]);
    const result = await readRetainedReapTaskIds(ids, [], {
      readTasks, readTerminalLatches: async () => [], readReaperMessages,
    });
    expect(result.sort()).toEqual(['legacy-message', 'legacy-task']);
    expect(readTasks).toHaveBeenCalledExactlyOnceWith('default', ids);
    expect(readReaperMessages).toHaveBeenCalledExactlyOnceWith(['default'],
      ['legacy-message', 'foreign', 'unrequested']);
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
  it('composes installed environment secrets before credential discovery without needing a database catalogue', async () => {
    const registry = join(fixtureHome, 'registry');
    const state = join(fixtureHome, '.papercusp');
    const units = join(fixtureHome, 'units');
    mkdirSync(registry, { recursive: true }); mkdirSync(state, { recursive: true }); mkdirSync(units);
    writeFileSync(join(state, 'referenced.env'), 'opaque private bytes', { mode: 0o000 });
    writeFileSync(join(state, 'unreferenced.env'), 'opaque private bytes', { mode: 0o000 });
    writeFileSync(join(units, 'fixture.service'), '[Service]\nEnvironmentFile=%h/.papercusp/referenced.env\n');
    const installed = vi.spyOn(censusProducers, 'installedUnitCensusDeclarations').mockImplementation(scope =>
      scope === 'user' ? censusProducers.unitCensusDeclarations(units, scope) : Promise.resolve([]));
    const credentials = vi.spyOn(censusProducers, 'accountCredentialCensusProducer').mockRejectedValue(new Error('stop before databases'));
    let snapshot: Parameters<NonNullable<NonNullable<Parameters<typeof discoverRootCensusInputs>[0]>['onDiscoverySnapshot']>>[0] | undefined;
    try {
      await expect(discoverRootCensusInputs({ args: ['--host-catalogs'], historicalWriterEvidence: [], hostedProfileEvidence: [],
        checkpointLogDir: join(fixtureHome, 'checkpoint-history'),
        onDiscoverySnapshot: value => { snapshot = value; },
      })).rejects.toThrow('stop before databases');
      expect(installed).toHaveBeenCalledWith('user'); expect(installed).toHaveBeenCalledWith('system');
      expect(snapshot?.phase).toBe('before-account-credentials');
      const declaration = snapshot?.declarations.find(entry => entry.producer === 'unit-environment-file:systemd-user:fixture.service');
      expect(declaration).toMatchObject({ kind: 'path', classification: 'secret' });
      const root = snapshot!.roots.find(candidate => candidate.id === declaration!.root)!;
      expect(join(root.path, declaration!.name)).toBe(join(state, 'referenced.env'));
      const census = await collectStateCensus({ roots: [root], declarations: [declaration!], readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === declaration!.name)?.classification).toBe('secret');
      expect(census.residue.some(entry => join(root.path, entry.name) === join(state, 'unreferenced.env'))).toBe(true);
    } finally {
      installed.mockRestore(); credentials.mockRestore();
      rmSync(registry, { recursive: true, force: true }); rmSync(units, { recursive: true, force: true });
      rmSync(join(state, 'referenced.env')); rmSync(join(state, 'unreferenced.env'));
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
    writeFileSync(join(directory, 'bounded-output.json'), 'bounded verifier fixture');
    writeFileSync(unknown, 'unproven fixture', { mode: 0o600 });
    const evidence = [{ ref: 'archive:fixture', toolInput: 'fixture', receipt: '{}',
      startedAt: '2026-10-03T05:10:33Z', finishedAt: '2026-10-03T05:10:34Z' }];
    // Detailed writer/receipt/byte admission is exercised by the producer suite;
    // this test guards the canonical census composition boundary.
    const producer = vi.spyOn(censusProducers, 'historicalStripeConfigCensusProducer').mockResolvedValue({
      roots: [{ id: 'stripe-fixture', path: directory }], declarations: [{ kind: 'path', root: 'stripe-fixture',
        name: 'receipt-backed.json', classification: 'secret', producer: 'historical-stripe-test-config:archive:fixture' }],
    });
    const verifierProducer = vi.spyOn(censusProducers, 'historicalVerifierArtifactCensusProducer').mockResolvedValue({
      roots: [{ id: 'verifier-fixture', path: directory }], declarations: [{ kind: 'path', root: 'verifier-fixture',
        name: 'bounded-output.json', classification: 'state', producer: 'historical-verifier-artifact:archive:fixture' }],
    });
    try {
      const stages: string[] = [];
      const report = await runRootCensus({ checkpointLogDir: join(fixtureHome, 'checkpoint-history'),
        historicalWriterEvidence: evidence, onStage: stage => stages.push(stage) });
      expect(producer).toHaveBeenCalledWith(evidence);
      expect(verifierProducer).toHaveBeenCalledWith(evidence, expect.any(Array));
      expect(report.inventory.some(entry => entry.producers.includes('historical-verifier-artifact:archive:fixture') && entry.classification === 'state')).toBe(true);
      expect(report.inventory.some(entry => entry.producers.includes('historical-stripe-test-config:archive:fixture') && entry.classification === 'secret')).toBe(true);
      expect(report.residue.some(entry => entry.name.endsWith('unproven.json'))).toBe(true);
      expect(report.inventory.find(entry => entry.name === 'spills')?.classification).toBe('cache');
      expect(report.inventory.some(entry => entry.name.startsWith('spills/'))).toBe(false);
      expect(report.inventory.find(entry => entry.name === '.papercusp/fs-mutex-locks')?.classification).toBe('cache');
      expect(report.wholeInstallVerified).toBe(false);
      expect(stages[0]).toBe('installed-roots');
      expect(stages.at(-1)).toBe('complete');
      expect(stages).toContain('collect-state-census');
      expect(stages).toContain('historical-verifier-artifacts');
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
      producer.mockRestore(); verifierProducer.mockRestore();
      rmSync(join(directory, 'bounded-output.json'), { force: true });
      rmSync(owned, { force: true }); rmSync(unknown, { force: true });
      rmSync(registry, { recursive: true, force: true });
      rmSync(spills, { recursive: true, force: true });
      rmSync(mutex, { recursive: true, force: true });
    }
  });
  it('retains inactive workspace runtime state without owning copied foreign files or unregistered homes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-setup-census-'));
    try {
      const active = join(parent, 'active');
      const inactive = join(parent, 'inactive');
      const unregistered = join(parent, 'unregistered');
      const name = 'deploy-credentials/.codex-setup-account-1234abcd';
      for (const home of [active, inactive, unregistered]) {
        mkdirSync(join(home, name), { recursive: true });
        writeFileSync(join(home, name, 'auth.json'), 'opaque');
        writeFileSync(join(home, name, 'foreign-source.ts'), 'foreign');
        writeFileSync(join(home, 'deploy-credentials', 'unreferenced.json'), 'unproven credential');
        mkdirSync(join(home, 'crash-reports'), { recursive: true });
        writeFileSync(join(home, 'crash-reports', 'report.json'), 'retained diagnostic');
        mkdirSync(join(home, 'snapshot-fold-checkpoints', 'nested'), { recursive: true });
        writeFileSync(join(home, 'snapshot-fold-checkpoints', 'nested', 'checkpoint.json'), 'retained checkpoint');
        writeFileSync(join(home, 'foreign-source.ts'), 'unrelated sibling');
      }
      const result = await readWorkspaceSetupHomes([{ id: 'active' }, { id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active, inactive]);
      expect(result.roots.some(root => root.path === unregistered)).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        const inventory = census.inventory.filter(entry => entry.root === root.id);
        expect(inventory.filter(entry => entry.classification === 'state').map(entry => entry.name).sort())
          .toEqual(['deploy-credentials', name, 'crash-reports', 'crash-reports/report.json',
            'snapshot-fold-checkpoints', 'snapshot-fold-checkpoints/nested',
            'snapshot-fold-checkpoints/nested/checkpoint.json'].sort());
        expect(inventory.filter(entry => entry.classification === 'secret').map(entry => entry.name))
          .toEqual([`${name}/auth.json`]);
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual([`${name}/foreign-source.ts`, 'deploy-credentials/unreferenced.json', 'foreign-source.ts'].sort());
      }
      expect(result.declarations.every(entry => !entry.prune)).toBe(true);
      expect(result.declarations.filter(entry => entry.descendants).map(entry => entry.name))
        .toEqual(['crash-reports', 'snapshot-fold-checkpoints', 'crash-reports', 'snapshot-fold-checkpoints']);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it.each(['default', 'mounted'])('retains real default db and OAuth keys across known homes with %s current keys', async current => {
    const parent = mkdtempSync(join(tmpdir(), 'retained-runtime-keys-'));
    const saved = new Map(['PAPERCUSP_HOME', 'PAPERCUSP_DB_ENCRYPTION_KEY_FILE', 'PAPERCUSP_OAUTH_STATE_KEY_FILE']
      .map(key => [key, process.env[key]]));
    const active = join(parent, 'active');
    const homes = [active, join(parent, 'inactive'), join(parent, 'default'), join(parent, '.papercusp')];
    const foreign = join(parent, 'foreign');
    const keys = ['db-encryption-key', 'oauth-state-key'];
    const before = new Map<string, Stats>();
    try {
      for (const home of [...homes, foreign]) {
        process.env.PAPERCUSP_HOME = ` ${home} \t`;
        delete process.env.PAPERCUSP_DB_ENCRYPTION_KEY_FILE;
        delete process.env.PAPERCUSP_OAUTH_STATE_KEY_FILE;
        expect(dbEncryptionKeyFilePath()).toBe(join(home, keys[0]));
        expect(oauthStateKeyFilePath()).toBe(join(home, keys[1]));
        ensureDbEncryptionKeyFile(dbEncryptionKeyFilePath());
        ensureOAuthStateKeyFile(oauthStateKeyFilePath());
        mkdirSync(join(home, 'nested'));
        for (const key of keys) {
          writeFileSync(join(home, `${key}.bak`), 'unproven backup');
          writeFileSync(join(home, `${key}.copy`), 'unproven copy');
          writeFileSync(join(home, 'nested', key), 'unproven nested key');
          if (process.platform !== 'win32') chmodSync(join(home, key), 0);
          before.set(join(home, key), lstatSync(join(home, key)));
        }
      }
      process.env.PAPERCUSP_HOME = active;
      for (const [env, name] of [['PAPERCUSP_DB_ENCRYPTION_KEY_FILE', 'db'], ['PAPERCUSP_OAUTH_STATE_KEY_FILE', 'oauth']]) {
        if (current === 'mounted') process.env[env] = join(parent, 'absent-mount', name);
        else delete process.env[env];
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active, parent);
      expect(result.roots.map(root => root.path)).toEqual(homes);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        for (const [index, key] of keys.entries()) {
          expect(census.inventory.find(entry => entry.root === root.id && entry.name === key))
            .toMatchObject({ classification: 'secret', producers: [index === 0 ? 'db-encryption' : 'oauth-state-signing-key'] });
          const declaration = result.declarations.find(entry => entry.root === root.id && entry.name === key)!;
          expect(declaration.descendants).toBeUndefined();
          expect(declaration.prune).toBeUndefined();
        }
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual(['nested', ...keys.flatMap(key => [`${key}.bak`, `${key}.copy`, `nested/${key}`])].sort());
      }
      for (const [path, stat] of before) {
        const after = lstatSync(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      expect(existsSync(join(parent, 'absent-mount'))).toBe(false);
      expect(census.ok).toBe(false);
      rmSync(homes[2], { recursive: true });
      symlinkSync(foreign, homes[2]);
      expect((await readWorkspaceSetupHomes([], workspace => join(parent, workspace), active, parent)).roots.map(root => root.path))
        .toEqual([active, homes[3]]);
      expect(readlinkSync(homes[2])).toBe(foreign);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('retains real CLI capability grants across known homes without claiming copies or foreign homes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'consent-grants-census-'));
    const savedHome = process.env.PAPERCUSP_HOME;
    const { promptConsent } = await import('../../../../libs/papercusp/packages/cli/src/consent');
    const { _resetPapercuspRootForTests } = await import('../../../../libs/papercusp/packages/cli/src/papercusp-root');
    const homes = [join(parent, 'active'), join(parent, 'inactive'), join(parent, 'default'), join(parent, '.papercusp')];
    const foreign = join(parent, 'foreign');
    const names = ['granted-capabilities.json', 'extended-grants.json'];
    const before = new Map<string, Stats>();
    try {
      for (const home of [...homes, foreign]) {
        process.env.PAPERCUSP_HOME = home;
        _resetPapercuspRootForTests();
        await promptConsent({ manifest: { name: 'census-fixture', version: '1.0.0', capabilities: ['storage:plugin-private'] },
          harnessSlug: 'fixture', acceptAllHarnesses: true });
        mkdirSync(join(home, 'nested'));
        for (const name of names) {
          const bytes = readFileSync(join(home, name));
          writeFileSync(join(home, `${name}.bak`), bytes);
          writeFileSync(join(home, 'nested', name), bytes);
          before.set(join(home, name), lstatSync(join(home, name)));
        }
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }], workspace => join(parent, workspace), homes[0], parent);
      expect(result.roots.map(root => root.path)).toEqual(homes);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        for (const name of names) {
          expect(census.inventory.find(entry => entry.root === root.id && entry.name === name))
            .toMatchObject({ classification: 'config', producers: ['plugin-capability-consent'] });
          expect(result.declarations.find(entry => entry.root === root.id && entry.name === name))
            .toMatchObject({ classification: 'config' });
          expect(result.declarations.find(entry => entry.root === root.id && entry.name === name)?.descendants).toBeUndefined();
        }
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual(['nested', ...names.flatMap(name => [`${name}.bak`, `nested/${name}`])].sort());
      }
      for (const [path, stat] of before) {
        const after = lstatSync(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      expect(census.ok).toBe(false);
      rmSync(homes[2], { recursive: true });
      symlinkSync(foreign, homes[2]);
      expect((await readWorkspaceSetupHomes([], workspace => join(parent, workspace), homes[0], parent)).roots.map(root => root.path))
        .toEqual([homes[0], homes[3]]);
      expect(readlinkSync(homes[2])).toBe(foreign);
    } finally {
      if (savedHome === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = savedHome;
      _resetPapercuspRootForTests();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('retains real announce identity defaults across known homes without claiming copies or foreign homes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'announce-identity-census-'));
    const { resolveLocalAnnounceIdentity } = await import('../sync/hyperbee/local-announce-identity');
    const homes = [join(parent, 'active'), join(parent, 'inactive'), join(parent, 'default'), join(parent, '.papercusp')];
    const foreign = join(parent, 'foreign');
    const name = 'local-announce-identity.json';
    const before = new Map<string, { stat: Stats; bytes: Buffer }>();
    try {
      for (const home of [...homes, foreign]) {
        const cachePath = join(home, name);
        await resolveLocalAnnounceIdentity({ logCoreKeyHex: 'ab'.repeat(32), identityMode: 'authoring', cachePath,
          resolveGithubUser: async () => ({ id: 123, login: 'census-fixture' }),
          buildKeychainId: () => '123:fixture-device',
          loadKeypair: async keychainId => ({ keychainId, pubkeyBase64: Buffer.alloc(32, 7).toString('base64') }),
          resolveAttestationGistId: async () => 'fixture-gist' });
        const bytes = readFileSync(cachePath);
        expect(JSON.parse(bytes.toString())).toMatchObject({ version: 1, githubLogin: 'census-fixture',
          keychainId: '123:fixture-device', attestationGistId: 'fixture-gist' });
        mkdirSync(join(home, 'nested'));
        writeFileSync(join(home, `${name}.bak`), bytes);
        writeFileSync(join(home, 'nested', name), bytes);
        before.set(cachePath, { stat: lstatSync(cachePath), bytes });
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }], workspace => join(parent, workspace), homes[0], parent);
      expect(result.roots.map(root => root.path)).toEqual(homes);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        expect(census.inventory.find(entry => entry.root === root.id && entry.name === name))
          .toMatchObject({ classification: 'state', producers: ['local-announce-identity'] });
        const declaration = result.declarations.find(entry => entry.root === root.id && entry.name === name);
        expect(declaration).toMatchObject({ classification: 'state' });
        expect(declaration?.descendants).toBeUndefined();
        expect(declaration?.prune).toBeUndefined();
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual([`${name}.bak`, 'nested', `nested/${name}`].sort());
      }
      for (const [path, { stat, bytes }] of before) {
        expect(readFileSync(path)).toEqual(bytes);
        const after = lstatSync(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      expect(census.ok).toBe(false);
      rmSync(homes[2], { recursive: true });
      symlinkSync(foreign, homes[2]);
      expect((await readWorkspaceSetupHomes([], workspace => join(parent, workspace), homes[0], parent)).roots.map(root => root.path))
        .toEqual([homes[0], homes[3]]);
      expect(readlinkSync(homes[2])).toBe(foreign);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('retains migration cooldown defaults across known homes without claiming copies or foreign homes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'migration-cooldown-census-'));
    const homes = [join(parent, 'active'), join(parent, 'inactive'), join(parent, 'default'), join(parent, '.papercusp')];
    const foreign = join(parent, 'foreign');
    const name = 'migration-failure-cooldown.json';
    const bytes = JSON.stringify({ '001-fixture.sql': { lastFailedAt: 1234, error: 'fixture failure', attempts: 2 } });
    const before = new Map<string, Stats>();
    try {
      for (const home of [...homes, foreign]) {
        mkdirSync(join(home, 'nested'), { recursive: true });
        for (const file of [name, `${name}.bak`, `nested/${name}`]) writeFileSync(join(home, file), bytes);
        before.set(join(home, name), lstatSync(join(home, name)));
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }], workspace => join(parent, workspace), homes[0], parent);
      expect(result.roots.map(root => root.path)).toEqual(homes);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        expect(census.inventory.find(entry => entry.root === root.id && entry.name === name))
          .toMatchObject({ classification: 'state', producers: ['boot-migration-cooldown'] });
        const declaration = result.declarations.find(entry => entry.root === root.id && entry.name === name);
        expect(declaration?.descendants).toBeUndefined();
        expect(declaration?.prune).toBeUndefined();
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual([`${name}.bak`, 'nested', `nested/${name}`].sort());
      }
      for (const [path, stat] of before) {
        expect(readFileSync(path, 'utf8')).toBe(bytes);
        const after = lstatSync(path);
        for (const field of ['mode', 'size', 'ino', 'mtimeMs', 'ctimeMs'] as const) expect(after[field]).toBe(stat[field]);
      }
      expect(census.ok).toBe(false);
      rmSync(homes[2], { recursive: true });
      symlinkSync(foreign, homes[2]);
      expect((await readWorkspaceSetupHomes([], workspace => join(parent, workspace), homes[0], parent)).roots.map(root => root.path))
        .toEqual([homes[0], homes[3]]);
      expect(readlinkSync(homes[2])).toBe(foreign);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('includes the legacy default writer home without registering arbitrary sibling homes', async () => {
    const registry = join(fixtureHome, 'registry');
    const legacy = join(registry, 'default', '.papercusp');
    const foreign = join(registry, 'unregistered', '.papercusp');
    const marker = '.papercup-console-active.123';
    try {
      for (const directory of [legacy, foreign]) {
        mkdirSync(join(directory, 'crash-reports'), { recursive: true });
        writeFileSync(join(directory, marker), '');
        writeFileSync(join(directory, 'crash-reports', 'report.json'), 'retained diagnostic');
        writeFileSync(join(directory, 'foreign-source.ts'), 'unrelated sibling');
      }
      writeFileSync(join(legacy, '.papercup-console-active.124'), 'retained data');
      for (const directory of [legacy, foreign]) {
        writeFileSync(join(directory, 'endpoint-ipc.3170.json'), '{}');
        writeFileSync(join(directory, 'operator-port.json'), JSON.stringify({ port: 3170, updatedAt: 1730000000000 }));
      }
      const report = await runRootCensus({ checkpointLogDir: join(fixtureHome, 'checkpoint-history') });
      expect(report.inventory.find(entry => entry.name.endsWith(`default/.papercusp/${marker}`)))
        .toMatchObject({ classification: 'cache', producers: ['console-spawn-legacy-sentinel'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/crash-reports/report.json')))
        .toMatchObject({ classification: 'state', producers: ['fatal-diagnostics'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/endpoint-ipc.3170.json')))
        .toMatchObject({ classification: 'cache', producers: ['endpoint-ipc-discovery'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/operator-port.json')))
        .toMatchObject({ classification: 'config', producers: ['operator-server-discovery'] });
      expect(report.residue.some(entry => entry.name.endsWith('default/.papercusp/foreign-source.ts'))).toBe(true);
      expect(report.residue.some(entry => entry.name.endsWith('default/.papercusp/.papercup-console-active.124'))).toBe(true);
      expect(report.inventory.filter(entry => entry.name.includes('unregistered') && entry.classification)).toEqual([]);
      expect(report.wholeInstallVerified).toBe(false);
    } finally { rmSync(registry, { recursive: true, force: true }); }
  });

  it('does not follow a linked legacy default writer home or invent an absent one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'legacy-workspace-census-'));
    const active = join(parent, 'active');
    const legacy = join(parent, 'default');
    const foreign = join(parent, 'foreign');
    const resolveRoot = (workspace: string) => join(parent, workspace);
    try {
      mkdirSync(active);
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'env-switcher-prefs.json'), '{"disabled":["staging"]}');
      expect((await readWorkspaceSetupHomes([], resolveRoot, active, parent)).roots.map(root => root.path)).toEqual([active]);
      symlinkSync(foreign, legacy);
      const result = await readWorkspaceSetupHomes([], resolveRoot, active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active]);
      expect(result.declarations.some(entry => entry.name === 'env-switcher-prefs.json' && entry.root !== result.roots[0].id)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('preserves the legacy host runtime home while leaving unrelated files and linked fallbacks unclassified', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'legacy-host-runtime-census-'));
    const hostHome = join(parent, 'host');
    const legacy = join(hostHome, '.papercusp');
    const active = join(parent, 'active');
    const foreign = join(parent, 'foreign');
    const resolveRoot = (workspace: string) => join(parent, 'registry', workspace, '.papercusp');
    try {
      mkdirSync(active, { recursive: true });
      for (const directory of [legacy, foreign]) {
        mkdirSync(join(directory, 'crash-reports'), { recursive: true });
        writeFileSync(join(directory, 'crash-reports', 'report.json'), 'retained diagnostic');
        mkdirSync(join(directory, 'snapshot-fold-checkpoints'), { recursive: true });
        writeFileSync(join(directory, 'snapshot-fold-checkpoints', 'checkpoint.json'), 'retained checkpoint');
        mkdirSync(join(directory, 'deploy-credentials', '.codex-setup-account-1234abcd'), { recursive: true });
        writeFileSync(join(directory, 'deploy-credentials', '.codex-setup-account-1234abcd', 'auth.json'), 'opaque');
        writeFileSync(join(directory, 'deploy-credentials', 'unproven.json'), 'unproven credential');
        writeFileSync(join(directory, 'foreign-source.ts'), 'unrelated sibling');
        setEnvEnabled('staging', false, { filePath: join(directory, 'env-switcher-prefs.json') });
      }
      const result = await readWorkspaceSetupHomes([], resolveRoot, active, hostHome);
      expect(result.roots.map(root => root.path)).toEqual([active, legacy]);
      const legacyId = result.roots[1].id;
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'crash-reports/report.json'))
        .toMatchObject({ classification: 'state', producers: ['fatal-diagnostics'] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'snapshot-fold-checkpoints/checkpoint.json'))
        .toMatchObject({ classification: 'state', producers: ['hyperbee-own-compaction'] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name.endsWith('/auth.json')))
        .toMatchObject({ classification: 'secret' });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'env-switcher-prefs.json'))
        .toMatchObject({ classification: 'config', producers: ['env-switcher-prefs'] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual(['deploy-credentials/unproven.json', 'foreign-source.ts']);
      expect(census.ok).toBe(false);
      const alreadyActive = await readWorkspaceSetupHomes([], resolveRoot, legacy, hostHome);
      expect(alreadyActive.roots.map(root => root.path)).toEqual([legacy]);
      rmSync(legacy, { recursive: true });
      symlinkSync(foreign, legacy);
      expect((await readWorkspaceSetupHomes([], resolveRoot, active, hostHome)).roots.map(root => root.path))
        .toEqual([active]);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('keeps environment preferences in registered workspaces without claiming host logs or lookalikes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-runtime-files-census-'));
    try {
      const active = join(parent, 'active');
      const inactive = join(parent, 'inactive');
      const unknown = ['env-switcher-prefs.json.bak', 'gateway.log', 'gateway.log.1', 'gateway.log.2', 'gateway.log.backup'];
      for (const home of [active, inactive, join(parent, 'unregistered')]) {
        mkdirSync(home, { recursive: true });
        setEnvEnabled('staging', false, { filePath: join(home, 'env-switcher-prefs.json') });
        for (const name of unknown) writeFileSync(join(home, name), 'unproven sibling');
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active, inactive]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        expect(census.inventory.filter(entry => entry.root === root.id && entry.classification === 'config'))
          .toEqual([expect.objectContaining({ name: 'env-switcher-prefs.json', producers: ['env-switcher-prefs'] })]);
        expect(census.inventory.filter(entry => entry.root === root.id && entry.classification === 'state')).toEqual([]);
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual(unknown.sort());
        expect(JSON.parse(readFileSync(join(root.path, 'env-switcher-prefs.json'), 'utf8')))
          .toEqual({ disabled: ['staging'] });
      }
      expect(result.declarations.every(entry => !entry.prune)).toBe(true);
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
      writeFileSync(join(peer, '..', 'unowned-sibling'), 'unknown state');
      writeFileSync(join(directory, 'registry', 'fixture', 'unowned-workspace-file'), 'unknown state');
      writeFileSync(join(directory, 'registry', 'fixture', '.papercusp', 'unowned-root-file'), 'unknown state');
      mkdirSync(join(directory, 'registry', 'uninitialized', '.papercusp', 'harness', 'hyperbee'), { recursive: true });
      const linkedWorkspace = join(directory, 'registry', 'linked');
      mkdirSync(linkedWorkspace);
      symlinkSync(join(directory, 'registry', 'fixture', '.papercusp'), join(linkedWorkspace, '.papercusp'));
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
      // Keep one visible unproven sibling in the inventory. The nested
      // unproven-app remains a single failing subtree in diagnostic mode.
      const rejectedLocks: string[] = [join(directory, 'registry', 'fixture', '.papercusp', 'harness', `unproven-store${lockSuffix}`)];
      writeFileSync(rejectedLocks[0], JSON.stringify(lock));
      writeFileSync(`${unprovenPeer}${lockSuffix}`, JSON.stringify(lock));
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
      expect(report.inventory.find((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness'))
        .toMatchObject({ classification: 'state', producers: ['harness-corestore-container'] });
      for (const name of ['registry/fixture', 'registry/fixture/.papercusp']) {
        expect(report.inventory.find((entry: { name: string }) => entry.name === name))
          .toMatchObject({ classification: 'state', producers: ['harness-corestore-container'] });
      }
      for (const name of ['registry/fixture/unowned-workspace-file', 'registry/fixture/.papercusp/unowned-root-file',
        'registry/uninitialized', 'registry/linked', 'registry/fixture/.restored']) {
        expect(report.residue.some((entry: { name: string }) => entry.name === name), name).toBe(true);
      }
      expect(report.inventory.some((entry: { name: string; classification: string | null }) =>
        entry.name.startsWith('registry/linked/') && entry.classification)).toBe(false);
      expect(readlinkSync(join(linkedWorkspace, '.papercusp'))).toBe(join(directory, 'registry', 'fixture', '.papercusp'));
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unowned-sibling')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/legacy')).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name.includes('/.restored/snapshot/clone/'))).toBe(true);
      expect(report.representedPeers.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app/hyperbee')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/retained-app')).toBe(true);
      expect(report.residue.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app')).toBe(true);
      expect(report.representedUnknown.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app')).toBe(true);
      expect(report.inventory.some((entry: { name: string }) => entry.name === 'registry/fixture/.papercusp/harness/unproven-app/hyperbee.single-instance.lock')).toBe(false);
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
      expect(readFileSync(`${unprovenPeer}${lockSuffix}`, 'utf8')).toBe(JSON.stringify(lock));
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
