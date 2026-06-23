import { describe, it, expect, vi } from 'vitest';
import { evaluateDeadManGuard, checkLoopDeadMan } from './loop-dead-man';

describe('evaluateDeadManGuard (P2a — pure dead-man decision)', () => {
  const base = { armedAtMs: 1_000_000, nowMs: 1_000_000, fireCount: 0 };

  it('no bound configured → never breaches', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 1e12, fireCount: 1e9 }).breach).toBe(false);
  });
  it('max-duration breach when wall-clock since arm exceeds the bound', () => {
    const v = evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 3_600_001, maxDurationSec: 3600 });
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('max-duration');
  });
  it('no max-duration breach while within the bound', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 60_000, maxDurationSec: 3600 }).breach).toBe(false);
  });
  it('max-fires breach when prior fires reach the bound (the (N+1)-th is withheld)', () => {
    expect(evaluateDeadManGuard({ ...base, fireCount: 10, maxFires: 10 }).breach).toBe(true);
    expect(evaluateDeadManGuard({ ...base, fireCount: 9, maxFires: 10 }).breach).toBe(false);
  });
  it('duration takes precedence over fires in the reason', () => {
    const v = evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 9e9, fireCount: 999, maxFires: 10, maxDurationSec: 60 });
    expect(v.reason).toContain('max-duration');
  });
  it('a non-positive bound is treated as no bound', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 1e9, maxDurationSec: 0, maxFires: -5 }).breach).toBe(false);
  });
});

function fakeSql(row: { armed_ms: number; fire_count: number }) {
  return ((strings: TemplateStringsArray) => {
    if (/SELECT/i.test(strings.join('?'))) return Promise.resolve([row]);
    return Promise.resolve([]);
  }) as never;
}

describe('checkLoopDeadMan (P2a — IO gate)', () => {
  it('no bound → zero reads, no breach, no auto-pause', async () => {
    const autoPause = vi.fn(async () => {});
    // sql intentionally throws if touched — proves the no-bound path never reads.
    const sql = (() => {
      throw new Error('should not query');
    }) as never;
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: null, maxDurationSec: null }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('auto-pauses on a duration breach', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 7_200_000, fire_count: 3 }); // armed 2h ago
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxDurationSec: 3600, nowMs: now }, { autoPause });
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(expect.anything(), 'r', expect.stringContaining('dead-man'));
  });

  it('auto-pauses on a fire-count breach', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 1000, fire_count: 50 });
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: 50, nowMs: now }, { autoPause });
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('does NOT pause while under both bounds', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 1000, fire_count: 2 });
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: 50, maxDurationSec: 3600, nowMs: now }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });
});
