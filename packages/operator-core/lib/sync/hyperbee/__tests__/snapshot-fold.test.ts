import { describe, it, expect } from 'vitest';
import { produceLogSnapshot, shouldCompactOwnLog } from '../log-snapshot';
import {
  mergeAdmittedLogs,
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  findLatestSnapshotIndex,
  seedCursorFromSnapshots,
  type AdmittedLog,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * substrate-peer-log-compaction-2026-06-13 P-005 + P-007 (design A) — the
 * load-bearing correctness proof: a reader that folds a log FROM THE SNAPSHOT
 * INDEX (skipping the summarized prefix) reconstitutes the IDENTICAL PG state as
 * a full fold from index 0. This is what lets a new joiner skip replaying full
 * history. Single-box; the cross-machine sparse-fetch-from-snapshot proof is
 * P-008 (real-hardware-gated).
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}
function del(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table, hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

/** In-memory log satisfying both OwnLog (append/get/length/keyHex) and AdmittedLog. */
function memLog(keyHex: string): OwnLog {
  const ops: PeerLogOp[] = [];
  return {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

/** Fold `logs` into a simulated PG (put sets, del removes), starting each log's
 *  cursor at `startIndex`. Returns the final PG state as a plain object. */
async function foldToPg(
  logs: AdmittedLog[],
  startIndex: number,
): Promise<Record<string, unknown>> {
  const pg = new Map<string, unknown>();
  const cursor = createMergeCursor();
  for (const l of logs) cursor.positions.set(l.keyHex, startIndex);
  await mergeAdmittedLogsIncremental(logs, cursor, {
    getTimeoutMs: 0,
    maxOpsPerPass: 0, // no per-pass budget — fold everything in one pass
    applyImpl: async (env) => {
      const k = `${env.table}::${env.hbKey}`;
      if (env.type === 'del') pg.delete(k);
      else pg.set(k, env.value);
      return true;
    },
  });
  return Object.fromEntries(pg);
}

describe('snapshot fold (P-005 + P-007, design A)', () => {
  it('fold from the snapshot index == full fold from 0 (the replay-skip correctness proof)', async () => {
    const log = memLog('aa'.repeat(32));
    // F-1 overwritten; F-2 put then del (→ absent); F-3 live.
    await log.append(put('queue', 'F-1', { v: 1 }, 1));
    await log.append(put('queue', 'F-2', { v: 2 }, 2));
    await log.append(put('queue', 'F-1', { v: 11 }, 3));
    await log.append(del('queue', 'F-2', 4));
    await log.append(put('queue', 'F-3', { v: 3 }, 5));
    const snapshotIndex = log.length; // 5 — where the snapshot op will land

    // Produce the snapshot (additive append at index 5, coversUpTo 5).
    const res = await produceLogSnapshot(log, { now: 100, schemaVersion: 1 });
    expect(res.appended).toBe(true);
    expect(res.coversUpTo).toBe(5);
    expect(res.rowCount).toBe(3); // F-1, F-3 live + F-2 del-tombstone (EI-1688: del'd keys carried)

    // Tail after the snapshot: F-3 updated, F-4 new.
    await log.append(put('queue', 'F-3', { v: 33 }, 6));
    await log.append(put('queue', 'F-4', { v: 4 }, 7));

    const fullFromZero = await foldToPg([log], 0);
    const fromSnapshot = await foldToPg([log], snapshotIndex);

    // Both reconstruct: F-1=11, F-3=33, F-4=4, F-2 absent.
    expect(fullFromZero).toEqual({
      'queue::F-1': { v: 11 },
      'queue::F-3': { v: 33 },
      'queue::F-4': { v: 4 },
    });
    // The whole point: starting at the snapshot index yields the SAME state
    // without reading [0, snapshotIndex).
    expect(fromSnapshot).toEqual(fullFromZero);
  });

  it('full re-fold (mergeAdmittedLogs) also expands the snapshot to the same winners', async () => {
    const log = memLog('bb'.repeat(32));
    await log.append(put('queue', 'F-1', { v: 1 }, 1));
    await log.append(put('queue', 'F-2', { v: 2 }, 2));
    await produceLogSnapshot(log, { now: 50, schemaVersion: 1 });

    const applied: Record<string, unknown> = {};
    await mergeAdmittedLogs([log], {
      getTimeoutMs: 0,
      applyImpl: async (env) => {
        applied[`${env.table}::${env.hbKey}`] = env.value;
        return true;
      },
    });
    // The snapshot op expands; F-1 + F-2 both reconstituted (the original ops also
    // fold but tie → no double-apply harm; final winners identical).
    expect(applied).toEqual({ 'queue::F-1': { v: 1 }, 'queue::F-2': { v: 2 } });
  });

  it('a fresh joiner that ONLY sees [snapshotIndex, length) reconstitutes full state', async () => {
    // Simulates sparse replication: the joiner never fetched the prefix.
    const source = memLog('cc'.repeat(32));
    await source.append(put('queue', 'A', { n: 1 }, 1));
    await source.append(put('queue', 'B', { n: 2 }, 2));
    await source.append(del('queue', 'A', 3)); // A deleted before the snapshot
    await source.append(put('queue', 'C', { n: 3 }, 4));
    const snapshotIndex = source.length;
    await produceLogSnapshot(source, { now: 10, schemaVersion: 1 });
    await source.append(put('queue', 'C', { n: 33 }, 5)); // tail

    // Build a log exposing ONLY [snapshotIndex, length) (prefix never downloaded).
    const tailOps: PeerLogOp[] = [];
    for (let i = snapshotIndex; i < source.length; i++) {
      const op = await source.get(i);
      if (op) tailOps.push(op);
    }
    const joinerView: AdmittedLog = {
      keyHex: source.keyHex,
      length: tailOps.length,
      get: async (i) => tailOps[i] ?? null,
    };
    const pg = await foldToPg([joinerView], 0);
    // B + C live (C updated by tail); A absent (del'd before the snapshot, omitted).
    expect(pg).toEqual({ 'queue::B': { n: 2 }, 'queue::C': { n: 33 } });
  });
});

describe('shouldCompactOwnLog (P-005 cadence)', () => {
  it('fires once growth since the last snapshot reaches the threshold', () => {
    expect(shouldCompactOwnLog(1000, 0, 1000)).toBe(true);
    expect(shouldCompactOwnLog(999, 0, 1000)).toBe(false);
    expect(shouldCompactOwnLog(2500, 1500, 1000)).toBe(true); // grew 1000 since last
    expect(shouldCompactOwnLog(2400, 1500, 1000)).toBe(false); // grew only 900
  });
  it('a non-positive threshold disables compaction', () => {
    expect(shouldCompactOwnLog(10_000, 0, 0)).toBe(false);
    expect(shouldCompactOwnLog(10_000, 0, -1)).toBe(false);
  });
});

describe('findLatestSnapshotIndex + seedCursorFromSnapshots (P-007 reader seeding)', () => {
  it('finds the latest snapshot index near the tail', async () => {
    const log = memLog('dd'.repeat(32));
    await log.append(put('queue', 'A', { n: 1 }, 1));
    await log.append(put('queue', 'B', { n: 2 }, 2));
    await produceLogSnapshot(log, { now: 5, schemaVersion: 1 }); // snapshot at index 2
    await log.append(put('queue', 'C', { n: 3 }, 6)); // tail
    expect(await findLatestSnapshotIndex(log, 1000, 0)).toBe(2);
  });

  it('returns null when there is no snapshot (→ caller folds from 0)', async () => {
    const log = memLog('ee'.repeat(32));
    await log.append(put('queue', 'A', { n: 1 }, 1));
    await log.append(put('queue', 'B', { n: 2 }, 2));
    expect(await findLatestSnapshotIndex(log, 1000, 0)).toBeNull();
  });

  it('respects the maxLookback bound (a snapshot older than the window is not found)', async () => {
    const log = memLog('ff'.repeat(32));
    await produceLogSnapshot(log, { now: 1, schemaVersion: 1 }); // empty log → no-op (length 0)
    await log.append(put('queue', 'A', { n: 1 }, 1));
    await produceLogSnapshot(log, { now: 2, schemaVersion: 1 }); // snapshot at index 1
    // append 5 tail ops so the snapshot is 5 back; lookback of 2 can't reach it.
    for (let i = 0; i < 5; i++) await log.append(put('queue', `T${i}`, { i }, 10 + i));
    expect(await findLatestSnapshotIndex(log, 2, 0)).toBeNull();
    expect(await findLatestSnapshotIndex(log, 100, 0)).toBe(1);
  });

  it('seeds a fresh cursor at the snapshot index; leaves an advanced cursor untouched', async () => {
    const log = memLog('11'.repeat(32));
    await log.append(put('queue', 'A', { n: 1 }, 1));
    await log.append(put('queue', 'B', { n: 2 }, 2));
    await produceLogSnapshot(log, { now: 5, schemaVersion: 1 }); // snapshot at index 2
    await log.append(put('queue', 'C', { n: 3 }, 6));

    const fresh = createMergeCursor();
    await seedCursorFromSnapshots([log], fresh, { maxLookback: 1000, getTimeoutMs: 0 });
    expect(fresh.positions.get(log.keyHex)).toBe(2); // seeded at the snapshot

    const advanced = createMergeCursor();
    advanced.positions.set(log.keyHex, 99); // already folding past the snapshot
    await seedCursorFromSnapshots([log], advanced, { maxLookback: 1000, getTimeoutMs: 0 });
    expect(advanced.positions.get(log.keyHex)).toBe(99); // untouched — never rewound
  });

  it('a seeded cursor then folds to the SAME state as folding from 0', async () => {
    const log = memLog('22'.repeat(32));
    await log.append(put('queue', 'A', { n: 1 }, 1));
    await log.append(del('queue', 'A', 2)); // A del'd before snapshot
    await log.append(put('queue', 'B', { n: 2 }, 3));
    await produceLogSnapshot(log, { now: 5, schemaVersion: 1 });
    await log.append(put('queue', 'B', { n: 22 }, 6)); // tail

    const fromZero = await foldToPg([log], 0);
    // seed then fold
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor, { maxLookback: 1000, getTimeoutMs: 0 });
    await mergeAdmittedLogsIncremental([log], cursor, {
      getTimeoutMs: 0,
      maxOpsPerPass: 0,
      applyImpl: async (env) => {
        const k = `${env.table}::${env.hbKey}`;
        if (env.type === 'del') pg.delete(k);
        else pg.set(k, env.value);
        return true;
      },
    });
    expect(Object.fromEntries(pg)).toEqual(fromZero);
    expect(fromZero).toEqual({ 'queue::B': { n: 22 } });
  });
});

/**
 * WI-2313 — a MULTI-CHUNK snapshot (the fix for the oversized-block bug) must
 * behave exactly like the single-op snapshot: seed at chunk 0 of the COMPLETE set,
 * fold every chunk, land the identical state. And the crash-consistency guard: a
 * PARTIAL/torn chunk set must NEVER seed the cursor forward (which would silently
 * skip the ops the missing chunks summarize) — it falls back to a full replay.
 */
describe('WI-2313 multi-chunk snapshot fold + crash-consistency', () => {
  /** A log of `n` distinct keys, snapshotted with a tiny chunk budget so the
   *  snapshot spans several chunk ops. Returns the log + where chunk 0 landed. */
  async function makeChunkedLog(keyHex: string, n: number, maxChunkBytes: number) {
    const log = memLog(keyHex);
    for (let i = 0; i < n; i++) {
      await log.append(put('queue', `K${String(i).padStart(3, '0')}`, { pad: 'z'.repeat(80), i }, i + 1));
    }
    const snapshotIndex = log.length;
    const res = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1, maxChunkBytes });
    return { log, snapshotIndex, res };
  }

  it('produce chunks the snapshot; fold from chunk 0 == full fold from 0', async () => {
    const { log, snapshotIndex, res } = await makeChunkedLog('a1'.repeat(32), 24, 500);
    expect(res.appended).toBe(true);
    expect(res.chunkCount).toBeGreaterThan(1); // genuinely multi-chunk
    expect(res.coversUpTo).toBe(snapshotIndex);
    // A post-snapshot tail op to exercise folding past the whole chunk set.
    await log.append(put('queue', 'K000', { pad: 'updated', i: 0 }, 5000));

    // The seed lands at chunk 0 (== coversUpTo), NOT a middle/last chunk.
    expect(await findLatestSnapshotIndex(log, 10_000, 0)).toBe(snapshotIndex);

    const fullFromZero = await foldToPg([log], 0);
    const fromSnapshot = await foldToPg([log], snapshotIndex);
    expect(fromSnapshot).toEqual(fullFromZero);
    // Sanity: the tail update won K000; every other key survived the chunking.
    expect(Object.keys(fullFromZero)).toHaveLength(24);
    expect(fullFromZero['queue::K000']).toEqual({ pad: 'updated', i: 0 });
  });

  it('seedCursorFromSnapshots seeds a fresh cursor at chunk 0 of a complete set; fold matches from-0', async () => {
    const { log, snapshotIndex } = await makeChunkedLog('a2'.repeat(32), 18, 400);
    await log.append(put('queue', 'TAIL', { v: 1 }, 9999));

    const fromZero = await foldToPg([log], 0);
    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([log], cursor, { maxLookback: 10_000, getTimeoutMs: 0 });
    expect(cursor.positions.get(log.keyHex)).toBe(snapshotIndex); // chunk 0, not a middle chunk

    const pg = new Map<string, unknown>();
    await mergeAdmittedLogsIncremental([log], cursor, {
      getTimeoutMs: 0,
      maxOpsPerPass: 0,
      applyImpl: async (env) => {
        const k = `${env.table}::${env.hbKey}`;
        if (env.type === 'del') pg.delete(k);
        else pg.set(k, env.value);
        return true;
      },
    });
    expect(Object.fromEntries(pg)).toEqual(fromZero);
  });

  it('CRASH-CONSISTENCY: a partial chunk set (one chunk block absent) does NOT seed forward', async () => {
    const { log, snapshotIndex, res } = await makeChunkedLog('a3'.repeat(32), 24, 500);
    expect(res.chunkCount).toBeGreaterThan(2);
    // Simulate a sparse replica where a MIDDLE chunk block hasn't downloaded yet:
    // its in-range get() resolves null, but the log length still spans the set.
    const holeIndex = snapshotIndex + 1; // chunk 1 of the set
    const holeyView: AdmittedLog = {
      keyHex: log.keyHex,
      length: log.length,
      get: async (i) => (i === holeIndex ? null : log.get(i)),
    };

    // The set is torn → no complete set found → seed resolves to null (fold from 0),
    // NEVER a forward seed past the un-folded ops the missing chunk summarizes.
    expect(await findLatestSnapshotIndex(holeyView, 10_000, 0)).toBeNull();

    const cursor = createMergeCursor();
    await seedCursorFromSnapshots([holeyView], cursor, { maxLookback: 10_000, getTimeoutMs: 0 });
    expect(cursor.positions.has(log.keyHex)).toBe(false); // left at 0 — full replay
  });

  it('CRASH-CONSISTENCY: a torn newer set still falls back to an EARLIER complete set', async () => {
    // First complete snapshot set, then more ops + a second (newer) set with a
    // MIDDLE chunk block absent. The seed must skip the torn newer set and land on
    // the earlier complete one, not fold from 0 or seed into the hole. (The hole is
    // a MIDDLE chunk, not the tail — the backward scan bails on an unavailable tail
    // block, the inherited single-op "failed read → fold from 0, safe" behavior.)
    const log = memLog('a4'.repeat(32));
    for (let i = 0; i < 20; i++) {
      await log.append(put('queue', `E${String(i).padStart(3, '0')}`, { pad: 'q'.repeat(80) }, i + 1));
    }
    const firstIdx = log.length;
    const first = await produceLogSnapshot(log, { now: 500, schemaVersion: 1, maxChunkBytes: 500 });
    expect(first.chunkCount).toBeGreaterThan(1);
    // Grow the log past the first set, then produce a second (newer) chunked set.
    for (let i = 20; i < 40; i++) {
      await log.append(put('queue', `E${String(i).padStart(3, '0')}`, { pad: 'q'.repeat(80) }, i + 1));
    }
    const secondIdx = log.length;
    const second = await produceLogSnapshot(log, { now: 900, schemaVersion: 1, maxChunkBytes: 500 });
    expect(second.chunkCount).toBeGreaterThan(2); // need a middle chunk (tail stays present)

    // Tear the NEWER set: drop a MIDDLE chunk block (chunk 1); its last chunk (the
    // scan's entry point) stays present so the scan reaches + rejects the torn set.
    const holeIndex = secondIdx + 1;
    const holeyView: AdmittedLog = {
      keyHex: log.keyHex,
      length: log.length,
      get: async (i) => (i === holeIndex ? null : log.get(i)),
    };
    // Falls back to the earlier COMPLETE set (chunk 0 at firstIdx), not the torn one.
    expect(await findLatestSnapshotIndex(holeyView, 10_000, 0)).toBe(firstIdx);
  });
});
