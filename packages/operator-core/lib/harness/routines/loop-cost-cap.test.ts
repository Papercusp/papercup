import { describe, it, expect, vi } from 'vitest';
import { evaluateLoopCostCap, checkLoopCostCap, type LoopCostGuardDeps } from './loop-cost-cap';

// A minimal postgres-js `sql` stub: a tagged-template call returning the created_at read row.
// checkLoopCostCap only uses `sql` for the arm-anchor SELECT; readSpend + autoPause are injected.
function fakeSql(armedMs: number) {
  return ((..._args: unknown[]) => Promise.resolve([{ armed_ms: armedMs }])) as never;
}

describe('evaluateLoopCostCap (pure)', () => {
  it('no cap (null/undefined) never breaches', () => {
    expect(evaluateLoopCostCap({ spendCents: 1_000_000, capCents: null }).breach).toBe(false);
    expect(evaluateLoopCostCap({ spendCents: 1_000_000, capCents: undefined }).breach).toBe(false);
  });

  it('a non-positive or non-finite cap is treated as "no cap"', () => {
    expect(evaluateLoopCostCap({ spendCents: 50, capCents: 0 }).breach).toBe(false);
    expect(evaluateLoopCostCap({ spendCents: 50, capCents: -10 }).breach).toBe(false);
    expect(evaluateLoopCostCap({ spendCents: 50, capCents: Number.NaN }).breach).toBe(false);
  });

  it('breaches only when spend STRICTLY exceeds the cap', () => {
    expect(evaluateLoopCostCap({ spendCents: 99, capCents: 100 }).breach).toBe(false);
    expect(evaluateLoopCostCap({ spendCents: 100, capCents: 100 }).breach).toBe(false); // == is not a breach
    expect(evaluateLoopCostCap({ spendCents: 101, capCents: 100 }).breach).toBe(true);
  });
});

describe('checkLoopCostCap', () => {
  it('no cap configured → no breach, and does ZERO reads (no spend/auto-pause)', async () => {
    const deps: LoopCostGuardDeps = {
      readSpend: vi.fn(async () => 999_999),
      autoPause: vi.fn(async () => {}),
    };
    const out = await checkLoopCostCap(
      { sql: fakeSql(1000), routineId: 'rt_x', targetOwnerId: 'su-abc', capCents: null },
      deps,
    );
    expect(out).toEqual({ breach: false, spendCents: 0, capCents: null });
    expect(deps.readSpend).not.toHaveBeenCalled();
    expect(deps.autoPause).not.toHaveBeenCalled();
  });

  it('cap set + spend UNDER → no breach, no auto-pause', async () => {
    const autoPause = vi.fn(async () => {});
    const out = await checkLoopCostCap(
      { sql: fakeSql(1000), routineId: 'rt_x', targetOwnerId: 'su-abc', capCents: 500 },
      { readSpend: vi.fn(async () => 200), autoPause },
    );
    expect(out).toEqual({ breach: false, spendCents: 200, capCents: 500 });
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('cap set + spend OVER → breach AND auto-pauses the routine', async () => {
    const autoPause = vi.fn(async () => {});
    const readSpend = vi.fn(async () => 750);
    const out = await checkLoopCostCap(
      { sql: fakeSql(1000), routineId: 'rt_loop_su-abc', targetOwnerId: 'su-abc', capCents: 500 },
      { readSpend, autoPause },
    );
    expect(out).toEqual({ breach: true, spendCents: 750, capCents: 500 });
    // The arm anchor (created_at) was passed to the spend read as sinceMs.
    expect(readSpend).toHaveBeenCalledWith(expect.objectContaining({ targetOwnerId: 'su-abc', sinceMs: 1000 }));
    // The breach auto-paused exactly this routine.
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(expect.anything(), 'rt_loop_su-abc', expect.stringContaining('cost-cap breached'));
  });
});
