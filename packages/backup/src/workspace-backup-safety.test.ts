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
  WorkspaceBackup,
  type StepRunner,
} from './index';
import { parseKopiaSnapshotJson } from './workspace-backup';
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
