/**
 * store-breakdown — P-043 (shared-pot-dao-cupboard-v1-2026-09-04; D-057, WI-2147374).
 *
 * The measurement half of the retention model. What matters here is that the
 * tool can never report a MEASUREMENT FAILURE as a zero: an unreadable store and
 * an empty store both produce `totalBytes: 0`, and only `unreadable` separates
 * them — the same false-zero class this repo keeps paying for elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  measureStoreDir,
  relateStoreToWire,
  summarizeKindVolume,
  type KindVolumeRow,
} from './store-breakdown';

function fixtureStore(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-breakdown-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    writeFileSync(join(dir, 'db', name), Buffer.alloc(size, 0));
  }
  return dir;
}

describe('measureStoreDir', () => {
  it('totals bytes and splits by RocksDB file class, largest first', () => {
    const dir = fixtureStore({
      '000644.blob': 3000,
      '000666.sst': 1000,
      '000700.sst': 500,
      CURRENT: 16,
    });
    const m = measureStoreDir(dir);

    expect(m.totalBytes).toBe(4516);
    expect(m.fileCount).toBe(4);
    expect(m.byFileClass[0]).toMatchObject({ ext: '.blob', bytes: 3000, files: 1 });
    expect(m.byFileClass[1]).toMatchObject({ ext: '.sst', bytes: 1500, files: 2 });
    // An extension-less RocksDB control file keys on its own name, not on ''.
    expect(m.byFileClass.map((c) => c.ext)).toContain('CURRENT');
    expect(m.byFileClass[0]!.pct).toBeCloseTo(66.4, 0);
    expect(m.unreadable).toBeUndefined();
  });

  it('recurses into the db/ subdirectory (where every core actually lives)', () => {
    const dir = fixtureStore({ '000001.sst': 128 });
    // The file above is written under db/, so a non-recursive walk would total 0.
    expect(measureStoreDir(dir).totalBytes).toBe(128);
  });

  it('reports an unreadable store as UNREADABLE, never as a measured zero', () => {
    const m = measureStoreDir(join(tmpdir(), 'store-breakdown-does-not-exist-4bf0c1'));
    expect(m.totalBytes).toBe(0);
    // The distinction the whole test exists for: 0 bytes here means "could not
    // measure", and a caller that reads it as "the store is empty" is wrong.
    expect(m.unreadable).toBeTruthy();
    expect(m.oldestMtime).toBeNull();
  });

  it('an EMPTY but readable store is a measured zero WITHOUT the unreadable flag', () => {
    const m = measureStoreDir(fixtureStore({}));
    expect(m.totalBytes).toBe(0);
    expect(m.unreadable).toBeUndefined();
  });
});

describe('summarizeKindVolume', () => {
  const rows: KindVolumeRow[] = [
    // The measured shape: a big edited row re-appended many times per key.
    { table: 'harness_plans', appends: 1158, distinctKeys: 97, avgWireBytes: 75865, wireBytes: 1158 * 75865 },
    // The measured shape of insert-only mail: exactly one append per key.
    { table: 'coord_event_log', appends: 12597, distinctKeys: 12595, avgWireBytes: 1416, wireBytes: 12597 * 1416 },
  ];

  it('joins each kind to its retention class and ranks by wire bytes', () => {
    const s = summarizeKindVolume(rows, 24);
    expect(s.rows[0]!.table).toBe('harness_plans');
    expect(s.rows[0]!.retention).toBe('rotating');
    expect(s.rows[0]!.appendsPerKey).toBeCloseTo(11.94, 2);
    expect(s.rows[0]!.classified).toBe(true);
    expect(s.windowHours).toBe(24);
  });

  it('separates the version multiplier from message count — the P-043 finding', () => {
    const s = summarizeKindVolume(rows, 24);
    const coord = s.rows.find((r) => r.table === 'coord_event_log')!;
    // Coordination messages append far MORE often than plans do, yet contribute
    // almost no superseded bytes: 1.00 per key. Ranking by append COUNT would
    // put coord first and reproduce D-057's wrong conclusion.
    expect(coord.appends24h).toBeGreaterThan(s.rows[0]!.appends24h);
    expect(coord.appendsPerKey).toBeCloseTo(1.0, 2);
    expect(coord.latestOnlyBytes24h / coord.wireBytes24h).toBeGreaterThan(0.99);
  });

  it('flags a producing table with NO retention class', () => {
    const s = summarizeKindVolume(
      [...rows, { table: 'not_a_federated_table', appends: 5, distinctKeys: 5, avgWireBytes: 10, wireBytes: 50 }],
      24,
    );
    expect(s.unclassifiedProducers).toEqual(['not_a_federated_table']);
  });

  it('is empty-safe (a quiet window is not a divide-by-zero)', () => {
    const s = summarizeKindVolume([], 24);
    expect(s.rows).toEqual([]);
    expect(s.amplification.versionMultiplier).toBe(0);
    expect(s.unclassifiedProducers).toEqual([]);
  });
});

describe('relateStoreToWire', () => {
  it('carries the population caveat WITH the ratio so it cannot be quoted bare', () => {
    const v = relateStoreToWire(46_000_000_000, 500_000, 257_000_000);
    expect(v.bytesPerOp).toBe(92_000);
    expect(v.storeBytesPerWindowWireByte).toBeCloseTo(179.0, 0);
    // The caveat is the point: D-057 recorded a ratio like this as an
    // unexplained amplification factor, but the two halves count different
    // populations (every peer since creation vs this peer over the window).
    expect(v.caveat).toMatch(/never an amplification factor/);
  });

  it('returns null rather than a fabricated ratio when a half is unmeasurable', () => {
    const v = relateStoreToWire(46_000_000_000, 0, 0);
    expect(v.bytesPerOp).toBeNull();
    expect(v.storeBytesPerWindowWireByte).toBeNull();
  });
});
