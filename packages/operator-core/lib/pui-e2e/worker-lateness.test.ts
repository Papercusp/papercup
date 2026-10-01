import { afterAll, describe, expect, test } from 'vitest';
import {
  LatenessMonitor,
  describeHarnessStall,
  judgeBudget,
  quantile,
  type TimedSample,
} from './worker-lateness';

// WI-10004333: the P-013 latency budgets in agent-chat-pty.integration.test.ts
// are timed inside the vitest worker. These pin how a late worker is told
// apart from a slow product.

const sample = (ms: number, workerLateMs = 0): TimedSample => ({ ms, workerLateMs });

describe('judgeBudget: lateness can only inflate a sample', () => {
  test('a sample at or under budget meets it, however late the worker was', () => {
    expect(judgeBudget([sample(250, 900)], 250).verdict).toBe('within');
    expect(judgeBudget([sample(40, 70)], 250).verdict).toBe('within');
  });

  test('lateness never turns a measured miss into a pass', () => {
    // Even lateness covering the whole sample leaves an over-budget value
    // either over or inconclusive; both fail the P-013 assertion.
    for (const late of [0, 100, 400, 10_000]) {
      expect(judgeBudget([sample(400, late)], 250).verdict).not.toBe('within');
    }
  });

  test('over budget even after subtracting all lateness is a product failure', () => {
    const judgement = judgeBudget([sample(400, 100)], 250);
    expect(judgement).toMatchObject({ verdict: 'over', observedMs: 400, lowerBoundMs: 300 });
  });

  test('over budget only by what lateness could explain is inconclusive, not a pass or a fail', () => {
    const judgement = judgeBudget([sample(354, 330)], 250);
    expect(judgement).toMatchObject({ verdict: 'inconclusive', observedMs: 354, lowerBoundMs: 24 });
  });

  test('a lower bound never goes below zero', () => {
    expect(judgeBudget([sample(30, 500)], 10).lowerBoundMs).toBe(0);
  });

  test('p95 of a series judges both bounds at the same quantile', () => {
    // 19 quick keys and one key the worker delivered 300ms late: p95 (nearest
    // rank, 20 samples -> the 19th) stays within budget.
    const keys = [...Array.from({ length: 19 }, () => sample(12, 1)), sample(320, 300)];
    expect(judgeBudget(keys, 100, 0.95).verdict).toBe('within');
    // Two such keys push the observed p95 over budget, but the lower bound
    // stays under it: inconclusive.
    const twoLate = [...Array.from({ length: 18 }, () => sample(12, 1)), sample(320, 300), sample(330, 300)];
    expect(judgeBudget(twoLate, 100, 0.95)).toMatchObject({ verdict: 'inconclusive', observedMs: 320 });
    // Two genuinely slow keys with a punctual worker are a real p95 miss.
    const twoSlow = [...Array.from({ length: 18 }, () => sample(12, 1)), sample(320, 2), sample(330, 2)];
    expect(judgeBudget(twoSlow, 100, 0.95)).toMatchObject({ verdict: 'over', lowerBoundMs: 318 });
  });

  test('quantile uses nearest rank and refuses an empty series', () => {
    expect(quantile([5, 1, 3], 1)).toBe(5);
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(() => quantile([], 0.95)).toThrow(/no samples/);
  });

  test('the stall message names the bounds and says it is not a product verdict', () => {
    const message = describeHarnessStall('send feedback', judgeBudget([sample(354, 330)], 250));
    expect(message).toMatch(/^HARNESS STALL, not a product verdict: send feedback measured 354ms against a 250ms budget/);
    expect(message).toContain('between 24ms and 354ms');
  });
});

describe('LatenessMonitor measures blocking anywhere in the window', () => {
  const monitor = new LatenessMonitor();
  afterAll(() => monitor.dispose());

  const block = (ms: number) => {
    const start = performance.now();
    while (performance.now() - start < ms) { /* hold the event loop */ }
  };

  // Each of these edges read ~1ms with a bare reset()/read around the window:
  // the monitor must catch all of them.
  test.each([
    ['at the very start of the window', async () => { block(60); }],
    ['at the very end of the window', async () => { await new Promise((r) => setTimeout(r, 3)); block(60); }],
    ['inside an I/O-phase callback', () => new Promise<void>((resolve) => setImmediate(() => { block(60); resolve(); }))],
  ])('a 60ms block %s is counted', async (_where, body) => {
    await monitor.begin();
    await body();
    expect(await monitor.end()).toBeGreaterThanOrEqual(55);
  });

  test('two separate blocks add up instead of reporting only the worst', async () => {
    await monitor.begin();
    block(40);
    await new Promise((r) => setTimeout(r, 3));
    block(40);
    expect(await monitor.end()).toBeGreaterThanOrEqual(75);
  });
});
