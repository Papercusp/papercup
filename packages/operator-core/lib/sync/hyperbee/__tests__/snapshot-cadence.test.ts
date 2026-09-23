import { describe, expect, it } from 'vitest';
import {
  describeSnapshotSet,
  isSnapshotOp,
  produceLogSnapshot,
  shouldCompactOwnLog,
  snapshotCompactThreshold,
  SnapshotAbortedError,
  SNAPSHOT_COMPACT_EVERY_OPS,
  type SnapshotPayload,
} from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * p2p-join-catchup-speed-2026-09-23 P-003 — the proportional compaction cadence
 * (bar R-6) and the producer pieces the off-gate compaction relies on: the seeding
 * hint that keeps a far-apart compaction O(new tail), the set-size read boot uses to
 * restore the cadence after a restart, and the pre-append abort.
 */

function put(hbKey: string, v: number, ts: number): PeerLogOp {
  return { type: 'put', table: 'queue', hbKey, value: { v }, ts, schema_version: 1, author_pubkey: 'me' };
}

/** In-memory own log that records every index read, so a test can prove what was NOT read. */
function memLog(keyHex = 'cc'.repeat(32)) {
  const ops: PeerLogOp[] = [];
  const reads: number[] = [];
  const log: OwnLog = {
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
      reads.push(i);
      return ops[i] ?? null;
    },
  };
  return { log, ops, reads };
}

function rowsOf(ops: PeerLogOp[], coversUpTo: number): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const op of ops) {
    if (!isSnapshotOp(op)) continue;
    const p = op.value as SnapshotPayload;
    if (p.coversUpTo !== coversUpTo) continue;
    for (const r of p.rows) out.set(`${r.table}::${r.hbKey}`, r.value);
  }
  return out;
}

describe('snapshotCompactThreshold (R-6)', () => {
  it('keeps the historical floor for a log with no prior snapshot', () => {
    expect(snapshotCompactThreshold(0)).toBe(SNAPSHOT_COMPACT_EVERY_OPS);
  });

  it('keeps the floor while the live state is smaller than it', () => {
    expect(snapshotCompactThreshold(SNAPSHOT_COMPACT_EVERY_OPS - 1)).toBe(SNAPSHOT_COMPACT_EVERY_OPS);
  });

  it('grows with the prior row count once the live state exceeds the floor', () => {
    // The tower's papercusp pot: 214,821 live work_items (endgame D-058).
    expect(snapshotCompactThreshold(214_821)).toBe(214_821);
    expect(snapshotCompactThreshold(214_821, { ratio: 2 })).toBe(429_642);
  });

  it('treats a NaN, negative or non-finite row count as unknown (floor), never as zero-spacing', () => {
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(snapshotCompactThreshold(bad)).toBe(SNAPSHOT_COMPACT_EVERY_OPS);
    }
  });

  it('bounds snapshot rows written to one live-state per live-state of log growth', () => {
    // Simulate a log whose live state is fixed at R keys and which grows by ops only.
    const R = 50_000;
    let lastCoversUpTo = 0;
    let lastRows = 0;
    let snapshotRows = 0;
    const growth = 2_000_000;
    for (let len = 1; len <= growth; len += 1_000) {
      if (shouldCompactOwnLog(len, lastCoversUpTo, snapshotCompactThreshold(lastRows))) {
        snapshotRows += R;
        lastCoversUpTo = len;
        lastRows = R;
      }
    }
    // A fixed 1,000-op cadence would have written growth/1000 × R = 100M rows.
    expect(snapshotRows).toBeLessThanOrEqual(growth + R);
  });
});

