/**
 * Unit tests for the generic durability seam (dbos-durable-flows-adoption
 * D-010 / P-011): the `StepRunner` contract, the configure/resolve/revert
 * lifecycle, and proof that `snapshot()` routes its side-effectful phases
 * through the injected runner with the right step boundaries.
 *
 * The seam's headline guarantee is "behavior UNCHANGED when no host is wired"
 * (the default is a pass-through), and "the non-idempotent row INSERT is its
 * own step so a resume returns the cached id instead of double-inserting".
 * Both are pinned here without a real kopia binary or PG: `./password` is
 * mocked, `ensureRepo` is stubbed, the host SQL swallows the best-effort event
 * writes, and a recording runner returns canned per-step values so no `fn`
 * body shells out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  passthroughStepRunner,
  WorkspaceBackup,
  type StepRunner,
} from './index';
// `backupStepRunner` is the package-internal resolver (not part of the public
// surface) — import it straight from the module under test.
import { backupStepRunner } from './config';
import type { Sql } from 'postgres';

/** A host whose SQL swallows every query (returns []) — enough for the
 *  best-effort event writes + the offsite-sync settings read in snapshot(). */
function fakeHost() {
  const sql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-test-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

afterEach(() => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
});

describe('passthroughStepRunner', () => {
  it('runs the fn and returns its value (identical to calling fn directly)', async () => {
    const out = await passthroughStepRunner.runStep('any', async () => 42);
    expect(out).toBe(42);
  });

  it('propagates a thrown error unchanged', async () => {
    await expect(
      passthroughStepRunner.runStep('boom', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
  });
});

describe('configureBackupStepRunner / backupStepRunner', () => {
  it('defaults to the pass-through when nothing is injected', () => {
    expect(backupStepRunner()).toBe(passthroughStepRunner);
  });

  it('returns the injected runner, then reverts to pass-through on null', () => {
    const custom: StepRunner = { runStep: (_n, fn) => fn() };
    configureBackupStepRunner(custom);
    expect(backupStepRunner()).toBe(custom);
    configureBackupStepRunner(null);
    expect(backupStepRunner()).toBe(passthroughStepRunner);
  });
});

describe('snapshot() step decomposition', () => {
  it('routes through the runner with the expected step names IN ORDER', async () => {
    fakeHost();
    const calls: string[] = [];
    // Recording runner: capture each step name and return canned values per
    // step so no `fn` body runs (no kopia / no PG). This proves the boundaries
    // + the wiring of step outputs into the result, decoupled from the CLI.
    const recording: StepRunner = {
      runStep: async <T>(name: string, _fn: () => Promise<T>): Promise<T> => {
        calls.push(name);
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 7, startedAtMs: 1000 },
          'backup-kopia-create': { snapshotId: 'kopia-xyz', bytesAdded: 11, bytesTotal: 22, durationMs: 5 },
          'backup-record-result': undefined,
          'backup-pre-snapshot-hook': undefined,
        };
        return canned[name] as T;
      },
    };
    configureBackupStepRunner(recording);

    const wb = new WorkspaceBackup({ workspaceId: 'ws-1', workspaceRoot: '/tmp/backup-test-root/ws-1' });
    // ensureRepo shells out to kopia; the seam test only cares about the
    // step decomposition, so stub it to a no-op.
    vi.spyOn(wb, 'ensureRepo').mockResolvedValue(undefined);

    const result = await wb.snapshot('manual', { note: 'unit' });

    // The non-idempotent INSERT is a step (so a resume can't double-insert),
    // and the create + record phases follow it in order.
    expect(calls).toEqual([
      'backup-insert-row',
      'backup-pre-snapshot-hook',
      'backup-kopia-create',
      'backup-record-result',
    ]);
    // The result is assembled from the step outputs: row id from the INSERT
    // step, kopia id + bytes + duration from the create step.
    expect(result).toEqual({
      snapshotId: 7,
      kopiaSnapshotId: 'kopia-xyz',
      bytesAdded: 11,
      durationMs: 5,
    });
  });
});
