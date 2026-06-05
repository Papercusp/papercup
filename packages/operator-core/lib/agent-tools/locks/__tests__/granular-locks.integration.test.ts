/**
 * granular-locks — multi-granularity intention locks, store layer (D-005,
 * locks-correctness-hardening-2026-06-04).
 *
 * Exercises the harness⊃file relationship the file-lock table can't express: a
 * file lock places IX on its ancestors (incl. the harness root), so a
 * harness-exclusive (X on root) now correctly conflicts with an in-flight file
 * lock — and directory/subtree locks + escalation work through the Gray matrix.
 *
 * Live papercusp_su, .skipIf(!live), unique coordination domain per test.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireGranular,
  releaseGranular,
  releaseAllGranularForOwner,
  readGranularHolders,
  type GranularMode,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let wsSeq = 0;
const uniqueWs = () => `gran-test-ws-${Date.now()}-${wsSeq++}`;

const acq = (ws: string, owner: string, path: string, mode: GranularMode, ttlSec = 60) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireGranular(tx, {
      coordinationDomain: ws,
      path,
      mode,
      owner,
      ownerLabel: `gran:${owner}`,
      intent: 'granular test',
      ttlSec,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) => releaseGranular(tx, ws, owner, lockId));

describe('granular-locks (multi-granularity intention locks, D-005)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('a file write takes X on the leaf + IX on every ancestor incl. the harness root', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const r = await acq(ws, 'A', 'apps/operator/foo.ts', 'X');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const modes = new Map(r.locks.map((l) => [l.node, l.mode]));
    expect(modes.get('')).toBe('IX'); // harness root
    expect(modes.get('apps')).toBe('IX');
    expect(modes.get('apps/operator')).toBe('IX');
    expect(modes.get('apps/operator/foo.ts')).toBe('X');
  });

  it.skipIf(!live)('a harness-exclusive conflicts with an in-flight file lock (the headline gap)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const file = await acq(ws, 'A', 'apps/operator/foo.ts', 'X');
    expect(file.ok).toBe(true);
    if (!file.ok) return;

    // B wants the whole harness exclusive → blocked by A's IX on the root.
    const harness = await acq(ws, 'B', '', 'X');
    expect(harness.ok).toBe(false);
    if (!harness.ok) {
      expect(harness.reason).toBe('conflict');
      expect(harness.conflicts.some((c) => c.node === '' && c.held_owner === 'A')).toBe(true);
    }

    // After A releases its whole set, B's harness-exclusive is grantable.
    await rel(ws, 'A', file.lock_id);
    const harness2 = await acq(ws, 'B', '', 'X');
    expect(harness2.ok).toBe(true);
  });

  it.skipIf(!live)('two writers on DIFFERENT files in the same harness coexist', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acq(ws, 'A', 'a/b/one.ts', 'X');
    const b = await acq(ws, 'B', 'a/b/two.ts', 'X');
    expect(a.ok && b.ok).toBe(true); // IX/IX compatible on the shared ancestors
  });

  it.skipIf(!live)('a subtree read (S) blocks a file write under it, and vice versa', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const read = await acq(ws, 'A', 'a/b', 'S'); // S on a/b
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // B writing a file under a/b needs IX on a/b → conflicts with A's S.
    const write = await acq(ws, 'B', 'a/b/c.ts', 'X');
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.conflicts.some((c) => c.node === 'a/b')).toBe(true);
  });

  it.skipIf(!live)('the same owner escalates IX→harness-X; another owner cannot', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const file = await acq(ws, 'A', 'a/b/c.ts', 'X'); // A: IX on root
    expect(file.ok).toBe(true);
    // A escalates to harness-X — self never conflicts.
    const escalate = await acq(ws, 'A', '', 'X');
    expect(escalate.ok).toBe(true);
    // A different owner attempting harness-X conflicts with A's locks.
    const other = await acq(ws, 'C', '', 'X');
    expect(other.ok).toBe(false);
  });

  it.skipIf(!live)('releaseAllGranularForOwner clears every node the owner holds', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    await acq(ws, 'A', 'x/y/z.ts', 'X');
    await acq(ws, 'A', 'p/q', 'S');
    const r = await inWorkspaceTxn(ws, 'A', (tx) => releaseAllGranularForOwner(tx, ws, 'A'));
    expect(r.released).toBeGreaterThan(0);
    const holders = await readGranularHolders(getTxPool(), ws);
    expect(holders.some((h) => h.owner === 'A')).toBe(false);
    await _resetForTests();
  });
});
