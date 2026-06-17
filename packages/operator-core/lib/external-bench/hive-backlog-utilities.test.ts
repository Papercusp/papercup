/**
 * Shared fleet-arm backlog utilities tests (benchmark-suite-metr-hcast-2026-06-17 extraction).
 * The concurrency sampler + the bounded pool are the work-surface-agnostic core every driver shares.
 */
import { describe, expect, it } from 'vitest';
import { makeConcurrencySampler, runConcurrencyPool } from './hive-backlog-utilities';

describe('makeConcurrencySampler', () => {
  it('tracks live occupancy, inline peak, and projects the timeline', () => {
    let t = 0;
    const now = () => t;
    const s = makeConcurrencySampler(0, now);
    s.sample(); // t=0 live=0
    s.enter(); // live=1
    s.enter(); // live=2 (peak)
    t = 10;
    s.sample(); // t=10 live=2
    s.exit(); // live=1
    t = 20;
    s.sample(); // t=20 live=1
    expect(s.peak()).toBe(2);
    const tl = s.finalize(); // appends nothing more; finalize is pure
    expect(tl.peakConcurrent).toBe(2);
    expect(tl.samples).toEqual([
      { tMs: 0, live: 0 },
      { tMs: 10, live: 2 },
      { tMs: 20, live: 1 },
    ]);
    expect(tl.avgConcurrent).toBeCloseTo((0 + 2 + 1) / 3, 6);
  });

  it('exit floors at 0', () => {
    const s = makeConcurrencySampler(0, () => 0);
    s.exit();
    s.exit();
    s.enter();
    expect(s.peak()).toBe(1);
  });
});

describe('runConcurrencyPool', () => {
  it('runs every task exactly once and returns results', async () => {
    const seen: number[] = [];
    const { results, timedOut } = await runConcurrencyPool<number>({
      backlogLength: 5,
      cap: 2,
      now: () => 0,
      deadlineMs: Infinity,
      perTask: async (i) => {
        seen.push(i);
        return i * 10;
      },
    });
    expect(timedOut).toBe(false);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(results.sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40]);
  });

  it('respects the concurrency cap (≤cap live at once)', async () => {
    let live = 0;
    let maxLive = 0;
    await runConcurrencyPool<void>({
      backlogLength: 6,
      cap: 2,
      now: () => 0,
      deadlineMs: Infinity,
      onEntered: () => { live += 1; maxLive = Math.max(maxLive, live); },
      onExited: () => { live -= 1; },
      perTask: async () => { await new Promise((r) => setTimeout(r, 3)); },
    });
    expect(maxLive).toBeLessThanOrEqual(2);
  });

  it('stops pulling once the deadline passes (timedOut)', async () => {
    let t = 0;
    const { results, timedOut } = await runConcurrencyPool<number>({
      backlogLength: 100,
      cap: 1,
      now: () => t,
      deadlineMs: 5,
      perTask: async (i) => {
        t += 3; // each task advances logical time
        return i;
      },
    });
    expect(timedOut).toBe(true);
    expect(results.length).toBeLessThan(100); // bailed out at the deadline
  });

  it('fires onResult per settled task', async () => {
    const banked: number[] = [];
    await runConcurrencyPool<number>({
      backlogLength: 3,
      cap: 3,
      now: () => 0,
      deadlineMs: Infinity,
      perTask: async (i) => i,
      onResult: (r) => { banked.push(r); },
    });
    expect(banked.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});
