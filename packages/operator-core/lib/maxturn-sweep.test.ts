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
  scoreMaxTurnSweep,
  DEFAULT_SWEEP_SCORE_PARAMS,
  type SweepAxes,
  type SweepCell,
  type CellRunMetrics,
  type CellResult,
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

  it('the 100K point IS reachable — the floor bound was raised to 100K (D-012 live-leg prerequisite)', () => {
    const c = resolveCellConfig({ maxTurnTargetTokens: 100_000, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(c.patch.maxTurnFloorTokens).toBe(100_000);
    expect(c.patch.maxTurnCapTokens).toBe(100_000);
    expect(c.achievedMaxTurnTokens).toBe(100_000);
    expect(c.configReachable).toBe(true);
  });

  it('exactly 100K is reachable (the raised floor bound), 100K+1 is not — still reported honestly', () => {
    const at = resolveCellConfig({ maxTurnTargetTokens: 100_000, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(at.configReachable).toBe(true);
    expect(at.achievedMaxTurnTokens).toBe(100_000);
    expect(at.patch.maxTurnFloorTokens).toBe(SESSION_DOOR_FLOOR_MAX);
    const over = resolveCellConfig({ maxTurnTargetTokens: 100_001, effectiveWindowTokens: M1_WINDOW, doorSplitVariantId: 'baked' });
    expect(over.configReachable).toBe(false);
    expect(over.clampNote).toContain('100k');
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

  it('armed + driver ⇒ drives every cell — the 100K point is now config-reachable (D-012 prerequisite landed)', async () => {
    const driver = vi.fn(async () => okMetrics());
    const out = await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver });
    expect(out.ran).toBe(true);
    const byId = Object.fromEntries(out.results.map((r) => [r.cellId, r]));
    expect(byId['ornith-drone__mt2k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt25k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt100k__baked__drain'].status).toBe('ok');
    expect(driver).toHaveBeenCalledTimes(3);
    expect(out.unreachableCells).toEqual([]);
    expect(out.reachableCount).toBe(3);
  });

  it('onlyReachable still guards a genuinely out-of-bound target (>100K) when armed', async () => {
    const driver = vi.fn(async () => okMetrics());
    const axes = { ...tinyAxes, maxTurnTargetsTokens: [2_000, 150_000] };
    const out = await runMaxTurnSweep({ axes, armed: true, driver });
    const byId = Object.fromEntries(out.results.map((r) => [r.cellId, r]));
    expect(byId['ornith-drone__mt2k__baked__drain'].status).toBe('ok');
    expect(byId['ornith-drone__mt150k__baked__drain'].status).toBe('staged');
    expect(driver).toHaveBeenCalledTimes(1);
    expect(out.unreachableCells).toEqual(['ornith-drone__mt150k__baked__drain']);
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

  it('onCell fires once per DRIVEN cell (ok AND error, never staged), and an observer throw never fails the sweep', async () => {
    const driver = vi.fn(async (cell: SweepCell) => {
      if (cell.maxTurnTargetTokens === 25_000) throw new Error('drone spawn 503');
      return okMetrics();
    });
    const seen: Array<{ cellId: string; status: string }> = [];
    const onCell = vi.fn(async (r: { cellId: string; status: string }) => {
      seen.push({ cellId: r.cellId, status: r.status });
      throw new Error('observer disk full'); // must never fail the sweep
    });
    const armed = await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, onCell });
    expect(armed.ran).toBe(true);
    const driven = armed.results.filter((r) => r.status !== 'staged');
    expect(seen).toEqual(driven.map((r) => ({ cellId: r.cellId, status: r.status })));
    expect(seen.some((s) => s.status === 'error')).toBe(true);

    const firedForArmedRun = onCell.mock.calls.length;
    const staged = await runMaxTurnSweep({ axes: tinyAxes, armed: false, onCell });
    expect(staged.results.every((r) => r.status === 'staged')).toBe(true);
    expect(onCell).toHaveBeenCalledTimes(firedForArmedRun); // unchanged — staged cells never fire it
  });

  it('clamps repeats to ≥ 1 and threads it to the driver', async () => {
    const seen: number[] = [];
    const driver = vi.fn(async (_c: SweepCell, _cfg: unknown, opts: { repeats: number }) => {
      seen.push(opts.repeats);
      return okMetrics();
    });
    await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, repeats: 0 });
    expect(seen).toEqual([1, 1, 1]); // 3 reachable cells (100K now included), each clamped 0 → 1

    seen.length = 0;
    await runMaxTurnSweep({ axes: tinyAxes, armed: true, driver, repeats: 3 });
    expect(seen).toEqual([3, 3, 3]);
  });

  it('the default (un-armed) sweep exposes the full 189-cell matrix with configs for inspection', async () => {
    const out = await runMaxTurnSweep();
    expect(out.cells).toHaveLength(189);
    expect(out.results).toHaveLength(189);
    // The whole owner range 2K–100K is config-reachable now (floor bound raised, D-012).
    expect(out.unreachableCells).toHaveLength(0);
    expect(out.reachableCount).toBe(189);
    expect(out.results.every((r) => r.config.turnDoors.maxTurn > 0)).toBe(true);
  });

  it('exposes the documented default axes', () => {
    expect(DEFAULT_SWEEP_AXES.maxTurnTargetsTokens).toEqual([2_000, 4_000, 8_000, 15_000, 25_000, 50_000, 100_000]);
    expect(DEFAULT_SWEEP_AXES.sessionClasses.map((c) => c.sessionClass)).toEqual(['ornith-drone', 'gateway-claude-drone', 'interactive']);
    expect(DEFAULT_SWEEP_AXES.doorSplitVariants.map((v) => v.id)).toEqual(['baked', 'result-heavy', 'output-heavy']);
    expect(DEFAULT_SWEEP_AXES.tasks.map((t) => t.kind)).toEqual(['drain-style', 'file-heavy-writes', 'long-log-analysis']);
  });
});

