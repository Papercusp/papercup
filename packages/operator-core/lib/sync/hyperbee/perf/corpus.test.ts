/**
 * corpus.test.ts — determinism + shape guarantees of the p2p-perf corpus
 * generator (P-002). Determinism is load-bearing: artifacts are only
 * comparable across runs/machines because {seed, count} fully determines the
 * op stream.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { corpusArray, generateCorpus, mulberry32 } from './corpus';

const AUTHOR = 'a'.repeat(64);

function streamHash(seed: number, count: number): string {
  const h = createHash('sha256');
  for (const op of generateCorpus({ seed, count, authorPubkey: AUTHOR })) {
    h.update(JSON.stringify(op));
  }
  return h.digest('hex');
}

describe('p2p-perf corpus generator', () => {
  it('same seed → byte-identical stream', () => {
    expect(streamHash(42, 5_000)).toBe(streamHash(42, 5_000));
  });

  it('different seeds → different streams', () => {
    expect(streamHash(1, 1_000)).not.toBe(streamHash(2, 1_000));
  });

  it('respects count and emits strictly-increasing per-author ts', () => {
    const ops = corpusArray({ seed: 7, count: 2_500, authorPubkey: AUTHOR });
    expect(ops).toHaveLength(2_500);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].ts).toBeGreaterThan(ops[i - 1].ts);
    }
  });

  it('emits only valid single-writer ops over the registered projection tables', () => {
    const ops = corpusArray({ seed: 7, count: 2_000, authorPubkey: AUTHOR });
    const tables = new Set(ops.map((o) => o.table));
    for (const op of ops) {
      expect(op.type === 'put' || op.type === 'del').toBe(true);
      expect(op.hbKey.length).toBeGreaterThan(0);
      expect(op.schema_version).toBe(1);
      expect(op.author_pubkey).toBe(AUTHOR);
      if (op.type === 'put') expect(op.value).toBeDefined();
      if (op.type === 'del') expect(op.value).toBeUndefined();
    }
    // The mix actually exercises a spread of projections, not one table.
    expect(tables.size).toBeGreaterThanOrEqual(6);
  });

  it('del ratio stays a small minority (LWW folds need standing rows)', () => {
    const ops = corpusArray({ seed: 11, count: 10_000, authorPubkey: AUTHOR });
    const dels = ops.filter((o) => o.type === 'del').length;
    expect(dels / ops.length).toBeLessThan(0.15);
  });

  it('mulberry32 is deterministic and uniform-ish', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    const seq = Array.from({ length: 1000 }, () => a());
    const seq2 = Array.from({ length: 1000 }, () => b());
    expect(seq).toEqual(seq2);
    const mean = seq.reduce((x, y) => x + y, 0) / seq.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});
