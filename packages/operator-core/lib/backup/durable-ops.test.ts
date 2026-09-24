/**
 * durable-ops.test.ts — the backup destructive trio's single A/B decision point
 * (dbos-durable-flows-adoption P-012). Each of restoreInPlace / promoteRestore /
 * rollbackPromote starts a crash-resumable DBOS workflow when the backup flag
 * is opted-in, refuses while its executor is absent, or calls the lib directly
 * only when durability was not promised. This
 * pins the WIRING, not the workflows or the lib (those have their own tests):
 *
 *  - an opted-in backup cannot silently fall through to a direct destructive
 *    call while DBOS has not launched; flag-off calls keep the direct path.
 *  - per-function workflow selection (restore→RestoreInPlace, promote→Promote,
 *    rollback→Rollback) — a copy-paste swap is what this catches.
 *  - the args-forwarding distinction: the workflow gets `{ workspaceId, ...args }`
 *    (workspaceId merged in) + a fresh nonce idempotency key; the lib method gets
 *    bare `args` (workspaceId is already bound via workspaceBackupFor(id)).
 *  - nonce uniqueness across calls (idempotency keys must not collide).
 *
 * Mock-source-layer pattern (D-028): mock the backup barrel, the dbos flags, and
 * the lazily-imported workflow module; run the real dispatcher. Pure, no PG/DBOS.
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/backup/durable-ops.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const restoreInPlace = vi.fn(async (..._args: unknown[]) => ({ via: 'lib-restore' }));
const promoteRestore = vi.fn(async () => ({ via: 'lib-promote' }));
const rollbackPromote = vi.fn(async () => ({ via: 'lib-rollback' }));

vi.mock('.', () => ({
  workspaceBackupFor: vi.fn(() => ({ restoreInPlace, promoteRestore, rollbackPromote })),
}));
vi.mock('../dbos/dbos-flags', () => ({ dbosBackupActive: vi.fn() }));
vi.mock('../dbos/bootstrap', () => ({ dbosStarted: vi.fn() }));
vi.mock('../dbos/backup-workflow', () => ({
  startBackupRestoreInPlaceWorkflow: vi.fn(async () => ({ via: 'wf-restore' })),
  startBackupPromoteWorkflow: vi.fn(async () => ({ via: 'wf-promote' })),
  startBackupRollbackWorkflow: vi.fn(async () => ({ via: 'wf-rollback' })),
}));

import { workspaceBackupFor } from '.';
import { dbosBackupActive } from '../dbos/dbos-flags';
import { dbosStarted } from '../dbos/bootstrap';
import {
  startBackupRestoreInPlaceWorkflow,
  startBackupPromoteWorkflow,
  startBackupRollbackWorkflow,
} from '../dbos/backup-workflow';

const wsFor = vi.mocked(workspaceBackupFor);
const active = vi.mocked(dbosBackupActive);
const started = vi.mocked(dbosStarted);
const wfRestore = vi.mocked(startBackupRestoreInPlaceWorkflow);
const wfPromote = vi.mocked(startBackupPromoteWorkflow);
const wfRollback = vi.mocked(startBackupRollbackWorkflow);

const ops = await import('./durable-ops');

const setFlags = (a: boolean, s: boolean) => {
  active.mockReturnValue(a);
  started.mockReturnValue(s);
};

beforeEach(() => {
  vi.clearAllMocks();
  setFlags(false, false); // default: direct path
});

describe('durableRestoreInPlace — A/B dispatch', () => {
  const args = { kopiaSnapshotId: 'snap-1', target: '/live' };

  it('durable path (both flags true) → workflow with {workspaceId,...args} + a nonce, NOT the lib', async () => {
    setFlags(true, true);
    const out = await ops.durableRestoreInPlace('ws-1', args);
    expect(out).toEqual({ via: 'wf-restore' });
    expect(wfRestore).toHaveBeenCalledTimes(1);
    const [payload, nonce] = wfRestore.mock.calls[0]!;
    expect(payload).toEqual({ workspaceId: 'ws-1', ...args }); // workspaceId merged in
    expect(typeof nonce).toBe('string');
    expect((nonce as string).length).toBeGreaterThan(0);
    expect(restoreInPlace).not.toHaveBeenCalled();
  });

  it('direct path → lib method with BARE args (no workspaceId), NOT the workflow', async () => {
    setFlags(false, false);
    const out = await ops.durableRestoreInPlace('ws-1', args);
    expect(out).toEqual({ via: 'lib-restore' });
    expect(wsFor).toHaveBeenCalledWith('ws-1'); // workspaceId bound here, not in args
    expect(restoreInPlace).toHaveBeenCalledWith(args);
    expect(restoreInPlace.mock.calls[0]![0]).not.toHaveProperty('workspaceId');
    expect(wfRestore).not.toHaveBeenCalled();
  });
});

describe('backup durability routing', () => {
  const args = { kopiaSnapshotId: 's' };
  it.each([
    ['active off, started on', false, true],
    ['both off', false, false],
  ])('%s → direct lib path (no workflow)', async (_label, a, s) => {
    setFlags(a, s);
    await ops.durableRestoreInPlace('ws', args);
    expect(restoreInPlace).toHaveBeenCalledTimes(1);
    expect(wfRestore).not.toHaveBeenCalled();
  });

  it('active on, started off refuses all destructive operations before any direct effect', async () => {
    setFlags(true, false);
    await expect(ops.durableRestoreInPlace('ws', args)).rejects.toThrow(/backup durability.*executor unavailable/i);
    await expect(ops.durablePromoteRestore('ws', { restoredPath: '/r' })).rejects.toThrow(/backup durability.*executor unavailable/i);
    await expect(ops.durableRollbackPromote('ws', { brokenPath: '/broken' })).rejects.toThrow(/backup durability.*executor unavailable/i);
    expect(restoreInPlace).not.toHaveBeenCalled();
    expect(promoteRestore).not.toHaveBeenCalled();
    expect(rollbackPromote).not.toHaveBeenCalled();
    expect(wfRestore).not.toHaveBeenCalled();
    expect(wfPromote).not.toHaveBeenCalled();
    expect(wfRollback).not.toHaveBeenCalled();
  });

  it('both on → durable workflow path', async () => {
    setFlags(true, true);
    await ops.durableRestoreInPlace('ws', args);
    expect(wfRestore).toHaveBeenCalledTimes(1);
    expect(restoreInPlace).not.toHaveBeenCalled();
  });
});

describe('per-function selection (no copy-paste swap)', () => {
  it('promoteRestore: durable → Promote workflow; direct → lib promote', async () => {
    const args = { restoredPath: '/r', liveTarget: '/l' };
    setFlags(true, true);
    expect(await ops.durablePromoteRestore('ws', args)).toEqual({ via: 'wf-promote' });
    expect(wfPromote).toHaveBeenCalledWith({ workspaceId: 'ws', ...args }, expect.any(String));
    expect(wfRestore).not.toHaveBeenCalled();
    expect(wfRollback).not.toHaveBeenCalled();

    setFlags(false, true);
    expect(await ops.durablePromoteRestore('ws', args)).toEqual({ via: 'lib-promote' });
    expect(promoteRestore).toHaveBeenCalledWith(args);
  });

  it('rollbackPromote: durable → Rollback workflow; direct → lib rollback', async () => {
    const args = { brokenPath: '/broken' };
    setFlags(true, true);
    expect(await ops.durableRollbackPromote('ws', args)).toEqual({ via: 'wf-rollback' });
    expect(wfRollback).toHaveBeenCalledWith({ workspaceId: 'ws', ...args }, expect.any(String));
    expect(wfPromote).not.toHaveBeenCalled();

    setFlags(false, false);
    expect(await ops.durableRollbackPromote('ws', args)).toEqual({ via: 'lib-rollback' });
    expect(rollbackPromote).toHaveBeenCalledWith(args);
  });
});

describe('nonce idempotency keys', () => {
  it('are unique across calls on the durable path', async () => {
    setFlags(true, true);
    await ops.durableRestoreInPlace('ws', { kopiaSnapshotId: 'a' });
    await ops.durableRestoreInPlace('ws', { kopiaSnapshotId: 'b' });
    const n1 = wfRestore.mock.calls[0]![1];
    const n2 = wfRestore.mock.calls[1]![1];
    expect(n1).not.toBe(n2);
  });
});
