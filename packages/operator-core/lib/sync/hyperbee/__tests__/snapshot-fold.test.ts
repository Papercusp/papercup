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
