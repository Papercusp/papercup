/**
 * cold-join-canary.test.ts — the D-007 cold-join canary sweep (P-008).
 *
 * Pure/hermetic: every seam (executor, ledger read, ledger write) is injected, so
 * the whole decision matrix runs with no DB and no real join. Proves: default
 * DISABLED, debounce-via-ledger, run→record on pass AND fail, alert on
 * fail/executor-throw, and fail-soft (never throws; a ledger read failure skips).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runColdJoinCanarySweep,
  coldJoinCanaryWindowHours,
  coldJoinCanaryIntervalSec,
} from './cold-join-canary';

/** A sweep harness with injected seams; captures recorded fires + logs. */
function harness(over: Partial<Parameters<typeof runColdJoinCanarySweep>[0]> = {}) {
  const fires: string[] = [];
  const logs: string[] = [];
  return {
    fires,
    logs,
    opts: {
      intervalSec: 86_400, // enabled (daily) unless overridden
      recentFires: vi.fn(async () => 0), // default: not fired recently ⇒ due
      record: vi.fn(async (o: { reason: string }) => {
        fires.push(o.reason);
      }),
      log: (m: string) => logs.push(m),
      ...over,
    },
  };
}

describe('coldJoinCanaryWindowHours', () => {
  it('is >= 1h even for sub-hour intervals', () => {
    expect(coldJoinCanaryWindowHours(60)).toBe(1);
    expect(coldJoinCanaryWindowHours(86_400)).toBe(24);
    expect(coldJoinCanaryWindowHours(3600)).toBe(1);
  });
});

describe('coldJoinCanaryIntervalSec', () => {
  it('defaults to 0 (disabled) when the env is unset', () => {
    const prev = process.env.PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC;
    delete process.env.PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC;
    expect(coldJoinCanaryIntervalSec()).toBe(0);
    if (prev !== undefined) process.env.PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC = prev;
  });
});

describe('runColdJoinCanarySweep', () => {
  it('disabled (interval <= 0) ⇒ a complete no-op', async () => {
    const h = harness({ intervalSec: 0, coldJoin: vi.fn() });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toMatch(/disabled/);
    expect(h.opts.coldJoin).not.toHaveBeenCalled();
    expect(h.fires).toEqual([]);
  });

  it('debounced ⇒ skips without running when a fire is within the window', async () => {
    const coldJoin = vi.fn(async () => ({ ok: true }));
    const h = harness({ recentFires: vi.fn(async () => 1), coldJoin });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toMatch(/debounced/);
    expect(coldJoin).not.toHaveBeenCalled();
  });

  it('due + PASS ⇒ runs, records a PASSED fire (opening the debounce window)', async () => {
    const coldJoin = vi.fn(async () => ({ ok: true, detail: 'reached usable hive in 42s' }));
    const h = harness({ coldJoin });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('ran');
    expect(res.passed).toBe(true);
    expect(coldJoin).toHaveBeenCalledOnce();
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]).toMatch(/PASSED — reached usable hive/);
  });

  it('due + FAIL ⇒ records a FAILED fire + alerts (outcome failed)', async () => {
    const coldJoin = vi.fn(async () => ({ ok: false, detail: 'join never announced' }));
    const h = harness({ coldJoin });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('failed');
    expect(res.passed).toBe(false);
    expect(h.fires[0]).toMatch(/FAILED — join never announced/);
    expect(h.logs.some((l) => /ALERT/.test(l))).toBe(true);
  });

  it('executor THROWS ⇒ error outcome, records a fire (debounce a broken canary), never throws', async () => {
    const coldJoin = vi.fn(async () => {
      throw new Error('rig unreachable');
    });
    const h = harness({ coldJoin });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('error');
    expect(res.reason).toMatch(/EXECUTOR THREW: rig unreachable/);
    expect(h.fires).toHaveLength(1); // recorded so it debounces instead of hammering every tick
  });

  it('enabled but NO executor wired ⇒ loud skip, no fire (re-evaluates next tick)', async () => {
    const h = harness({ coldJoin: undefined });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toMatch(/no cold-join executor/);
    expect(h.fires).toEqual([]);
    expect(h.logs.some((l) => /no cold-join executor wired/.test(l))).toBe(true);
  });

  it('a ledger READ failure skips this tick (never hammers a heavy join)', async () => {
    const coldJoin = vi.fn(async () => ({ ok: true }));
    const h = harness({
      recentFires: vi.fn(async () => {
        throw new Error('pg down');
      }),
      coldJoin,
    });
    const res = await runColdJoinCanarySweep(h.opts);
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toMatch(/ledger read failed/);
    expect(coldJoin).not.toHaveBeenCalled();
  });
});
