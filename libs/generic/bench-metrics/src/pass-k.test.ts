import { describe, it, expect } from 'vitest';
import { passAtK, passHatK, meanPassAtK } from './pass-k';

describe('passAtK', () => {
  it('pass@1 equals c/n', () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 10);
    expect(passAtK(10, 7, 1)).toBeCloseTo(0.7, 10);
    expect(passAtK(3, 0, 1)).toBe(0);
  });

  it('returns 1 when fewer than k samples failed', () => {
    expect(passAtK(5, 5, 3)).toBe(1); // 0 failures
    expect(passAtK(5, 4, 3)).toBe(1); // 1 failure < 3
    expect(passAtK(5, 3, 3)).toBe(1); // 2 failures < 3
  });

  it('matches the closed form 1 - C(n-c,k)/C(n,k)', () => {
    // pass@2 over n=10, c=5: 1 - C(5,2)/C(10,2) = 1 - 10/45
    expect(passAtK(10, 5, 2)).toBeCloseTo(1 - 10 / 45, 10);
    // pass@3 over n=3, c=0 → cannot pass → 0
    expect(passAtK(3, 0, 3)).toBeCloseTo(0, 10);
  });

  it('validates arguments', () => {
    expect(() => passAtK(2, 1, 3)).toThrow(/at least k/);
    expect(() => passAtK(5, 6, 1)).toThrow(/c must be/);
    expect(() => passAtK(5, 2, 0)).toThrow(/k must be/);
    expect(() => passAtK(5.5, 2, 1)).toThrow(/integers/);
  });
});

describe('passHatK (reliability)', () => {
  it('pass^1 equals c/n', () => {
    expect(passHatK(5, 2, 1)).toBeCloseTo(0.4, 10);
  });

  it('matches C(c,k)/C(n,k)', () => {
    expect(passHatK(5, 5, 3)).toBeCloseTo(1, 10); // all succeed
    expect(passHatK(5, 3, 3)).toBeCloseTo(1 / 10, 10); // C(3,3)/C(5,3)
    expect(passHatK(4, 2, 2)).toBeCloseTo(1 / 6, 10); // C(2,2)/C(4,2)
  });

  it('is 0 when fewer than k succeeded', () => {
    expect(passHatK(5, 2, 3)).toBe(0);
  });
});

describe('meanPassAtK', () => {
  it('averages per-task pass@k, weighting tasks equally', () => {
    const r = meanPassAtK([{ n: 5, c: 2 }, { n: 5, c: 4 }], 1);
    expect(r.value).toBeCloseTo((0.4 + 0.8) / 2, 10);
    expect(r.tasksUsed).toBe(2);
    expect(r.skipped).toBe(0);
  });

  it('skips tasks with fewer than k samples and reports the count', () => {
    const r = meanPassAtK([{ n: 2, c: 1 }, { n: 1, c: 0 }], 3); // both n < k
    expect(r.tasksUsed).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.value).toBe(0);
  });
});
