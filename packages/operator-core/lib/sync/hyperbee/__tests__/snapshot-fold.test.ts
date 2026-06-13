import { describe, it, expect } from 'vitest';
import { produceLogSnapshot } from '../log-snapshot';
import {
  mergeAdmittedLogs,
  mergeAdmittedLogsIncremental,
  createMergeCursor,
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
    expect(res.rowCount).toBe(2); // F-1, F-3 live; F-2 del'd out

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
