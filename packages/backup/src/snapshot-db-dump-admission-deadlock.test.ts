/**
 * The pre-destructive snapshot receipt must carry the dump verdict the hook
 * actually recorded — not an artifact of step replay.
 *
 * Observed 2026-08-30: snapshot 75742 dumped 9.6GB, its `hook_pg_dump` event
 * recorded `{ ok: true }`, and the receipt still landed `db_dump_ok = NULL`
 * because the step runner replayed an `undefined` result. Two policies then
 * collided: the status write fails OPEN (so the receipt read `ok` and looked
 * healthy), while `snapshot-admission.ts` fails CLOSED on `db_dump_ok IS TRUE`.
 * Every migration >= 1007 was refused with SQLSTATE 55000 — which aborted the
 * green-checkpoint migration preflight, so no release-gate verdict could be
 * rendered at all.
 *
 * Fail-closed admission is correct and stays. What is pinned here is that a
 * KNOWN-good dump is never persisted as UNKNOWN in the first place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  WorkspaceBackup,
} from './index';
import { isCompletedPreDestructiveSnapshotReceipt } from './snapshot-admission';

let root: string;

function configureWithSql(sql: Sql): void {
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-admission-deadlock-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

/**
 * A step runner that replays `undefined` for the pre-snapshot hook — the exact
 * shape the comment at the assignment site describes, and the one that produced
 * the wedged receipt. The hook itself is NOT re-run, which is faithful: on a
 * replay its event is already durable from the original attempt.
 */
function replayingStepRunner(rowId: number): void {
  configureBackupStepRunner({
    runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (name === 'backup-insert-row') return { id: rowId, startedAtMs: 1000 } as T;
      if (name === 'backup-pre-snapshot-hook') return undefined as T;
      return fn();
    },
  });
}

/** Capture every statement so the final receipt UPDATE can be asserted on. */
function makeSql(
  queries: Array<{ text: string; values: unknown[] }>,
  hookPayload: Record<string, unknown> | null,
): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (text.includes('FROM harness_shared.backup_events')) {
      return Promise.resolve(hookPayload === null ? [] : [{ payload_json: hookPayload }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
}

async function runSnapshot(backup: WorkspaceBackup): Promise<void> {
  vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(backup as any, 'kopia').mockResolvedValue(
    JSON.stringify({ id: 'kopia-artifact', stats: { addedSize: 17, totalSize: 6_948_207_239 } }),
  );
  await backup.snapshot('pre_destructive');
}

function receiptUpdate(queries: Array<{ text: string; values: unknown[] }>) {
  return queries.find((query) => /UPDATE harness_shared\.backup_snapshots/.test(query.text));
}

beforeEach(async () => {
  configureBackupStepRunner(null);
  root = await mkdtemp(join(tmpdir(), 'backup-admission-'));
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('pre-destructive receipt vs. migration admission', () => {
  it('persists a replayed-but-successful dump as db_dump_ok = true', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75742);
    configureWithSql(makeSql(queries, { ok: true, bytes: 9_630_719_546 }));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await runSnapshot(backup);

    // The receipt must record TRUE, not the NULL the replayed step implied.
    expect(receiptUpdate(queries)?.values).toEqual(expect.arrayContaining(['ok', true]));
  });

  it('admits that receipt through the fail-closed guard predicate', () => {
    // The end-to-end point: this is the shape the migration runner admits.
    // With db_dump_ok NULL the same receipt is refused, which is the wedge.
    const receipt = {
      status: 'ok',
      finishedAt: '2026-08-30T14:05:25.545Z',
      kopiaSnapshotId: 'kopia-artifact',
      dbDumpOk: true,
    };
    expect(isCompletedPreDestructiveSnapshotReceipt(receipt)).toBe(true);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...receipt, dbDumpOk: null })).toBe(false);
  });

  it('leaves the verdict UNKNOWN when no hook event was ever recorded', async () => {
    // The calibration case that keeps the fix honest: recovery must read a real
    // record, never manufacture a success from the absence of evidence.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75743);
    configureWithSql(makeSql(queries, null));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(runSnapshot(backup)).rejects.toThrow(/dump success not verified/);

    const update = receiptUpdate(queries);
    expect(update?.values).toEqual(expect.arrayContaining([null]));
    expect(update?.values).not.toEqual(expect.arrayContaining([true]));
    expect(update?.text).toContain("status      = 'failed'");
    expect((backup as any).kopia).not.toHaveBeenCalled();
  });

  it('fails a pre-destructive backup before Kopia when the recovered dump failed', async () => {
    // Recovery must not launder a failure into a success.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75744);
    configureWithSql(makeSql(queries, { ok: false, error: 'pg dump timed out after 900000ms' }));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(runSnapshot(backup)).rejects.toThrow(/requires a successful database dump/);

    expect(receiptUpdate(queries)?.text).toContain("status      = 'failed'");
    expect(receiptUpdate(queries)?.values).toEqual(expect.arrayContaining([false]));
    expect((backup as any).kopia).not.toHaveBeenCalled();
  });
});
