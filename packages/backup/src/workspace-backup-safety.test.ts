/**
 * Data-loss-safety unit tests for the workspace backup engine
 * (workspace-backup.ts). These fill targeted gaps in the destructive trio +
 * the kopia snapshot-json parser that the broader `destructive-ops.test.ts`
 * (happy-path / replay) does not cover:
 *
 *   Gap 1  — idempotentMove clobber/data-loss guards (the primitive every
 *            destructive rename funnels through).
 *   Gap 2  — promoteRestore liveTarget escape guard (resolve()-based, beyond
 *            the .restored/ clone-traversal guard).
 *   Gap 3  — parseKopiaSnapshotJson (last-object-wins, bytes fallback chain,
 *            throw-on-missing).
 *   Gap 4  — restoreToClone slug/path computation + mkdir + failure event.
 *   Gap 8  — restoreInPlace skipSafetySnapshot step routing.
 *   Gap 15 — rollbackPromote corrupt-sidecar `live` escape guard.
 *
 * Harness mirrors destructive-ops.test.ts: real FS in a temp dir, no kopia /
 * no PG (./password mocked, host SQL swallows event writes). kopia is stubbed
 * per-test where a method shells out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  evaluateLatestPreDestructiveSnapshot,
  isCompletedPreDestructiveSnapshotReceipt,
  preDestructiveSnapshotAdmissionGuardSql,
  requiresPreDestructiveSnapshotAdmission,
  WorkspaceBackup,
  type StepRunner,
} from './index';
import { parseKopiaSnapshotJson } from './workspace-backup';
import { assertSafeBackupCadence } from './types';
import type { Sql } from 'postgres';

function fakeHost() {
  const sql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-test-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

let root: string;
let wb: WorkspaceBackup;

describe('backup cadence safety floor', () => {
  it('allows immediate event-triggered snapshots without an interval', () => {
    expect(() => assertSafeBackupCadence('event', 5)).not.toThrow();
  });

  it('rejects minute-scale interval and combined schedules', () => {
    expect(() => assertSafeBackupCadence('interval', 59)).toThrow(/at least 60 minutes/);
    expect(() => assertSafeBackupCadence('both', 5)).toThrow(/at least 60 minutes/);
  });

  it('allows hourly or slower recurring schedules', () => {
    expect(() => assertSafeBackupCadence('interval', 60)).not.toThrow();
    expect(() => assertSafeBackupCadence('both', 1440)).not.toThrow();
  });
});

describe('pre-destructive snapshot admission', () => {
  const complete = {
    status: 'ok',
    finishedAt: '2026-08-30T05:00:00.000Z',
    kopiaSnapshotId: 'kopia-complete',
    dbDumpOk: true,
  };

  it('accepts only a completed artifact-backed database snapshot', () => {
    expect(isCompletedPreDestructiveSnapshotReceipt(complete)).toBe(true);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...complete, dbDumpOk: false })).toBe(false);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...complete, finishedAt: null })).toBe(false);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...complete, kopiaSnapshotId: null })).toBe(false);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...complete, status: 'degraded' })).toBe(false);
  });

  it.each([
    ['running', { status: 'running', finishedAt: null, kopiaSnapshotId: null, dbDumpOk: null }],
    ['failed', { status: 'failed', finishedAt: '2026-08-30T05:01:00.000Z', kopiaSnapshotId: null, dbDumpOk: false }],
    ['degraded', { status: 'degraded', finishedAt: '2026-08-30T05:01:00.000Z', kopiaSnapshotId: 'kopia-stale', dbDumpOk: false }],
    ['unknown', { status: 'ok', finishedAt: '2026-08-30T05:01:00.000Z', kopiaSnapshotId: 'kopia-unknown', dbDumpOk: null }],
  ])('rejects a newest %s receipt even when an older receipt completed', (_label, latest) => {
    expect(evaluateLatestPreDestructiveSnapshot([latest, complete])).toMatchObject({
      admitted: false,
      latest,
    });
  });

  it('rejects when there is no pre-destructive receipt', () => {
    expect(evaluateLatestPreDestructiveSnapshot([])).toMatchObject({
      admitted: false,
      latest: null,
      reason: 'missing',
    });
  });

  it('builds one fail-closed SQL predicate over the newest receipt', () => {
    const guard = preDestructiveSnapshotAdmissionGuardSql('workspace-with-quote');
    expect(guard).toContain("trigger_reason = 'pre_destructive'");
    expect(guard).toContain('ORDER BY started_at DESC, id DESC');
    expect(guard).toContain("latest.status = 'ok'");
    expect(guard).toContain('latest.finished_at IS NOT NULL');
    expect(guard).toContain('latest.kopia_snapshot_id IS NOT NULL');
    expect(guard).toContain('latest.db_dump_ok IS TRUE');
    expect(guard).toContain("workspace-with-quote");
  });

  it('leaves baseline and db_dump_ok-introducing migrations unguarded, then guards later files', () => {
    expect(requiresPreDestructiveSnapshotAdmission('000-baseline.sql')).toBe(false);
    expect(requiresPreDestructiveSnapshotAdmission('1006-backup-snapshot-db-dump-integrity.sql')).toBe(false);
    expect(requiresPreDestructiveSnapshotAdmission('1016-trigger-direct-work-item.sql')).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Snapshot concurrency — the scheduler's in-memory admission map cannot see
// direct callers such as backup:snapshot_create. The shared WorkspaceBackup
// operation must therefore join a second request to the first one instead of
// starting another pg_dump/kopia pair for the same workspace.
// -------------------------------------------------------------------------
describe('snapshot concurrency guard (EI-21378460739616032)', () => {
  it('joins a concurrent snapshot and forwards the started row id', async () => {
    const calls: string[] = [];
    let releaseKopia!: () => void;
    let markKopiaEntered!: () => void;
    const kopiaEntered = new Promise<void>((resolve) => { markKopiaEntered = resolve; });
    const kopiaGate = new Promise<void>((resolve) => { releaseKopia = resolve; });

    configureBackupStepRunner({
      runStep: async <T>(name: string): Promise<T> => {
        calls.push(name);
        if (name === 'backup-kopia-create') {
          markKopiaEntered();
          await kopiaGate;
        }
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 7, startedAtMs: 1000 },
          'backup-pre-snapshot-hook': undefined,
          'backup-kopia-create': {
            snapshotId: 'kopia-7', bytesAdded: 11, bytesTotal: 22, durationMs: 5,
          },
          'backup-record-result': undefined,
        };
        return canned[name] as T;
      },
    });
    vi.spyOn(wb, 'ensureRepo').mockResolvedValue(undefined);

    const first = wb.snapshot('interval');
    await kopiaEntered;

    let joinedStartedId: number | undefined;
    const secondWb = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    const second = secondWb.snapshot('manual', undefined, {
      onStarted: (snapshotId) => { joinedStartedId = snapshotId; },
    });
    await Promise.resolve();

    expect(joinedStartedId).toBe(7);
    expect(calls.filter((name) => name === 'backup-insert-row')).toHaveLength(1);
    expect(calls.filter((name) => name === 'backup-kopia-create')).toHaveLength(1);

    releaseKopia();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ snapshotId: 7, kopiaSnapshotId: 'kopia-7' });
  });
});

describe('pre-destructive snapshot intent lifecycle (EI-217072)', () => {
  it('inserts the intent before the advisory-lock wait and finalizes lock failure durably', async () => {
    const order: string[] = [];
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (text.includes('INSERT INTO harness_shared.backup_snapshots')) {
        order.push('insert');
        return Promise.resolve([{ id: 77 }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
      acquireMigrationLock: async () => {
        order.push('lock');
        throw new Error('canceling statement due to lock timeout');
      },
    });
    configureBackupStepRunner({
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        return fn();
      },
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(w, 'ensureRepo').mockResolvedValue(undefined);

    await expect(w.snapshot('pre_destructive')).rejects.toThrow(/lock timeout/);

    expect(order).toEqual(['insert', 'lock']);
    const finalized = queries.find(
      (query) =>
        /UPDATE harness_shared\.backup_snapshots/.test(query.text) &&
        /SET finished_at/.test(query.text) &&
        /status/.test(query.text),
    );
    expect(finalized?.values).toEqual(expect.arrayContaining([
      'canceling statement due to lock timeout',
      null,
      77,
    ]));
  });

  it('releases an acquired migration lock when downstream setup fails', async () => {
    const queries: string[] = [];
    const release = vi.fn(async () => {});
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('INSERT INTO harness_shared.backup_snapshots')) {
        return Promise.resolve([{ id: 78 }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
      acquireMigrationLock: async () => ({ release }),
      scheduleInterval: () => ({ stop: vi.fn() }),
    });
    configureBackupStepRunner({
      runStep: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(w, 'ensureRepo').mockRejectedValue(new Error('ensure repo boom'));

    await expect(w.snapshot('manual')).rejects.toThrow(/ensure repo boom/);

    expect(release).toHaveBeenCalledTimes(1);
    expect(
      queries.some((text) =>
        /UPDATE harness_shared\.backup_snapshots/.test(text) &&
        /SET finished_at/.test(text) &&
        /status/.test(text),
      ),
    ).toBe(true);
  });

  it('releases a scheduler-admitted lock when the durable intent insert fails', async () => {
    const release = vi.fn(async () => {});
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO harness_shared.backup_snapshots')) {
        return Promise.reject(new Error('snapshot intent insert failed'));
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    configureBackupStepRunner({
      runStep: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    const lock = { release };

    await expect(w.snapshot('interval', undefined, { migrationLock: lock })).rejects.toThrow(
      /snapshot intent insert failed/,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});

async function dirWith(p: string, marker: string): Promise<void> {
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'marker.txt'), marker);
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  fakeHost();
  configureBackupStepRunner(null); // default pass-through (no DBOS in unit tests)
  root = await mkdtemp(join(tmpdir(), 'wb-safety-'));
  wb = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

// -------------------------------------------------------------------------
// Gap 1 — idempotentMove clobber + data-loss guards.
//
// idempotentMove is private; we exercise it directly via `as any` (the same
// access pattern destructive-ops.test.ts already uses for `wb.kopia`). This
// keeps the production surface unchanged — no export needed for an instance
// method reachable through the class. These four branches are the last line
// against silently clobbering / losing the live workspace on a replay.
// -------------------------------------------------------------------------
describe('idempotentMove — refuse-rather-than-clobber guards (Gap 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const move = (from: string, to: string) => (wb as any).idempotentMove(from, to) as Promise<void>;

  it('(a) BOTH source and target exist → throws /refusing to clobber/, leaves both intact', async () => {
    const from = join(root, 'src');
    const to = join(root, 'dst');
    await dirWith(from, 'SRC');
    await dirWith(to, 'DST');
    await expect(move(from, to)).rejects.toThrow(/refusing to clobber/);
    // Neither side mutated — the guard must not touch the FS.
    expect(await readFile(join(from, 'marker.txt'), 'utf8')).toBe('SRC');
    expect(await readFile(join(to, 'marker.txt'), 'utf8')).toBe('DST');
  });

  it('(b) NEITHER source nor target exists → throws (data-lost guard)', async () => {
    const from = join(root, 'gone-src');
    const to = join(root, 'gone-dst');
    await expect(move(from, to)).rejects.toThrow(/neither source.*nor target.*exists/);
  });

  it('(c) source gone, target exists → no-op return (prior attempt already completed)', async () => {
    const from = join(root, 'consumed-src');
    const to = join(root, 'already-dst');
    await dirWith(to, 'DST');
    await expect(move(from, to)).resolves.toBeUndefined();
    // target untouched, no new source materialized.
    expect(await readFile(join(to, 'marker.txt'), 'utf8')).toBe('DST');
    expect(await exists(from)).toBe(false);
  });

  it('(d) normal case: source exists, target free → performs the rename', async () => {
    const from = join(root, 'movable');
    const to = join(root, 'moved');
    await dirWith(from, 'PAYLOAD');
    await expect(move(from, to)).resolves.toBeUndefined();
    expect(await exists(from)).toBe(false);
    expect(await readFile(join(to, 'marker.txt'), 'utf8')).toBe('PAYLOAD');
  });
});

// -------------------------------------------------------------------------
// Gap 2 — promoteRestore liveTarget escape guard (resolve()-based).
// destructive-ops covers the clone path-traversal guard; this covers the
// SECOND guard: a liveTarget that escapes the workspace root.
// -------------------------------------------------------------------------
describe('promoteRestore — liveTarget escape guard (Gap 2)', () => {
  async function stageClone(): Promise<string> {
    const clone = join(root, '.restored', 'snap1', 'live');
    await dirWith(clone, 'CLONE');
    return clone;
  }

  it('rejects a liveTarget that escapes the workspace root', async () => {
    const clone = await stageClone();
    await expect(
      wb.promoteRestore({ restoredPath: clone, liveTarget: join(root, '..', 'escape'), opId: 'op1' }),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('rejects a `..` liveTarget that resolve() flattens to outside root (resolve() is the gate)', async () => {
    const clone = await stageClone();
    // root/sub/../../outside resolves to <parent-of-root>/outside — escapes.
    await expect(
      wb.promoteRestore({ restoredPath: clone, liveTarget: join(root, 'sub', '..', '..', 'outside'), opId: 'op1' }),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('rejects a SIBLING dir sharing the root as a bare prefix (<root>-evil) — separator guard', async () => {
    const clone = await stageClone();
    // `<root>-evil` startsWith(root) is TRUE without a separator, so a bare
    // prefix check would let it escape to a sibling workspace; the `root + '/'`
    // guard (security-hardening) rejects it.
    await expect(
      wb.promoteRestore({ restoredPath: clone, liveTarget: `${root}-evil`, opId: 'op-sib' }),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('accepts a `..`-containing liveTarget that resolve()s back INSIDE root', async () => {
    const clone = await stageClone();
    await dirWith(join(root, 'live'), 'OLD_LIVE');
    // root/sub/../live resolves to root/live — inside, so the guard passes.
    const r = await wb.promoteRestore({
      restoredPath: clone,
      liveTarget: join(root, 'sub', '..', 'live'),
      opId: 'op2',
    });
    expect(r.live).toBe(join(root, 'live'));
    expect(await readFile(join(root, 'live', 'marker.txt'), 'utf8')).toBe('CLONE');
  });
});

// -------------------------------------------------------------------------
// Gap 3 — parseKopiaSnapshotJson (pure parser; exported for test).
// -------------------------------------------------------------------------
describe('parseKopiaSnapshotJson (Gap 3)', () => {
  it('(a) multi-object stdout w/ progress lines → last object wins, uses stats bytes', () => {
    const stdout = [
      'uploading...',                                              // non-JSON progress
      JSON.stringify({ id: 'OLD', stats: { uploadedBytes: 1, totalBytes: 2 } }), // earlier object
      ' * 0 hashing, 5 hashed (1 KB)',                            // non-JSON progress
      JSON.stringify({ id: 'NEW', stats: { uploadedBytes: 111, totalBytes: 222 } }),
    ].join('\n');
    expect(parseKopiaSnapshotJson(stdout)).toEqual({
      snapshotId: 'NEW',
      bytesAdded: 111,
      bytesTotal: 222,
    });
  });

  it('(b) no stats → bytesTotal falls back to rootEntry.summ.size, bytesAdded=0', () => {
    const stdout = JSON.stringify({ id: 'k1', rootEntry: { summ: { size: 4096 } } });
    expect(parseKopiaSnapshotJson(stdout)).toEqual({
      snapshotId: 'k1',
      bytesAdded: 0,
      bytesTotal: 4096,
    });
  });

  it('(b2) no stats AND no rootEntry → bytesTotal=0, bytesAdded=0', () => {
    const stdout = JSON.stringify({ id: 'k2' });
    expect(parseKopiaSnapshotJson(stdout)).toEqual({
      snapshotId: 'k2',
      bytesAdded: 0,
      bytesTotal: 0,
    });
  });

  it('(b3) reads the addedSize/totalSize fields emitted by current Kopia', () => {
    const stdout = JSON.stringify({ id: 'k3', stats: { addedSize: 123, totalSize: 456 } });
    expect(parseKopiaSnapshotJson(stdout)).toEqual({
      snapshotId: 'k3',
      bytesAdded: 123,
      bytesTotal: 456,
    });
  });

  it('(c) no JSON at all → throws /no JSON/', () => {
    expect(() => parseKopiaSnapshotJson('uploading...\nall done, no json here\n')).toThrow(/no JSON/);
  });

  it('(d) JSON present but missing id → throws /missing id/', () => {
    const stdout = JSON.stringify({ stats: { uploadedBytes: 5, totalBytes: 6 } });
    expect(() => parseKopiaSnapshotJson(stdout)).toThrow(/missing id/);
  });
});

// -------------------------------------------------------------------------
// Gap 4 — restoreToClone path/slug logic + mkdir + failure event.
// Single instance, FS real, kopia stubbed (mirrors destructive-ops harness).
// -------------------------------------------------------------------------
describe('restoreToClone — slug/path + dir creation + failure event (Gap 4)', () => {
  it('no target → returns <root>/.restored/<id>/<slug> and the dir exists', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kopiaSpy = vi.spyOn(wb as any, 'kopia').mockResolvedValue('');
    const r = await wb.restoreToClone({ kopiaSnapshotId: 'snapABC' });

    // slug derives from the source (== workspaceRoot): \W+ → _, trim edge _.
    const expectedSlug = root.replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
    const expected = join(root, '.restored', 'snapABC', expectedSlug);
    expect(r.targetPath).toBe(expected);
    expect(await exists(expected)).toBe(true);
    // kopia was asked to restore INTO that target path.
    expect(kopiaSpy).toHaveBeenCalledWith(
      ['snapshot', 'restore', 'snapABC', expected],
      expect.anything(),
    );
  });

  it('stubbed kopia rejects → rethrows + emits a restore{phase:failed} event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(wb as any, 'kopia').mockRejectedValue(new Error('kopia boom'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt = vi.spyOn(wb as any, 'detachedEvent');

    await expect(wb.restoreToClone({ kopiaSnapshotId: 'snapFail' })).rejects.toThrow(/kopia boom/);

    const failed = evt.mock.calls.find(
      ([kind, payload]) => kind === 'restore' && (payload as { phase?: string }).phase === 'failed',
    );
    expect(failed).toBeTruthy();
    expect((failed![1] as { error?: string }).error).toMatch(/kopia boom/);
  });

  it('missing Kopia content marks the matching receipt failed', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    vi.spyOn(wb as any, 'kopia').mockRejectedValue(
      new Error('kopia snapshot restore snapMissing failed: content snapMissing not found: object not found'),
    );

    await expect(wb.restoreToClone({ kopiaSnapshotId: 'snapMissing' })).rejects.toThrow(/not found/);

    expect(calls.some(({ text, values }) =>
      /UPDATE harness_shared\.backup_snapshots/.test(text)
      && /status = 'failed'/.test(text)
      && values.includes('snapMissing'))).toBe(true);
  });

  it('transient restore errors do not poison the receipt', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    vi.spyOn(wb as any, 'kopia').mockRejectedValue(new Error('permission denied writing restore target'));

    await expect(wb.restoreToClone({ kopiaSnapshotId: 'snapTransient' })).rejects.toThrow(/permission denied/);

    expect(calls.some(({ text }) => /UPDATE harness_shared\.backup_snapshots/.test(text))).toBe(false);
  });

  it('unrelated object-not-found errors do not poison the receipt', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    vi.spyOn(wb as any, 'kopia').mockRejectedValue(new Error('object not found while writing restore target'));

    await expect(wb.restoreToClone({ kopiaSnapshotId: 'snapUnrelated' })).rejects.toThrow(/object not found/);

    expect(calls.some(({ text }) => /UPDATE harness_shared\.backup_snapshots/.test(text))).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Gap 8 — restoreInPlace skipSafetySnapshot step routing.
// step-runner records the named steps; snapshot() + kopia are stubbed.
// -------------------------------------------------------------------------
describe('restoreInPlace — skipSafetySnapshot step routing (Gap 8)', () => {
  function recordingRunner(calls: string[]): StepRunner {
    return {
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        calls.push(name);
        return fn();
      },
    };
  }

  it('(a) default → safety snapshot + apply, prevSnapshotId non-null', async () => {
    const calls: string[] = [];
    configureBackupStepRunner(recordingRunner(calls));
    const snapSpy = vi.spyOn(wb, 'snapshot').mockResolvedValue({
      snapshotId: 7,
      kopiaSnapshotId: 'safety-kopia',
      bytesAdded: 0,
      durationMs: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(wb as any, 'kopia').mockResolvedValue('');

    const r = await wb.restoreInPlace({ kopiaSnapshotId: 'snap-1' });
    expect(calls).toEqual(['restore-safety-snapshot', 'restore-kopia-apply']);
    expect(r.prevSnapshotId).toBe('safety-kopia');
    expect(snapSpy).toHaveBeenCalledOnce();
  });

  it('(b) skipSafetySnapshot:true → apply only, prevSnapshotId null, snapshot() NOT called', async () => {
    const calls: string[] = [];
    configureBackupStepRunner(recordingRunner(calls));
    const snapSpy = vi.spyOn(wb, 'snapshot');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(wb as any, 'kopia').mockResolvedValue('');

    const r = await wb.restoreInPlace({ kopiaSnapshotId: 'snap-1', skipSafetySnapshot: true });
    expect(calls).toEqual(['restore-kopia-apply']);
    expect(r.prevSnapshotId).toBeNull();
    expect(snapSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// Gap 15 — rollbackPromote corrupt-sidecar `live` escape guard.
// A malicious/corrupt .meta.json whose `live` points outside the workspace
// must be refused (the resolved-live escape guard at :662), even though the
// brokenPath itself is inside root.
// -------------------------------------------------------------------------
describe('rollbackPromote — corrupt sidecar live escape (Gap 15)', () => {
  it('rejects when the sidecar `live` escapes the workspace root', async () => {
    const broken = join(root, '.broken-evil-live');
    await dirWith(broken, 'OLD_LIVE');
    await writeFile(
      `${broken}.meta.json`,
      JSON.stringify({ broken, live: join(root, '..', 'outside'), promotedFrom: 'x' }),
    );
    await expect(wb.rollbackPromote({ brokenPath: broken, opId: 'rb1' })).rejects.toThrow(/escapes workspace/);
  });

  it('contrast: a valid sidecar round-trips (live stays inside root)', async () => {
    const broken = join(root, '.broken-good-live');
    const live = join(root, 'live');
    await dirWith(broken, 'OLD_LIVE');
    await dirWith(live, 'PROMOTED'); // current live = the promoted clone
    await writeFile(
      `${broken}.meta.json`,
      JSON.stringify({ broken, live, promotedFrom: join(root, '.restored', 's', 'live') }),
    );
    const r = await wb.rollbackPromote({ brokenPath: broken, opId: 'rb2' });
    expect(r.liveAfter).toBe(live);
    expect(await readFile(join(live, 'marker.txt'), 'utf8')).toBe('OLD_LIVE'); // old live restored
  });
});

// -------------------------------------------------------------------------
// Gap 16 — a DEGRADED pre-snapshot DB dump must not be recorded as 'ok'.
//
// EI-20109034777197353: the pre-snapshot pg_dump skipped hourly for 26 hours
// while every snapshot row committed status='ok'. The hook returned
// { ok:false } into a logfile nobody reads, and the ledger — the one surface a
// human or a health check actually consults — said the backup was fine. The
// dump going stale is not what made this dangerous; the ledger agreeing that it
// hadn't is. Measured: "pg SKIP" logged at 22:47:06Z, snapshot 'ok' at
// 22:47:08Z, two seconds apart.
//
// Drives the real `backup-record-result` UPDATE (every other step is canned)
// and reads the status parameter actually bound into that query.
// -------------------------------------------------------------------------
describe('degraded pre-snapshot dump must not record status=ok (EI-20109034777197353)', () => {
  async function recordWithHookOutcome(outcome: { ok: boolean; error?: string | null }) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: unknown, ...values: unknown[]) => {
      if (Array.isArray(strings)) queries.push({ text: (strings as string[]).join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const runner: StepRunner = {
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        // The recording UPDATE is the subject under test — run it for real.
        if (name === 'backup-record-result') return fn();
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 7, startedAtMs: 1000 },
          'backup-pre-snapshot-hook': { ok: outcome.ok, error: outcome.error ?? null },
          'backup-kopia-create': {
            snapshotId: 'kopia-xyz', bytesAdded: 11, bytesTotal: 22, durationMs: 5,
          },
        };
        return canned[name] as T;
      },
    };
    configureBackupStepRunner(runner);
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(w, 'ensureRepo').mockResolvedValue(undefined);
    await w.snapshot('interval');
    const update = queries.find(
      (q) => /UPDATE harness_shared\.backup_snapshots/.test(q.text) && /kopia_snapshot_id/.test(q.text),
    );
    expect(update, 'the recording UPDATE should have run').toBeDefined();
    // Bound in source order: kopia id, status, error_text, bytes_added,
    // bytes_total, db_dump_ok, row id.
    return { status: update!.values[1], errorText: update!.values[2], dbDumpOk: update!.values[5] };
  }

  it('records status=degraded (NOT ok) when the dump was skipped for space', async () => {
    const { status, errorText, dbDumpOk } = await recordWithHookOutcome({
      ok: false,
      error:
        'insufficient free space (35319316480 available; 6415804660 needed for a dump of 1780687612 bytes)',
    });
    expect(status).toBe('degraded');
    expect(status).not.toBe('ok');
    expect(dbDumpOk).toBe(false);
    // The reason must land ON the row: a bare 'degraded' with no error_text
    // sends the next reader back to the logfile this bug proved nobody reads.
    expect(String(errorText)).toMatch(/insufficient free space/);
  });

  it('records status=degraded when the dump pipeline FAILED outright', async () => {
    const { status, errorText, dbDumpOk } = await recordWithHookOutcome({ ok: false, error: 'pg_dump exited 1' });
    expect(status).toBe('degraded');
    expect(dbDumpOk).toBe(false);
    expect(String(errorText)).toMatch(/pg_dump exited 1/);
  });

  it('still records a clean ok (and a null error_text) when the dump landed', async () => {
    const { status, errorText, dbDumpOk } = await recordWithHookOutcome({ ok: true });
    expect(status).toBe('ok');
    expect(errorText).toBeNull();
    expect(dbDumpOk).toBe(true);
  });

  it('does NOT fabricate degraded from an absent step result (a resumed pre-deploy workflow)', async () => {
    // A DBOS workflow resumed across the deploy that added this step replays a
    // cached `undefined` from the old code. That means "unknown", not "failed":
    // only a positive { ok:false } marks degraded. Dereferencing it also used
    // to throw outright, taking the whole snapshot down with it.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: unknown, ...values: unknown[]) => {
      if (Array.isArray(strings)) queries.push({ text: (strings as string[]).join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    configureBackupStepRunner({
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (name === 'backup-record-result') return fn();
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 7, startedAtMs: 1000 },
          'backup-pre-snapshot-hook': undefined, // the legacy cached value
          'backup-kopia-create': {
            snapshotId: 'kopia-xyz', bytesAdded: 11, bytesTotal: 22, durationMs: 5,
          },
        };
        return canned[name] as T;
      },
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(w, 'ensureRepo').mockResolvedValue(undefined);
    await expect(w.snapshot('interval')).resolves.toMatchObject({ kopiaSnapshotId: 'kopia-xyz' });
    const update = queries.find(
      (q) => /UPDATE harness_shared\.backup_snapshots/.test(q.text) && /kopia_snapshot_id/.test(q.text),
    );
    expect(update!.values[1]).toBe('ok');
    expect(update!.values[5]).toBeNull();
  });
});

describe('db_dump_ok readers stay tri-state and drive rollups', () => {
  it('list exposes false/true/null without inferring from status', async () => {
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('ORDER BY started_at DESC')) {
        return Promise.resolve([
          {
            id: 1,
            kopia_snapshot_id: 'k1',
            started_at: '2026-08-30T00:00:00.000Z',
            finished_at: '2026-08-30T00:01:00.000Z',
            status: 'ok',
            db_dump_ok: true,
            trigger_reason: 'manual',
            trigger_context: null,
            bytes_added: '1',
            bytes_total: '2',
            sources_json: [],
            error_text: null,
          },
          {
            id: 2,
            kopia_snapshot_id: 'k2',
            started_at: '2026-08-28T00:00:00.000Z',
            finished_at: '2026-08-28T00:01:00.000Z',
            status: 'ok',
            db_dump_ok: null,
            trigger_reason: 'manual',
            trigger_context: null,
            bytes_added: '3',
            bytes_total: '4',
            sources_json: [],
            error_text: null,
          },
          {
            id: 3,
            kopia_snapshot_id: 'k3',
            started_at: '2026-08-29T00:00:00.000Z',
            finished_at: '2026-08-29T00:01:00.000Z',
            status: 'degraded',
            db_dump_ok: false,
            trigger_reason: 'pre_destructive',
            trigger_context: null,
            bytes_added: '3',
            bytes_total: '4',
            sources_json: [],
            error_text: 'dump failed',
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(w.list()).resolves.toMatchObject([
      { id: 1, status: 'ok', dbDumpOk: true },
      { id: 2, status: 'ok', dbDumpOk: null },
      { id: 3, status: 'degraded', dbDumpOk: false },
    ]);
  });

  it('stats uses explicit dump success/failure predicates, not status=ok', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('bytes_added_sum')) {
        return Promise.resolve([{
          total: '2',
          bytes_added_sum: '10',
          bytes_total_sum: '20',
          last_ok: '2026-08-30T00:01:00.000Z',
          last_fail: '2026-08-30T00:02:00.000Z',
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(w.stats()).resolves.toMatchObject({
      totalSnapshots: 2,
      lastSnapshotAt: '2026-08-30T00:01:00.000Z',
      lastFailureAt: '2026-08-30T00:02:00.000Z',
    });
    expect(queries.join('\n')).toContain('db_dump_ok IS TRUE');
    expect(queries.join('\n')).toContain('db_dump_ok IS FALSE');
  });

  it('recentFailures includes legacy degraded rows and explicit dump failures', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('status IN (')) {
        return Promise.resolve([{
          id: 7,
          kopia_snapshot_id: 'k7',
          started_at: '2026-08-30T00:00:00.000Z',
          finished_at: '2026-08-30T00:01:00.000Z',
          status: 'degraded',
          db_dump_ok: null,
          trigger_reason: 'pre_destructive',
          trigger_context: null,
          bytes_added: '1',
          bytes_total: '2',
          sources_json: [],
          error_text: 'legacy dump failure',
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(w.recentFailures()).resolves.toMatchObject([
      { id: 7, status: 'degraded', dbDumpOk: null },
    ]);
    expect(queries.join('\n')).toContain('db_dump_ok IS FALSE');
  });
});

// EI-22064935119941678: liveBackupSessions() is the fix for backup:snapshot_list's
// false all-clear — it must see BOTH backup producers, not just the workspace hook
// this class's own receipt table (list()) tracks.
describe('liveBackupSessions (EI-22064935119941678)', () => {
  it('queries pg_stat_activity for both application names, scoped to this database and excluding self', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: unknown, ...values: unknown[]) => {
      if (Array.isArray(strings)) queries.push({ text: (strings as string[]).join('?'), values });
      return Promise.resolve([]);
    }) as unknown as Sql;
    (sql as unknown as { array: (v: unknown) => unknown }).array = (v) => v;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await w.liveBackupSessions();

    expect(queries).toHaveLength(1);
    const { text, values } = queries[0];
    expect(text).toContain('pg_stat_activity');
    expect(text).toContain('application_name = ANY(');
    expect(text).toContain('datname = current_database()');
    expect(text).toContain('pid <> pg_backend_pid()');
    expect(values[0]).toEqual(['pcbackup', 'pcbackup-workspace']);
  });

  it('maps a live host-cron session even when it has no snapshot receipt', async () => {
    const sql = ((strings: unknown) => {
      if (Array.isArray(strings) && (strings as string[]).join('').includes('pg_stat_activity')) {
        return Promise.resolve([{
          pid: 3294839,
          application_name: 'pcbackup',
          state: 'active',
          xact_start: null,
          query_start: '2026-09-01T13:04:00.000Z',
          age_sec: '369.2',
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    (sql as unknown as { array: (v: unknown) => unknown }).array = (v) => v;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    const sessions = await w.liveBackupSessions();

    expect(sessions).toEqual([{
      pid: 3294839,
      applicationName: 'pcbackup',
      state: 'active',
      xactStartedAt: null,
      queryStartedAt: '2026-09-01T13:04:00.000Z',
      ageSec: 369.2,
    }]);
  });

  it('returns [] when no backup session is currently active', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    (sql as unknown as { array: (v: unknown) => unknown }).array = (v) => v;
    configureBackup({
      getSql: () => sql,
      workspacesRoot: () => '/tmp/backup-test-root',
      ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    });
    const w = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    await expect(w.liveBackupSessions()).resolves.toEqual([]);
  });
});
