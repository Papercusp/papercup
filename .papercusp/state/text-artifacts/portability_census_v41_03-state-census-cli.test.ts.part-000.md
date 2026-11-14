---
rel_path: "portability/census/v41/03-state-census-cli.test.ts.part-000"
updated_at: 1794241756285
_body: "content"
---

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
import { setEnvEnabled } from '../harness/env-switcher-prefs';

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
      expect(readReaperMessages).toHaveBeenCalledExactlyOnceWith(['active', 'default'], expect.arrayContaining(ids));
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
    const registr
