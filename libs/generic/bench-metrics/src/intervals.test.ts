import { describe, it, expect } from 'vitest';
import { wilsonInterval, bootstrapMeanCI, meanStderr } from './intervals';

describe('wilsonInterval', () => {
  it('is centered on p̂ and symmetric for p=0.5', () => {
    const i = wilsonInterval(5, 10);
    expect(i.point).toBeCloseTo(0.5, 10);
    // Known Wilson 95% interval for 5/10 ≈ [0.2366, 0.7634]
    expect(i.lower).toBeCloseTo(0.2366, 3);
    expect(i.upper).toBeCloseTo(0.7634, 3);
  });

  it('clamps to [0,1] at the extremes', () => {
    const hi = wilsonInterval(10, 10);
    expect(hi.point).toBe(1);
    expect(hi.upper).toBeCloseTo(1, 9); // analytically 1; FP lands at 0.999…9
    expect(hi.upper).toBeLessThanOrEqual(1);
    expect(hi.lower).toBeGreaterThan(0.7);
    expect(hi.lower).toBeLessThan(1);
  });

  it('returns a degenerate interval for n=0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1, ci: 0.95 });
  });

  it('validates inputs', () => {
    expect(() => wilsonInterval(11, 10)).toThrow();
    expect(() => wilsonInterval(2.5, 10)).toThrow();
  });
});

describe('meanStderr', () => {
  it('computes mean and standard error of the mean', () => {
    const r = meanStderr([2, 4, 6]);
    expect(r.mean).toBeCloseTo(4, 10);
    expect(r.stderr).toBeCloseTo(Math.sqrt(4 / 3), 10); // sample var 4, /n=3
    expect(r.n).toBe(3);
  });

  it('handles single and empty samples', () => {
    expect(meanStderr([5])).toEqual({ mean: 5, stderr: 0, n: 1 });
    expect(meanStderr([])).toEqual({ mean: 0, stderr: 0, n: 0 });
  });
});

describe('bootstrapMeanCI', () => {
  it('is deterministic given the same seed', () => {
    const v = [0, 0, 1, 1, 0, 1];
    const a = bootstrapMeanCI(v, { seed: 7, iterations: 2000 });
    const b = bootstrapMeanCI(v, { seed: 7, iterations: 2000 });
    expect(a).toEqual(b);
  });

  it('brackets the observed mean and stays in [0,1] for a 0/1 sample', () => {
    const v = [0, 0, 1, 1];
    const i = bootstrapMeanCI(v, { seed: 3, iterations: 5000 });
    expect(i.point).toBeCloseTo(0.5, 10);
    expect(i.lower).toBeGreaterThanOrEqual(0);
    expect(i.lower).toBeLessThanOrEqual(i.point);
    expect(i.upper).toBeLessThanOrEqual(1);
    expect(i.upper).toBeGreaterThanOrEqual(i.point);
  });

  it('collapses for single/empty samples', () => {
    expect(bootstrapMeanCI([0.5])).toEqual({ point: 0.5, lower: 0.5, upper: 0.5, ci: 0.95 });
    expect(bootstrapMeanCI([])).toEqual({ point: 0, lower: 0, upper: 0, ci: 0.95 });
  });
});
