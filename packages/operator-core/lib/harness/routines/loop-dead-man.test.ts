import { describe, it, expect, vi } from 'vitest';
import { evaluateDeadManGuard, checkLoopDeadMan, stampLoopArmedAt } from './loop-dead-man';

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

describe('stampLoopArmedAt (EI-7613 — refresh the dead-man arm instant on every materialize)', () => {
  it('issues an UPDATE merging metadata.armed_at as an ISO timestamp string', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as never;

    await stampLoopArmedAt(sql, 'rt_x', 1_700_000_000_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/UPDATE harness_shared\.routines/);
    expect(calls[0].text).toContain('armed_at');
    expect(calls[0].values).toContain('rt_x');
    expect(calls[0].values).toContain(new Date(1_700_000_000_000).toISOString());
  });

  it('defaults to Date.now() when no explicit instant is given', async () => {
    const before = Date.now();
    let stampedIso = '';
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      stampedIso = values.find((v) => typeof v === 'string' && v.includes('T')) as string;
      return Promise.resolve([]);
    }) as never;

    await stampLoopArmedAt(sql, 'rt_x');

    expect(Date.parse(stampedIso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stampedIso)).toBeLessThanOrEqual(Date.now());
  });
});

describe('EI-7613 regression — a re-arm resets the dead-man clock (armed_at wins over created_at)', () => {
  /** A tiny fake store wiring stampLoopArmedAt's UPDATE to checkLoopDeadMan's SELECT,
   *  modeling the real `COALESCE((metadata->>'armed_at')::timestamptz, created_at)` — proves
   *  the two functions' CONTRACT (the metadata key each writes/reads) stays in sync, not just
   *  each function in isolation. */
  function fakeRoutineStore(createdAtMs: number, fireCount = 0) {
    let armedAtIso: string | null = null;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (/UPDATE harness_shared\.routines/.test(text)) {
        armedAtIso = values.find((v) => typeof v === 'string' && v.includes('T')) as string;
        return Promise.resolve([]);
      }
      const armedMs = armedAtIso ? Date.parse(armedAtIso) : createdAtMs;
      return Promise.resolve([{ armed_ms: armedMs, fire_count: fireCount }]);
    }) as never;
    return sql;
  }

  it('a loop armed long ago, then RE-ARMED just now, does NOT instantly breach a fresh maxDurationSec', async () => {
    const createdAtMs = 0; // "day 1" — the row's original arm, long, long ago
    const reArmMs = 100_000_000_000; // "day 2" — re-armed now
    const checkMs = reArmMs + 5_000; // a few seconds after the re-arm, the loop's first fire
    const sql = fakeRoutineStore(createdAtMs);

    // What materializeLoop now does on every arm (fresh or re-arm):
    await stampLoopArmedAt(sql, 'rt_x', reArmMs);

    const autoPause = vi.fn(async () => {});
    const res = await checkLoopDeadMan(
      { sql, routineId: 'rt_x', maxDurationSec: 43_200 /* 12h */, nowMs: checkMs },
      { autoPause },
    );

    // Before the fix this breached instantly (measuring from createdAtMs, ~100M s in the past).
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('WITHOUT a stamp (pre-fix loop, never re-armed since this code shipped) still falls back to created_at', async () => {
    const createdAtMs = 5_000_000 - 7_200_000; // armed 2h ago, never stamped
    const sql = fakeRoutineStore(createdAtMs);

    const autoPause = vi.fn(async () => {});
    const res = await checkLoopDeadMan(
      { sql, routineId: 'rt_x', maxDurationSec: 3600 /* 1h */, nowMs: 5_000_000 },
      { autoPause },
    );

    // Legacy behavior preserved: no stamp ever written -> falls back to created_at -> breaches.
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });
});
