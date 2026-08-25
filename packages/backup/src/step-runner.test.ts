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
function fakeHost(
  onQuery?: (strings: TemplateStringsArray, values: unknown[]) => void,
) {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    onQuery?.(strings, values);
    return Promise.resolve([]);
  }) as unknown as Sql;
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => "/tmp/backup-test-root",
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({
      url: "postgres://u:p@localhost:5432/db",
      source: "test",
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
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

describe('snapshot() opts.onStarted (EI-18875467740392530)', () => {
  it('fires with the durable row id BEFORE the expensive kopia step settles — the guarantee a caller races against a shorter deadline depends on', async () => {
    fakeHost();
    let releaseKopiaStep!: () => void;
    const kopiaStepGate = new Promise<void>((resolve) => { releaseKopiaStep = resolve; });
    const calls: string[] = [];
    const recording: StepRunner = {
      runStep: async <T>(name: string, _fn: () => Promise<T>): Promise<T> => {
        calls.push(name);
        if (name === 'backup-kopia-create') {
          // Held open until the test explicitly releases it, so the assertion
          // below observes onStarted having ALREADY fired while the overall
          // snapshot() promise is still pending — proving it is not merely
          // bundled into the final resolved value.
          await kopiaStepGate;
        }
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 42, startedAtMs: 1000 },
          'backup-kopia-create': { snapshotId: 'kopia-late', bytesAdded: 1, bytesTotal: 2, durationMs: 5 },
          'backup-record-result': undefined,
          'backup-pre-snapshot-hook': undefined,
        };
        return canned[name] as T;
      },
    };
    configureBackupStepRunner(recording);

    const wb = new WorkspaceBackup({ workspaceId: 'ws-1', workspaceRoot: '/tmp/backup-test-root/ws-1' });
    vi.spyOn(wb, 'ensureRepo').mockResolvedValue(undefined);

    let startedId: number | undefined;
    let settled = false;
    const snapshotPromise = wb
      .snapshot('manual', undefined, { onStarted: (id) => { startedId = id; } })
      .then((r) => { settled = true; return r; });

    // Let microtasks drain up to (but not past) the held-open kopia step.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(startedId).toBe(42); // fired already
    expect(settled).toBe(false); // ...while the overall promise is still pending

    releaseKopiaStep();
    const result = await snapshotPromise;
    expect(settled).toBe(true);
    expect(result.snapshotId).toBe(42);
  });

  it('is optional — omitting it changes nothing about the result', async () => {
    fakeHost();
    const recording: StepRunner = {
      runStep: async <T>(name: string): Promise<T> => {
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 9, startedAtMs: 1000 },
          'backup-kopia-create': { snapshotId: 'kopia-9', bytesAdded: 1, bytesTotal: 2, durationMs: 1 },
          'backup-record-result': undefined,
          'backup-pre-snapshot-hook': undefined,
        };
        return canned[name] as T;
      },
    };
    configureBackupStepRunner(recording);
    const wb = new WorkspaceBackup({ workspaceId: 'ws-1', workspaceRoot: '/tmp/backup-test-root/ws-1' });
    vi.spyOn(wb, 'ensureRepo').mockResolvedValue(undefined);

    const result = await wb.snapshot('manual');
    expect(result.snapshotId).toBe(9);
  });
});

describe("snapshot() progress heartbeat (EI-21393555442782456)", () => {
  it("continues during a held long-running step and stops after snapshot settlement", async () => {
    vi.useFakeTimers();
    const heartbeatPayloads: string[] = [];
    fakeHost((strings, values) => {
      if (
        !strings.join(" ").includes("INSERT INTO harness_shared.backup_events")
      )
        return;
      const payload = values.at(-1);
      if (
        typeof payload === "string" &&
        payload.includes('"phase":"heartbeat"')
      ) {
        heartbeatPayloads.push(payload);
      }
    });

    let releasePreHook!: () => void;
    let markPreHookStarted!: () => void;
    const preHookGate = new Promise<void>((resolve) => {
      releasePreHook = resolve;
    });
    const preHookStarted = new Promise<void>((resolve) => {
      markPreHookStarted = resolve;
    });
    const recording: StepRunner = {
      runStep: async <T>(name: string): Promise<T> => {
        if (name === "backup-insert-row") {
          return { id: 77, startedAtMs: 1000 } as T;
        }
        if (name === "backup-pre-snapshot-hook") {
          markPreHookStarted();
          await preHookGate;
          return { ok: true, error: null } as T;
        }
        if (name === "backup-kopia-create") {
          return {
            snapshotId: "kopia-77",
            bytesAdded: 1,
            bytesTotal: 2,
            durationMs: 5,
          } as T;
        }
        return undefined as T;
      },
    };
    configureBackupStepRunner(recording);

    const wb = new WorkspaceBackup({
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/backup-test-root/ws-1",
    });
    vi.spyOn(wb, "ensureRepo").mockResolvedValue(undefined);

    const snapshotPromise = wb.snapshot("manual");
    await preHookStarted;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(heartbeatPayloads).toHaveLength(3);

    releasePreHook();
    await snapshotPromise;
    const afterSettlement = heartbeatPayloads.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatPayloads).toHaveLength(afterSettlement);
  });
});