describe('describeSnapshotSet', () => {
  it('estimates rows from chunk 0 × chunkCount and reports an unfiltered set', async () => {
    const { log } = memLog();
    for (let i = 0; i < 40; i++) await log.append(put(`K-${i}`, i, i + 1));
    const res = await produceLogSnapshot(log, { now: 100, schemaVersion: 1, maxChunkBytes: 600 });
    expect(res.chunkCount).toBeGreaterThan(1);
    const size = await describeSnapshotSet(log, { coversUpTo: res.coversUpTo, chunkCount: res.chunkCount });
    expect(size).not.toBeNull();
    expect(size!.excludesTables).toBe(false);
    // Byte-cut chunks: every chunk but the last is full, so the estimate never undercounts.
    expect(size!.rowEstimate).toBeGreaterThanOrEqual(res.rowCount);
    expect(size!.rowEstimate).toBeLessThan(res.rowCount * 2);
  });

  it('reports a filtered (head-snapshot) set as excludesTables', async () => {
    const { log } = memLog();
    await log.append(put('K-1', 1, 1));
    await log.append({ ...put('P-1', 1, 2), table: 'presence' });
    const res = await produceLogSnapshot(log, { now: 100, schemaVersion: 1, excludeTables: ['presence'] });
    const size = await describeSnapshotSet(log, { coversUpTo: res.coversUpTo, chunkCount: res.chunkCount });
    expect(size?.excludesTables).toBe(true);
  });

  it('returns null for an index that is not chunk 0 of a snapshot', async () => {
    const { log } = memLog();
    await log.append(put('K-1', 1, 1));
    expect(await describeSnapshotSet(log, { coversUpTo: 0, chunkCount: 1 })).toBeNull();
  });

  it('returns null instead of hanging when chunk 0 never settles', async () => {
    const hung: Pick<OwnLog, 'get'> = { get: () => new Promise<PeerLogOp | null>(() => {}) };
    expect(await describeSnapshotSet(hung, { coversUpTo: 5, chunkCount: 1 }, 20)).toBeNull();
  });
});

describe('produceLogSnapshot priorSnapshotHint (P-003)', () => {
  /** A first snapshot, then a tail far longer than the 4,000-op producer scan window. */
  async function logWithDistantSnapshot() {
    const m = memLog();
    for (let i = 0; i < 50; i++) await m.log.append(put(`K-${i % 10}`, i, i + 1));
    const first = await produceLogSnapshot(m.log, { now: 100, schemaVersion: 1 });
    for (let i = 0; i < 4_500; i++) await m.log.append(put(`K-${i % 25}`, 1_000 + i, 1_000 + i));
    return { ...m, first };
  }

  it('seeds from the hinted set, so the history before it is never re-read', async () => {
    const { log, reads, first } = await logWithDistantSnapshot();
    reads.length = 0;
    const second = await produceLogSnapshot(log, {
      now: 200,
      schemaVersion: 1,
      priorSnapshotHint: { coversUpTo: first.coversUpTo, chunkCount: first.chunkCount },
    });
    expect(second.appended).toBe(true);
    expect(Math.min(...reads)).toBe(first.coversUpTo);
  });

  it('without the hint the same compaction folds from index 0 (the cost the hint removes)', async () => {
    const { log, reads } = await logWithDistantSnapshot();
    reads.length = 0;
    await produceLogSnapshot(log, { now: 200, schemaVersion: 1 });
    expect(Math.min(...reads)).toBe(0);
  });

  it('a hinted compaction writes exactly the rows a full fold writes', async () => {
    const hinted = await logWithDistantSnapshot();
    const full = await logWithDistantSnapshot();
    const a = await produceLogSnapshot(hinted.log, {
      now: 200,
      schemaVersion: 1,
      priorSnapshotHint: { coversUpTo: hinted.first.coversUpTo, chunkCount: hinted.first.chunkCount },
    });
    const b = await produceLogSnapshot(full.log, { now: 200, schemaVersion: 1 });
    expect(a.coversUpTo).toBe(b.coversUpTo);
    expect(rowsOf(hinted.ops, a.coversUpTo)).toEqual(rowsOf(full.ops, b.coversUpTo));
  });

  it('a stale hint that does not point at a complete set falls back safely', async () => {
    const { log, first } = await logWithDistantSnapshot();
    const res = await produceLogSnapshot(log, {
      now: 200,
      schemaVersion: 1,
      priorSnapshotHint: { coversUpTo: first.coversUpTo + 7, chunkCount: first.chunkCount },
    });
    expect(res.appended).toBe(true);
    expect(res.rowCount).toBe(25);
  });
});

describe('produceLogSnapshot shouldAbort (P-003)', () => {
  it('throws SnapshotAbortedError and appends nothing when the caller is stopping', async () => {
    const { log } = memLog();
    for (let i = 0; i < 10; i++) await log.append(put(`K-${i}`, i, i + 1));
    await expect(
      produceLogSnapshot(log, { now: 100, schemaVersion: 1, shouldAbort: () => true }),
    ).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(log.length).toBe(10);
  });

  it('appends normally when shouldAbort stays false', async () => {
    const { log } = memLog();
    for (let i = 0; i < 10; i++) await log.append(put(`K-${i}`, i, i + 1));
    const res = await produceLogSnapshot(log, { now: 100, schemaVersion: 1, shouldAbort: () => false });
    expect(res.appended).toBe(true);
    expect(log.length).toBe(10 + res.chunkCount);
  });
});