describe('scoreMaxTurnSweep (P-025) — per-class advisory recommendation', () => {
  const cell = (sessionClass: 'ornith-drone' | 'interactive', target: number): SweepCell => ({
    cellId: cellId(sessionClass, target, 'baked', 'drain'),
    maxTurnTargetTokens: target,
    sessionClass,
    effectiveWindowTokens: sessionClass === 'ornith-drone' ? ORNITH_WINDOW : M1_WINDOW,
    doorSplitVariantId: 'baked',
    taskId: 'drain',
    taskKind: 'drain-style',
  });
  const okResult = (sessionClass: 'ornith-drone' | 'interactive', target: number, m: Partial<CellRunMetrics>): CellResult => ({
    cellId: cellId(sessionClass, target, 'baked', 'drain'),
    cell: cell(sessionClass, target),
    config: resolveCellConfig(cell(sessionClass, target)),
    repeats: 1,
    status: 'ok',
    metrics: { ...emptyCellMetrics(), ...m },
  });
  const passing = (extra: Partial<CellRunMetrics> = {}): Partial<CellRunMetrics> => ({
    taskSuccessRate: 1,
    stopReasonLengthRate: 0,
    spillChaseSuccessRate: 1,
    ...extra,
  });

  it('recommends the SMALLEST target that clears every gate', () => {
    const results: CellResult[] = [
      okResult('ornith-drone', 2_000, passing({ stopReasonLengthRate: 0.3 })), // fails: too many length-stops
      okResult('ornith-drone', 8_000, passing()), // passes
      okResult('ornith-drone', 25_000, passing()), // also passes but bigger
    ];
    const rep = scoreMaxTurnSweep(results);
    const rec = rep.recommendations.find((r) => r.sessionClass === 'ornith-drone')!;
    expect(rec.passingTargets).toEqual([8_000, 25_000]);
    expect(rec.recommendedMaxTurnTokens).toBe(8_000); // smallest passing
    expect(rec.advisoryOnly).toBe(true);
    expect(rep.advisoryOnly).toBe(true);
  });

  it('recommends null with a rationale when no target clears the gates', () => {
    const results = [
      okResult('interactive', 8_000, passing({ taskSuccessRate: 0.5 })),
      okResult('interactive', 15_000, passing({ spillChaseSuccessRate: 0.2 })),
    ];
    const rec = scoreMaxTurnSweep(results).recommendations[0];
    expect(rec.recommendedMaxTurnTokens).toBeNull();
    expect(rec.passingTargets).toEqual([]);
    expect(rec.rationale).toContain('no');
  });

  it('excludes staged/error cells from the aggregation', () => {
    const staged: CellResult = { ...okResult('ornith-drone', 4_000, passing()), status: 'staged', metrics: emptyCellMetrics() };
    const errored: CellResult = { ...okResult('ornith-drone', 4_000, {}), status: 'error', note: 'boom', metrics: emptyCellMetrics() };
    const rep = scoreMaxTurnSweep([staged, errored, okResult('ornith-drone', 8_000, passing())]);
    // Only the 8K ok cell forms a point.
    expect(rep.points.map((p) => p.maxTurnTargetTokens)).toEqual([8_000]);
    expect(rep.points[0].okCells).toBe(1);
  });

  it('averages metrics over multiple ok cells at the same (class,target) point', () => {
    const results = [
      okResult('ornith-drone', 8_000, passing({ hopsPerTask: 10, stopReasonLengthRate: 0.02 })),
      okResult('ornith-drone', 8_000, passing({ hopsPerTask: 20, stopReasonLengthRate: 0.04 })),
    ];
    const p = scoreMaxTurnSweep(results).points[0];
    expect(p.okCells).toBe(2);
    expect(p.meanHopsPerTask).toBe(15);
    expect(p.meanStopReasonLengthRate).toBeCloseTo(0.03);
    expect(p.qualityPassing).toBe(true);
  });

  it('honors minCellsPerPoint (a lone cell cannot pass when 2 are required)', () => {
    const rep = scoreMaxTurnSweep([okResult('ornith-drone', 8_000, passing())], {
      ...DEFAULT_SWEEP_SCORE_PARAMS,
      minCellsPerPoint: 2,
    });
    expect(rep.points[0].qualityPassing).toBe(false);
    expect(rep.recommendations[0].recommendedMaxTurnTokens).toBeNull();
  });

  it('a point with a null gate metric never passes (no fabricated success)', () => {
    // taskSuccessRate present + good, but spillChaseSuccessRate never captured (null).
    const rep = scoreMaxTurnSweep([okResult('ornith-drone', 8_000, { taskSuccessRate: 1, stopReasonLengthRate: 0, spillChaseSuccessRate: null })]);
    expect(rep.points[0].qualityPassing).toBe(false);
  });

  it('sorts points and recommendations deterministically by class then target', () => {
    const rep = scoreMaxTurnSweep([
      okResult('interactive', 15_000, passing()),
      okResult('ornith-drone', 8_000, passing()),
      okResult('ornith-drone', 2_000, passing()),
    ]);
    expect(rep.points.map((p) => `${p.sessionClass}:${p.maxTurnTargetTokens}`)).toEqual([
      'interactive:15000',
      'ornith-drone:2000',
      'ornith-drone:8000',
    ]);
    expect(rep.recommendations.map((r) => r.sessionClass)).toEqual(['interactive', 'ornith-drone']);
  });

  it('exposes the documented default score params', () => {
    expect(DEFAULT_SWEEP_SCORE_PARAMS).toEqual({
      minTaskSuccessRate: 0.95,
      maxStopReasonLengthRate: 0.05,
      minSpillChaseSuccessRate: 0.95,
      minCellsPerPoint: 1,
    });
  });
});
