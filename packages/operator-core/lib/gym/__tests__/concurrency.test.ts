import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../concurrency';

/**
 * Parallel isolation (P-004): run N (task×variant) evaluations concurrently bounded
 * by a limit (within the one gym instance, runs are isolated by distinct harness
 * schemas + clone dirs + feature ids). Pure concurrency-limited map; order-preserving.
 */
describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('runs sequentially at limit 1', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return n;
    });
    expect(maxActive).toBe(1);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });

  it('passes the index to the worker', async () => {
    const out = await mapWithConcurrency(['a', 'b'], 2, async (s, i) => `${s}${i}`);
    expect(out).toEqual(['a0', 'b1']);
  });
});
