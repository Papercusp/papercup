/** maxturn-sweep (P-024): the sweep RIG — cartesian cell expansion + cell→config
 *  resolution (pins floor=cap=target via P-023; honestly reports the 100K point as
 *  unreachable) + a fail-soft, DEFAULT-OFF live entry point. Pure cores; the live cell
 *  actuation (driving real sessions, capturing telemetry) is the deferred driver seam.
 *  P-025 scores the CellResult[] this produces. */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MAXTURN_TARGETS_TOKENS,
  DEFAULT_SESSION_CLASSES,
  DEFAULT_DOOR_SPLIT_VARIANTS,
  DEFAULT_BENCHMARK_TASKS,
  DEFAULT_SWEEP_AXES,
  SESSION_DOOR_FLOOR_MAX,
  cellId,
  expandSweepCells,
  resolveCellConfig,
  emptyCellMetrics,
  runMaxTurnSweep,
  type SweepAxes,
  type SweepCell,
  type CellRunMetrics,
} from './maxturn-sweep';

const ORNITH_WINDOW = 204_800;
const M1_WINDOW = 1_000_000;

// A tiny axes for crisp assertions: 3 targets × 1 class × 1 split × 1 task = 3 cells.
const tinyAxes: SweepAxes = {
  maxTurnTargetsTokens: [2_000, 25_000, 100_000],
  sessionClasses: [{ sessionClass: 'ornith-drone', effectiveWindowTokens: ORNITH_WINDOW }],
  doorSplitVariants: [DEFAULT_DOOR_SPLIT_VARIANTS[0]],
  tasks: [DEFAULT_BENCHMARK_TASKS[0]],
};

const okMetrics = (): CellRunMetrics => ({
  ...emptyCellMetrics(),
  hopsPerTask: 12,
  taskSuccessRate: 1,
  stopReasonLengthRate: 0,
});

describe('door-split variants — well-formed', () => {
  it('every default split sums to 1 with integer slots', () => {
    for (const v of DEFAULT_DOOR_SPLIT_VARIANTS) {
      const { output, resultEach, resultSlots, injections } = v.split;
      expect(Number.isInteger(resultSlots)).toBe(true);
      expect(output + resultSlots * resultEach + injections).toBeCloseTo(1, 9);
    }
  });
});

