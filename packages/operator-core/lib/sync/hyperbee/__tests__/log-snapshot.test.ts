import { describe, it, expect } from 'vitest';
import {
  buildSnapshotRows,
  buildSnapshotOp,
  buildSnapshotOps,
  chunkSnapshotRows,
  isSnapshotOp,
  SNAPSHOT_TABLE_TAG,
  type SnapshotPayload,
  type SnapshotRow,
} from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';

/**
 * substrate-peer-log-compaction-2026-06-13 P-004 — the pure snapshot-op-set
 * builder (design A, D-005). Folds a peer's own-log ops to the minimal
 * current-state put-set.
 */

function put(table: string, hbKey: string, value: unknown, ts: number, hlc?: string): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me', ...(hlc ? { hlc } : {}) };
}
function del(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table, hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

describe('buildSnapshotRows (P-004)', () => {
  it('keeps the latest put per key (single-writer: highest index = current)', () => {
    const rows = buildSnapshotRows([
      put('queue', 'F-1', { v: 'old' }, 1),
      put('queue', 'F-1', { v: 'new' }, 2),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual({ v: 'new' });
    expect(rows[0].ts).toBe(2);
  });

  it('EI-1688: carries a TOMBSTONE for a key whose latest op is a del (not omitted)', () => {
    const rows = buildSnapshotRows([put('queue', 'F-1', { v: 1 }, 1), del('queue', 'F-1', 2)]);
    // Reconstituted as a deleted tombstone carrying the del's ts — NOT omitted — so a
    // snapshot-seeded reader learns the key was deleted (the put-after-del resurrection fix).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table: 'queue', hbKey: 'F-1', ts: 2, deleted: true, value: null });
  });

  it('EI-1688: GC drops a tombstone older than the horizon (reverts to omitted)', () => {
    const ops = [put('queue', 'F-1', { v: 1 }, 1_000), del('queue', 'F-1', 2_000)];
    // del ts=2000; now=10000, horizon=5000 → 2000 < 10000-5000=5000 → GC'd (omitted).
    expect(buildSnapshotRows(ops, { now: 10_000, tombstoneHorizonMs: 5_000 })).toEqual([]);
    // Within the horizon (now=4000) → tombstone kept.
    expect(buildSnapshotRows(ops, { now: 4_000, tombstoneHorizonMs: 5_000 })).toHaveLength(1);
    // No `now` → no GC, tombstone always kept.
    expect(buildSnapshotRows(ops)).toHaveLength(1);
  });

  it('keeps a key that was put → del → put again', () => {
    const rows = buildSnapshotRows([
      put('queue', 'F-1', { v: 1 }, 1),
      del('queue', 'F-1', 2),
      put('queue', 'F-1', { v: 3 }, 3),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual({ v: 3 });
  });

  it('preserves each row’s original ts + hlc (for correct cross-peer LWW at the reader)', () => {
    const rows = buildSnapshotRows([put('queue', 'F-1', { v: 1 }, 42, '000000000000042:00000')]);
    expect(rows[0].ts).toBe(42);
    expect(rows[0].hlc).toBe('000000000000042:00000');
  });

  it('EXPANDS a prior snapshot op so re-snapshotting is correct + idempotent', () => {
    // A key that exists ONLY in a prior snapshot (no tail re-write) must survive.
    const prior = buildSnapshotOp({
      ops: [put('queue', 'F-1', { v: 'snap' }, 1), put('queue', 'F-2', { v: 'snap2' }, 1)],
      coversUpTo: 2,
      author_pubkey: 'me',
      ts: 5,
      schema_version: 1,
    });
    // tail: F-2 re-written, F-3 new. F-1 only in the prior snapshot.
    const rows = buildSnapshotRows([prior, put('queue', 'F-2', { v: 'new2' }, 10), put('queue', 'F-3', { v: 3 }, 11)]);
    const byKey = Object.fromEntries(rows.map((r) => [r.hbKey, r.value]));
    expect(byKey['F-1']).toEqual({ v: 'snap' }); // carried from the prior snapshot
    expect(byKey['F-2']).toEqual({ v: 'new2' }); // tail re-write wins
    expect(byKey['F-3']).toEqual({ v: 3 });
    expect(rows).toHaveLength(3);
  });

  it('EI-1688: a tail del of a snapshotted key TOMBSTONES it (not omitted)', () => {
    const prior = buildSnapshotOp({
      ops: [put('queue', 'F-1', { v: 'snap' }, 1)],
      coversUpTo: 1,
      author_pubkey: 'me',
      ts: 5,
      schema_version: 1,
    });
    const rows = buildSnapshotRows([prior, del('queue', 'F-1', 10)]);
    // The prior snapshot's live F-1 is superseded by the tail del → a tombstone (ts=10).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table: 'queue', hbKey: 'F-1', ts: 10, deleted: true });
  });

  it('is deterministic — sorted by (table, hbKey)', () => {
    const rows = buildSnapshotRows([
      put('zebra', 'b', {}, 1),
      put('alpha', 'z', {}, 1),
      put('alpha', 'a', {}, 1),
    ]);
    expect(rows.map((r) => `${r.table}/${r.hbKey}`)).toEqual(['alpha/a', 'alpha/z', 'zebra/b']);
  });

  it('empty input → empty set', () => {
    expect(buildSnapshotRows([])).toEqual([]);
  });
});

describe('buildSnapshotOp (P-005 wrapper)', () => {
  it('wraps the minimal set into one reserved-tag op carrying coversUpTo + rows', () => {
    const op = buildSnapshotOp({
      ops: [put('queue', 'F-1', { v: 1 }, 1), put('queue', 'F-1', { v: 2 }, 2), del('queue', 'F-2', 3)],
      coversUpTo: 3,
      author_pubkey: 'PUB',
      ts: 99,
      schema_version: 1,
    });
    expect(op.type).toBe('put');
    expect(op.table).toBe(SNAPSHOT_TABLE_TAG);
    expect(op.hbKey).toBe('snapshot/3');
    expect(op.author_pubkey).toBe('PUB');
    expect(isSnapshotOp(op)).toBe(true);
    const payload = op.value as SnapshotPayload;
    expect(payload.coversUpTo).toBe(3);
    // F-1 collapsed to its latest live value; F-2's del reconstituted as a tombstone (EI-1688).
    expect(payload.rows).toHaveLength(2);
    const byKey = Object.fromEntries(payload.rows.map((r) => [r.hbKey, r]));
    expect(byKey['F-1'].value).toEqual({ v: 2 });
    expect(byKey['F-2']).toMatchObject({ deleted: true, ts: 3 });
  });

  it('isSnapshotOp is false for ordinary ops', () => {
    expect(isSnapshotOp(put('queue', 'F-1', {}, 1))).toBe(false);
    expect(isSnapshotOp(null)).toBe(false);
    expect(isSnapshotOp(undefined)).toBe(false);
  });
});

/** WI-2313 — the fix: split the folded rows across size-bounded chunk ops so no
 *  single snapshot append exceeds hypercore's 15 MiB block ceiling (the
 *  BAD_ARGUMENT that meant the snapshot never landed → cursor never seeded →
 *  every restart replayed member logs from 0, the WI-2105 REV-leg restart loop). */
describe('chunkSnapshotRows (WI-2313 chunking)', () => {
  function row(hbKey: string, value: unknown): SnapshotRow {
    return { table: 'queue', hbKey, value, ts: 1, schema_version: 1 };
  }
  const rowBytes = (r: SnapshotRow) => Buffer.byteLength(JSON.stringify(r), 'utf8');
  // Match chunkSnapshotRows' budget metric: the SUM of per-row serialized bytes.
  const bytes = (rows: SnapshotRow[]) => rows.reduce((s, r) => s + rowBytes(r), 0);

  it('empty input → ONE empty chunk (anchors coversUpTo for an all-deleted log)', () => {
    expect(chunkSnapshotRows([])).toEqual([[]]);
  });

  it('rows that fit under the budget → a single chunk', () => {
    const rows = [row('A', { v: 1 }), row('B', { v: 2 })];
    const chunks = chunkSnapshotRows(rows, 1_000_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(rows);
  });

  it('rows over the budget → multiple chunks, each within budget, order + membership preserved', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(`K${String(i).padStart(3, '0')}`, { pad: 'x'.repeat(100) }),
    );
    const budget = 400; // ~2 rows/chunk given each row serializes to ~150B
    const chunks = chunkSnapshotRows(rows, budget);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk is within budget UNLESS it is a single (over-budget) row.
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      if (c.length > 1) expect(bytes(c)).toBeLessThanOrEqual(budget);
    }
    // The concatenation is exactly the input, in order (no row dropped/duplicated).
    expect(chunks.flat()).toEqual(rows);
  });

  it('a single row larger than the budget rides ALONE in its own chunk (never dropped)', () => {
    const big = row('BIG', { pad: 'x'.repeat(5000) });
    const small = row('small', { v: 1 });
    expect(rowBytes(big)).toBeGreaterThan(500);
    const chunks = chunkSnapshotRows([small, big, small], 500);
    // small | big-alone | small
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toEqual([big]);
    expect(chunks.flat()).toEqual([small, big, small]);
  });
});

describe('buildSnapshotOps (WI-2313 chunked producer builder)', () => {
  it('small state → ONE chunk op tagged 0-of-1 (coversUpTo + all rows)', () => {
    const ops = buildSnapshotOps({
      ops: [put('queue', 'F-1', { v: 1 }, 1), put('queue', 'F-2', { v: 2 }, 2)],
      coversUpTo: 2,
      author_pubkey: 'PUB',
      ts: 9,
      schema_version: 1,
    });
    expect(ops).toHaveLength(1);
    const p = ops[0].value as SnapshotPayload;
    expect(isSnapshotOp(ops[0])).toBe(true);
    expect(ops[0].hbKey).toBe('snapshot/2/0-of-1');
    expect(p).toMatchObject({ coversUpTo: 2, chunkIdx: 0, chunkCount: 1 });
    expect(p.rows).toHaveLength(2);
  });

  it('large state + tiny budget → N chunk ops sharing coversUpTo, chunkIdx 0..N-1, union == full fold', () => {
    const srcOps = Array.from({ length: 30 }, (_, i) =>
      put('queue', `K${String(i).padStart(3, '0')}`, { pad: 'y'.repeat(80) }, i + 1),
    );
    const ops = buildSnapshotOps({
      ops: srcOps,
      coversUpTo: srcOps.length,
      author_pubkey: 'PUB',
      ts: 100,
      schema_version: 1,
      maxChunkBytes: 500,
    });
    expect(ops.length).toBeGreaterThan(1);
    const n = ops.length;
    ops.forEach((op, i) => {
      expect(isSnapshotOp(op)).toBe(true);
      const p = op.value as SnapshotPayload;
      expect(p.coversUpTo).toBe(srcOps.length);
      expect(p.chunkIdx).toBe(i);
      expect(p.chunkCount).toBe(n);
      expect(op.hbKey).toBe(`snapshot/${srcOps.length}/${i}-of-${n}`);
    });
    // The chunked rows reassemble EXACTLY to the single-op fold (no key lost/dup'd).
    const chunkedRows = ops.flatMap((op) => (op.value as SnapshotPayload).rows);
    const single = buildSnapshotRows(srcOps, { now: 100 });
    expect(chunkedRows).toEqual(single);
  });
});
