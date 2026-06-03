/**
 * Unit tests for the crash-resumable destructive trio (dbos-durable-flows-adoption
 * P-012 / D-010): promoteRestore / rollbackPromote / restoreInPlace.
 *
 * The headline guarantee is IDEMPOTENT REPLAY — re-running an op (or resuming it
 * after a simulated mid-op crash) lands the same correct final FS state instead
 * of failing on a "source already gone" rename. These tests drive the real FS in
 * a temp dir (no kopia, no PG: `./password` is mocked and the host SQL swallows
 * the best-effort event writes). Determinism comes from a fixed `opId`, so a
 * replay targets the SAME `.broken-/.rolled-back-` paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  WorkspaceBackup,
  type StepRunner,
} from './index';
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

async function dirWith(p: string, marker: string): Promise<void> {
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'marker.txt'), marker);
}
async function marker(p: string): Promise<string> {
  return readFile(join(p, 'marker.txt'), 'utf8');
}
async function exists(p: string): Promise<boolean> {
  try {
    await readFile(join(p, 'marker.txt'));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  fakeHost();
  configureBackupStepRunner(null); // default pass-through (no DBOS in unit tests)
  root = await mkdtemp(join(tmpdir(), 'wb-destructive-'));
  wb = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Stage a promotable layout: a current live dir + a restored clone. */
async function stagePromotable(): Promise<{ clone: string; live: string }> {
  const clone = join(root, '.restored', 'snap1', 'live');
  const live = join(root, 'live');
  await dirWith(clone, 'CLONE');
  await dirWith(live, 'OLD_LIVE');
  return { clone, live };
}

describe('promoteRestore — deterministic + idempotent swap', () => {
  it('happy path: live -> .broken-<opId>-<name>, clone -> live, + meta sidecar', async () => {
    const { clone, live } = await stagePromotable();
    const r = await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });

    expect(r.broken).toBe(join(root, '.broken-op1-live'));
    expect(r.live).toBe(live);
    expect(await marker(live)).toBe('CLONE'); // clone is now live
    expect(await marker(join(root, '.broken-op1-live'))).toBe('OLD_LIVE'); // old live preserved
    const meta = JSON.parse(await readFile(`${join(root, '.broken-op1-live')}.meta.json`, 'utf8'));
    expect(meta.live).toBe(live);
    expect(meta.broken).toBe(join(root, '.broken-op1-live'));
  });

  it('resumes from a half-done swap (step 1 done, step 2 not) → completes correctly', async () => {
    const { clone, live } = await stagePromotable();
    // Simulate a crash AFTER live->broken but BEFORE clone->live.
    await rename(live, join(root, '.broken-op1-live'));
    // Replay with the SAME opId — the swap step detects the partial state.
    await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });
    expect(await marker(live)).toBe('CLONE');
    expect(await marker(join(root, '.broken-op1-live'))).toBe('OLD_LIVE');
  });

  it('full replay (same opId, twice) is a no-op — no throw, state unchanged', async () => {
    const { clone, live } = await stagePromotable();
    await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });
    // Second call: clone already consumed, live already promoted → returns early.
    await expect(wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' })).resolves.toBeTruthy();
    expect(await marker(live)).toBe('CLONE');
    expect(await marker(join(root, '.broken-op1-live'))).toBe('OLD_LIVE');
  });

  it('refuses a clone outside .restored/ (path-traversal guard preserved)', async () => {
    await dirWith(join(root, 'live'), 'OLD');
    await dirWith(join(root, 'evil'), 'X');
    await expect(
      wb.promoteRestore({ restoredPath: join(root, 'evil'), liveTarget: join(root, 'live'), opId: 'op1' }),
    ).rejects.toThrow(/not under <workspace>\/\.restored\//);
  });
});

describe('rollbackPromote — meta-sidecar recovery + idempotent swap', () => {
  it('round-trips a promote: live restored from .broken, clone stashed to .rolled-back', async () => {
    const { clone, live } = await stagePromotable();
    const p = await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });
    const r = await wb.rollbackPromote({ brokenPath: p.broken, opId: 'rb1' });

    expect(r.liveAfter).toBe(live);
    expect(await marker(live)).toBe('OLD_LIVE'); // old live is back
    expect(await marker(join(root, '.rolled-back-rb1-live'))).toBe('CLONE'); // promoted clone stashed
  });

  it('resumes from a half-done rollback (stash done, broken->live not yet)', async () => {
    const { clone, live } = await stagePromotable();
    const p = await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });
    // Simulate crash AFTER live->stash but BEFORE broken->live.
    await rename(live, join(root, '.rolled-back-rb1-live'));
    await wb.rollbackPromote({ brokenPath: p.broken, opId: 'rb1' });
    expect(await marker(live)).toBe('OLD_LIVE');
    expect(await marker(join(root, '.rolled-back-rb1-live'))).toBe('CLONE');
  });

  it('full replay (same opId, twice) is a no-op', async () => {
    const { clone, live } = await stagePromotable();
    const p = await wb.promoteRestore({ restoredPath: clone, liveTarget: live, opId: 'op1' });
    await wb.rollbackPromote({ brokenPath: p.broken, opId: 'rb1' });
    await expect(wb.rollbackPromote({ brokenPath: p.broken, opId: 'rb1' })).resolves.toBeTruthy();
    expect(await marker(live)).toBe('OLD_LIVE');
  });

  it('falls back to the legacy .broken-<ts>-<name> regex when no meta sidecar exists', async () => {
    const legacy = join(root, '.broken-2026-01-01T00-00-00-000Z-live');
    await dirWith(legacy, 'OLD');
    await dirWith(join(root, 'live'), 'CURRENT');
    await wb.rollbackPromote({ brokenPath: legacy, opId: 'rb1' });
    expect(await marker(join(root, 'live'))).toBe('OLD'); // recovered without a sidecar
  });

  it('refuses a brokenPath with neither a sidecar nor a parseable name', async () => {
    const bad = join(root, '.broken-garbage');
    await dirWith(bad, 'X');
    await dirWith(join(root, 'live'), 'CURRENT');
    await expect(wb.rollbackPromote({ brokenPath: bad, opId: 'rb1' })).rejects.toThrow(/no \.meta\.json/);
  });
});

describe('restoreInPlace — step routing', () => {
  it('routes the safety snapshot + kopia apply through named steps', async () => {
    const calls: string[] = [];
    const recording: StepRunner = {
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        calls.push(name);
        return fn();
      },
    };
    configureBackupStepRunner(recording);
    // No kopia binary / real snapshot in a unit test — stub both.
    vi.spyOn(wb, 'snapshot').mockResolvedValue({
      snapshotId: 1,
      kopiaSnapshotId: 'safety-kopia',
      bytesAdded: 0,
      durationMs: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(wb as any, 'kopia').mockResolvedValue('');

    const r = await wb.restoreInPlace({ kopiaSnapshotId: 'snap-1' });
    expect(calls).toEqual(['restore-safety-snapshot', 'restore-kopia-apply']);
    expect(r.prevSnapshotId).toBe('safety-kopia');
  });
});