describe('resolveCellConfig — pins floor=cap=target', () => {
  it('realizes a below-natural target on a small window (cap alone would not: floor binds)', () => {
    const c = resolveCellConfig({ maxTurnTargetTokens: 2_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'baked' });
    expect(c.patch.maxTurnFloorTokens).toBe(2_000);
    expect(c.patch.maxTurnCapTokens).toBe(2_000);
    expect(c.achievedMaxTurnTokens).toBe(2_000);
    expect(c.configReachable).toBe(true);
    expect(c.turnDoors.maxTurn).toBe(2_000);
  });

  it('realizes an ABOVE-natural target on a small window — the reason floor must be pinned too', () => {
    // Ornith natural maxTurn is 8K (floor binds). Target 25K is only reachable by pinning the
    // floor up to 25K as well; setting the cap alone would leave maxTurn at 8K.
    const c = resolveCellConfig({ maxTurnTargetTokens: 25_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'baked' });
    expect(c.patch.maxTurnFloorTokens).toBe(25_000);
    expect(c.achievedMaxTurnTokens).toBe(25_000);
    expect(c.configReachable).toBe(true);
  });

  it('the 100K point is UNREACHABLE through the config surface (floor bound 50K) — reported honestly', () => {
    const c = resolveCellConfig({ maxTurnTargetTokens: 100_000, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(c.patch.maxTurnFloorTokens).toBe(SESSION_DOOR_FLOOR_MAX); // clamped to 50K
    expect(c.patch.maxTurnCapTokens).toBe(100_000);
    expect(c.achievedMaxTurnTokens).toBe(50_000); // cannot exceed the floor bound on any real window
    expect(c.configReachable).toBe(false);
    expect(c.clampNote).toContain('50k');
  });

  it('exactly 50K is reachable (the floor bound), 50K+1 is not', () => {
    const at = resolveCellConfig({ maxTurnTargetTokens: 50_000, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(at.configReachable).toBe(true);
    expect(at.achievedMaxTurnTokens).toBe(50_000);
    const over = resolveCellConfig({ maxTurnTargetTokens: 50_001, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(over.configReachable).toBe(false);
  });

  it('applies the door-split variant to the derived doors', () => {
    const baked = resolveCellConfig({ maxTurnTargetTokens: 8_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'baked' });
    const outputHeavy = resolveCellConfig({ maxTurnTargetTokens: 8_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'output-heavy' });
    expect(baked.turnDoors.output).toBe(Math.floor(8_000 * 0.5)); // 4000
    expect(outputHeavy.turnDoors.output).toBe(Math.floor(8_000 * 0.625)); // 5000
    expect(outputHeavy.turnDoors.injections).toBe(baked.turnDoors.injections); // injections unchanged
  });

  it('derives the compaction thresholds the cell imposes on its window', () => {
    const c = resolveCellConfig({ maxTurnTargetTokens: 8_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'baked' });
    // hard = window − maxTurn; soft = window − (2×maxTurn + overhead 4000).
    expect(c.thresholds.hardTokens).toBe(ORNITH_WINDOW - 8_000);
    expect(c.thresholds.softTokens).toBe(ORNITH_WINDOW - (2 * 8_000 + 4_000));
  });

  it('an unknown split variant falls back to baked (no doorSplit in the patch)', () => {
    const c = resolveCellConfig({ maxTurnTargetTokens: 8_000, effectiveWindowTokens: ORNITH_WINDOW, doorSplitVariantId: 'nope' });
    expect(c.patch.doorSplit).toBeUndefined();
    expect(c.turnDoors.output).toBe(Math.floor(8_000 * 0.5)); // baked split
  });
});

describe('expandSweepCells — cartesian product', () => {
  it('produces target × class × split × task cells with stable, unique ids', () => {
    const cells = expandSweepCells(tinyAxes);
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.cellId)).toEqual([
      'ornith-drone__mt2k__baked__drain',
      'ornith-drone__mt25k__baked__drain',
      'ornith-drone__mt100k__baked__drain',
    ]);
    expect(new Set(cells.map((c) => c.cellId)).size).toBe(3);
  });

  it('the default matrix is 7 targets × 3 classes × 3 splits × 3 tasks = 189 cells', () => {
    const cells = expandSweepCells();
    expect(cells).toHaveLength(
      DEFAULT_MAXTURN_TARGETS_TOKENS.length *
        DEFAULT_SESSION_CLASSES.length *
        DEFAULT_DOOR_SPLIT_VARIANTS.length *
        DEFAULT_BENCHMARK_TASKS.length,
    );
    expect(cells).toHaveLength(189);
    expect(new Set(cells.map((c) => c.cellId)).size).toBe(189);
  });

  it('cellId is order-independent of the axes iteration', () => {
    expect(cellId('interactive', 15_000, 'result-heavy', 'log-analysis')).toBe('interactive__mt15k__result-heavy__log-analysis');
  });
});

describe('runMaxTurnSweep — staged by default, fail-soft when armed', () => {
  it('NOT armed ⇒ every cell staged, nothing driven, driver never called', async () => {
    const driver = vi.fn(async () => okMetrics());
    const out = await runMaxTurnSweep({ axes: tinyAxes, driver });
    expect(out.armed).toBe(false);
    expect(out.ran).toBe(false);
    expect(out.skippedReason).toBe('not-armed');
    expect(out.results.every((r) => r.status === 'staged')).toBe(true);
    expect(driver).not.toHaveBeenCalled();
  });

  it('armed but NO driver ⇒ staged with skippedReason no-driver', async () => {
    const out = await runMaxTurnSweep({ axes: tinyAxes, armed: true });
    expect(out.ran).toBe(false);
    expect(out.skippedReason).toBe('no-driver');
    expect(out.results.every((r) => r.status === 'staged' && r.note === 'no-driver')).toBe(true);
  });

  it('armed + driver ⇒ drives reachable cells, skips the unreachable 100K cell (onlyReachable default)', async () => {
    const driver = vi.fn(async () => okMetrics());
    const out = await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver });
    expect(out.ran).toBe(true);
    // 2K + 25K driven; 100K staged (unreachable).
    const byId = Object.fromEntries(out.results.map((r) => [r.cellId, r]));
    expect(byId['ornith-drone__mt2k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt25k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt100k__baked__drain'].status).toBe('staged');
    expect(driver).toHaveBeenCalledTimes(2);
    expect(out.unreachableCells).toEqual(['ornith-drone__mt100k__baked__drain']);
    expect(out.reachableCount).toBe(2);
  });

  it('onlyReachable:false attempts the unreachable cell too', async () => {
    const driver = vi.fn(async () => okMetrics());
    const out = await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, onlyReachable: false });
    expect(driver).toHaveBeenCalledTimes(3);
    expect(out.results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('a throwing driver on one cell ⇒ that cell status:error, the sweep continues (fail-soft)', async () => {
    const driver = vi.fn(async (cell: SweepCell) => {
      if (cell.maxTurnTargetTokens === 25_000) throw new Error('drone spawn 503');
      return okMetrics();
    });
    const out = await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver });
    const byId = Object.fromEntries(out.results.map((r) => [r.cellId, r]));
    expect(byId['ornith-drone__mt2k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt25k__baked__drain'].status).toBe('error');
    expect(byId['ornith-drone__mt25k__baked__drain'].note).toContain('503');
    expect(byId['ornith-drone__mt25k__baked__drain'].metrics).toEqual(emptyCellMetrics());
    expect(out.ran).toBe(true);
  });

  it('clamps repeats to ≥ 1 and threads it to the driver', async () => {
    const seen: number[] = [];
    const driver = vi.fn(async (_c: SweepCell, _cfg: unknown, opts: { repeats: number }) => {
      seen.push(opts.repeats);
      return okMetrics();
    });
    await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, repeats: 0 });
    expect(seen).toEqual([1, 1]); // 2 reachable cells, each clamped 0 → 1

    seen.length = 0;
    await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, repeats: 3 });
    expect(seen).toEqual([3, 3]);
  });

  it('the default (un-armed) sweep exposes the full 189-cell matrix with configs for inspection', async () => {
    const out = await runMaxTurnSweep();
    expect(out.cells).toHaveLength(189);
    expect(out.results).toHaveLength(189);
    // Every 100K cell (one per class×split×task = 27) is flagged unreachable.
    expect(out.unreachableCells).toHaveLength(DEFAULT_SESSION_CLASSES.length * DEFAULT_DOOR_SPLIT_VARIANTS.length * DEFAULT_BENCHMARK_TASKS.length);
    expect(out.reachableCount).toBe(189 - out.unreachableCells.length);
    expect(out.results.every((r) => r.config.turnDoors.maxTurn > 0)).toBe(true);
  });

  it('exposes the documented default axes', () => {
    expect(DEFAULT_SWEEP_AXES.maxTurnTargetsTokens).toEqual([2_000, 4_000, 8_000, 15_000, 25_000, 50_000, 100_000]);
    expect(DEFAULT_SWEEP_AXES.sessionClasses.map((c) => c.sessionClass)).toEqual(['ornith-drone', 'gateway-claude-drone', 'interactive']);
    expect(DEFAULT_SWEEP_AXES.doorSplitVariants.map((v) => v.id)).toEqual(['baked', 'result-heavy', 'output-heavy']);
    expect(DEFAULT_SWEEP_AXES.tasks.map((t) => t.kind)).toEqual(['drain-style', 'file-heavy-writes', 'long-log-analysis']);
  });
});
