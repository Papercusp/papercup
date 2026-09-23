import { describe, it, expect } from 'vitest';
import { SNAPSHOT_TABLE_TAG } from './log-snapshot';
import { findLatestCompleteSnapshot, findLatestCompleteSnapshotDetailed, type AdmittedLog } from './read-merge';
import type { PeerLogOp } from './peer-log';

/**
 * WI-37553 — "I could not READ it" must never be reported as "it is not THERE".
 *
 * The backward snapshot scan used to collapse every failure into `null`. A reader can
 * live with that (it just folds from 0 — correct, only slower), but the seed CUTTER
 * reads `null` as "no snapshot exists" and falls back to shipping FULL corestore history.
 *
 * That is not hypothetical: it failed a real release cut 52 minutes in. The 0.0.14-alpha
 * desktop cut produced a 5.62 GB seed from a core whose snapshot set (44 chunks) sat 48
 * blocks from the tail — comfortably inside the 4,000-block scan window — because the
 * source corestore was live and WAL-churning, so a bounded 5s get lost a race. The
 * seed-degradation guard then (correctly) refused the artifact, and the printed remedy
 * ("append a fresh head snapshot") was a red herring: one had been appended minutes
 * earlier. The scan was not missing the snapshot; it could not read it.
 *
 * Two independent collapse points caused it, and both are covered below:
 *   1. the backward scan itself (`readOpBounded` miss ⇒ bail out), and
 *   2. `verifySnapshotSet` (a chunk read miss ⇒ report the set TORN ⇒ skip its whole span
 *      and keep scanning past a set that was actually complete).
 */

const KEY = 'ab'.repeat(32);
/** Small budget so a "hung" block resolves as a timeout fast. */
const T = 25;
const LOOKBACK = 10_000;

function plainOp(i: number): PeerLogOp {
  return {
    type: 'put',
    table: 'things',
    hbKey: `k${i}`,
    value: { i },
    ts: i + 1,
    schema_version: 1,
    author_pubkey: 'me',
  } as unknown as PeerLogOp;
}

function snapshotChunk(coversUpTo: number, chunkCount: number, chunkIdx: number): PeerLogOp {
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: `snap:${coversUpTo}:${chunkIdx}`,
    value: { coversUpTo, chunkCount, chunkIdx, rows: [] },
    ts: coversUpTo + 1,
    schema_version: 1,
    author_pubkey: 'me',
  } as unknown as PeerLogOp;
}

/** An AdmittedLog whose `get` NEVER resolves for indices in `hang` — the in-process
 *  stand-in for a block the live core is too busy to serve inside the read budget. */
function makeLog(ops: PeerLogOp[], hang: Set<number> = new Set()): AdmittedLog {
  return {
    keyHex: KEY,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      if (hang.has(i)) return new Promise<PeerLogOp | null>(() => {});
      return ops[i] ?? null;
    },
  };
}

/** 10 plain ops, a COMPLETE 3-chunk snapshot set at [10,13) covering up to 10, then 2
 *  more plain ops. Length 15. */
function logWithCompleteSet(hang: Set<number> = new Set()): AdmittedLog {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < 10; i++) ops.push(plainOp(i));
  ops.push(snapshotChunk(10, 3, 0), snapshotChunk(10, 3, 1), snapshotChunk(10, 3, 2));
  ops.push(plainOp(13), plainOp(14));
  return makeLog(ops, hang);
}

