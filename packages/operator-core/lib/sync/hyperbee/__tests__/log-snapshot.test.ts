import { describe, it, expect } from 'vitest';
import {
  buildSnapshotRows,
  buildSnapshotOp,
  isSnapshotOp,
  SNAPSHOT_TABLE_TAG,
  type SnapshotPayload,
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
