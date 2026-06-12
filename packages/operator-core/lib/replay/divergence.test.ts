/**
 * divergence.test.ts — the pure deterministic divergence signals (P-020 /
 * FB-06): the seam that lets the battery's tests pass with a fake LLM.
 */
import { describe, expect, it } from 'vitest';
import { divergenceSignals } from './divergence';

describe('divergenceSignals', () => {
  it('identical trajectories: full similarity, not divergent', () => {
    const text = 'run the tests, fix the mock clock, re-run, green';
    expect(divergenceSignals(text, text)).toEqual({
      tokenJaccard: 1,
      prefixCommonRatio: 1,
      lengthRatio: 1,
      divergent: false,
    });
  });

  it('disjoint trajectories: near-zero similarity, divergent', () => {
    const s = divergenceSignals('alpha bravo charlie delta', 'echo foxtrot golf hotel');
    expect(s.tokenJaccard).toBe(0);
    expect(s.divergent).toBe(true);
  });

  it('shared prefix is measured on whitespace-normalized text', () => {
    const s = divergenceSignals('run the   tests\nthen stop', 'run the tests then continue forever');
    expect(s.prefixCommonRatio).toBeGreaterThan(0.3);
    expect(s.prefixCommonRatio).toBeLessThan(1);
  });

  it('is deterministic and order-sensitive only in prefix, not vocabulary', () => {
    const a = divergenceSignals('one two three', 'three two one');
    expect(a.tokenJaccard).toBe(1); // same vocabulary
    expect(a.prefixCommonRatio).toBeLessThan(1); // different opening
    expect(divergenceSignals('one two three', 'three two one')).toEqual(a);
  });

  it('honors a custom divergence threshold', () => {
    const original = 'aa bb cc dd';
    const replayed = 'aa bb cc ee'; // jaccard 3/5 = 0.6
    expect(divergenceSignals(original, replayed).divergent).toBe(true);
    expect(divergenceSignals(original, replayed, { divergenceThreshold: 0.5 }).divergent).toBe(false);
  });

  it('handles empty inputs without NaN', () => {
    const s = divergenceSignals('', '');
    expect(s).toEqual({ tokenJaccard: 1, prefixCommonRatio: 1, lengthRatio: 1, divergent: false });
  });
});