describe('snapshot scan: unreadable vs absent (WI-37553)', () => {
  it('finds a complete set when every block reads', async () => {
    const r = await findLatestCompleteSnapshotDetailed(logWithCompleteSet(), LOOKBACK, T);
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') throw new Error('unreachable');
    expect(r.seed).toEqual({ seedIndex: 10, coversUpTo: 10, chunkCount: 3 });
  });

  it('reports UNREADABLE (not none-in-window) when a TAIL block cannot be read', async () => {
    // The scan starts at the tail; block 14 never resolves.
    const r = await findLatestCompleteSnapshotDetailed(logWithCompleteSet(new Set([14])), LOOKBACK, T);
    expect(r.kind).toBe('unreadable');
    if (r.kind !== 'unreadable') throw new Error('unreachable');
    expect(r.atIndex).toBe(14);
    expect(r.cause).toBe('timeout');
  });

  it('reports UNREADABLE when a CHUNK INSIDE an otherwise-complete set cannot be read', async () => {
    // THE REGRESSION THAT SHIPPED 5.62 GB. The scan reaches chunk 2 (index 12), derives
    // the set span [10,13), and verifies it — but chunk 1 (index 11) will not resolve.
    // The old code took that as TORN, skipped the whole span, scanned to the floor, and
    // returned "no snapshot" ⇒ ship full history. The set was complete the whole time.
    const r = await findLatestCompleteSnapshotDetailed(logWithCompleteSet(new Set([11])), LOOKBACK, T);
    expect(r.kind).not.toBe('none-in-window'); // ← the exact old behaviour
    expect(r.kind).toBe('unreadable');
    if (r.kind !== 'unreadable') throw new Error('unreachable');
    expect(r.atIndex).toBe(11);
    expect(r.cause).toBe('timeout');
  });

  it('still reports none-in-window when there is GENUINELY no snapshot', async () => {
    // The one case where "ship full history" is the honest answer — every block read
    // fine and none of them held a snapshot. If this ever reported `unreadable`, the
    // cutter would retry forever instead of falling back.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 12; i++) ops.push(plainOp(i));
    const r = await findLatestCompleteSnapshotDetailed(makeLog(ops), LOOKBACK, T);
    expect(r.kind).toBe('none-in-window');
  });

  it('reports a genuinely TORN set as none-in-window, not unreadable', async () => {
    // A real tear (chunk 1 replaced by an unrelated op) must NOT masquerade as a read
    // problem, or the cutter would retry a set that will never verify.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 10; i++) ops.push(plainOp(i));
    ops.push(snapshotChunk(10, 3, 0), plainOp(11), snapshotChunk(10, 3, 2));
    ops.push(plainOp(13));
    const r = await findLatestCompleteSnapshotDetailed(makeLog(ops), LOOKBACK, T);
    expect(r.kind).toBe('none-in-window');
  });

  it('P-004: with the DEFAULT lookback, finds a complete set 9,000 blocks from the tail (the cutter path)', async () => {
    // The cutter (seed-provider computeSparseFrom) passes SNAPSHOT_SCAN_LOOKBACK. When
    // that was 4,000, a set further back read as none-in-window, so the cutter shipped
    // FULL history even though a sparse cut was possible.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 10; i++) ops.push(plainOp(i));
    ops.push(snapshotChunk(10, 3, 0), snapshotChunk(10, 3, 1), snapshotChunk(10, 3, 2));
    for (let i = 13; i < 9_013; i++) ops.push(plainOp(i));
    const far = makeLog(ops);
    const bounded = await findLatestCompleteSnapshotDetailed(far, 4_000, T);
    expect(bounded.kind).toBe('none-in-window'); // the old window really did miss it
    const r = await findLatestCompleteSnapshotDetailed(far, undefined, T);
    expect(r).toEqual({ kind: 'found', seed: { seedIndex: 10, coversUpTo: 10, chunkCount: 3 } });
  });

  it('P-004: a hung block far from the tail still reports UNREADABLE at that block, not a later one', async () => {
    // The scan reads windows in parallel. It must still report the FIRST problem in
    // descending order, exactly like the old one-read-at-a-time scan.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 10; i++) ops.push(plainOp(i));
    ops.push(snapshotChunk(10, 3, 0), snapshotChunk(10, 3, 1), snapshotChunk(10, 3, 2));
    for (let i = 13; i < 600; i++) ops.push(plainOp(i));
    const r = await findLatestCompleteSnapshotDetailed(makeLog(ops, new Set([400, 50])), undefined, T);
    expect(r).toEqual({ kind: 'unreadable', atIndex: 400, cause: 'timeout' });
  });

  it('READER semantics are unchanged: the boolean wrapper still returns null on an unreadable tail', async () => {
    // Readers must keep folding from 0 on an unreadable tail — that is the safe direction
    // for them. Only the CUTTER needed the distinction, so this wrapper must not change.
    await expect(findLatestCompleteSnapshot(logWithCompleteSet(new Set([14])), LOOKBACK, T)).resolves.toBeNull();
    await expect(findLatestCompleteSnapshot(logWithCompleteSet(new Set([11])), LOOKBACK, T)).resolves.toBeNull();
    await expect(findLatestCompleteSnapshot(logWithCompleteSet(), LOOKBACK, T)).resolves.toEqual({
      seedIndex: 10,
      coversUpTo: 10,
      chunkCount: 3,
    });
  });
});
