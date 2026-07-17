/**
 * maxturn-sweep-cli.ts `main()` — WI-5149's runner entry point.
 *
 * Drives `main()` end-to-end with the runSweep/makeDriver/score seams stubbed
 * — NO real headless session ever spawns, NO real config override ever binds.
 * Asserts the safety-critical shape: the default (no `--execute`) is
 * plan-only and NEVER calls `makeDriver`/reaches a driven cell; `--execute`
 * arms the sweep with the injected driver; `--full --execute` widens the axes
 * to the whole default matrix; the canary default is exactly the smallest
 * maxTurn target on the cheapest (ornith-drone) class.
 */
import { describe, it, expect, vi } from 'vitest';
import { main, canaryAxes, fullAxes } from './maxturn-sweep-cli';
import {
  DEFAULT_MAXTURN_TARGETS_TOKENS,
  DEFAULT_SWEEP_AXES,
  DEFAULT_SESSION_CLASSES,
  DEFAULT_DOOR_SPLIT_VARIANTS,
  DEFAULT_BENCHMARK_TASKS,
  emptyCellMetrics,
  type CellResult,
  type RunSweepInput,
  type SweepRunResult,
  type SweepScoreReport,
} from './maxturn-sweep';

function stubSweepResult(over: Partial<SweepRunResult> = {}): SweepRunResult {
  return {
    cells: [],
    results: [],
    armed: false,
    ran: false,
    reachableCount: 0,
    unreachableCells: [],
    ...over,
  };
}

function stubReport(): SweepScoreReport {
  return { points: [], recommendations: [], params: {} as never, advisoryOnly: true };
}

describe('canaryAxes', () => {
  it('defaults to the smallest maxTurn target on ornith-drone with 1 split/task', () => {
    const axes = canaryAxes();
    expect(axes.maxTurnTargetsTokens).toEqual([DEFAULT_MAXTURN_TARGETS_TOKENS[0]]);
    expect(axes.sessionClasses).toHaveLength(1);
    expect(axes.sessionClasses[0].sessionClass).toBe('ornith-drone');
    expect(axes.doorSplitVariants).toHaveLength(1);
    expect(axes.tasks).toHaveLength(1);
  });

  it('honors an explicit sessionClass/targetTokens override', () => {
    const axes = canaryAxes({ sessionClass: 'interactive', targetTokens: 50_000 });
    expect(axes.sessionClasses[0].sessionClass).toBe('interactive');
    expect(axes.maxTurnTargetsTokens).toEqual([50_000]);
  });
});

describe('main() — plan-only default (no --execute)', () => {
  it('never touches makeDriver and never arms the sweep', async () => {
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      expect(input.armed).not.toBe(true);
      return stubSweepResult({ cells: [{ cellId: 'c1' } as never], reachableCount: 1 });
    });
    const makeDriver = vi.fn();
    const out = vi.fn();

    const code = await main({ argv: [], runSweep, makeDriver: makeDriver as never, out });

    expect(code).toBe(0);
    expect(makeDriver).not.toHaveBeenCalled();
    expect(runSweep).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(out.mock.calls[0][0] as string);
    expect(printed.mode).toBe('plan-only');
    expect(printed.cellCount).toBe(1);
  });

  it('passes the canary (single-cell) axes by default, not the full matrix', async () => {
    let seenAxes: RunSweepInput['axes'];
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      seenAxes = input.axes;
      return stubSweepResult();
    });
    await main({ argv: [], runSweep, out: vi.fn() });
    expect(seenAxes?.maxTurnTargetsTokens).toEqual([DEFAULT_MAXTURN_TARGETS_TOKENS[0]]);
    expect(seenAxes?.sessionClasses).toHaveLength(1);
  });

  it('--full widens the plan-only preview to the whole default matrix', async () => {
    let seenAxes: RunSweepInput['axes'];
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      seenAxes = input.axes;
      return stubSweepResult();
    });
    await main({ argv: ['--full'], runSweep, out: vi.fn() });
    expect(seenAxes).toBe(DEFAULT_SWEEP_AXES);
  });
});

describe('fullAxes — --full narrowed by --session-class / --target-tokens', () => {
  it('unfiltered = the whole default matrix axes', () => {
    expect(fullAxes()).toMatchObject({
      maxTurnTargetsTokens: DEFAULT_MAXTURN_TARGETS_TOKENS,
      doorSplitVariants: DEFAULT_DOOR_SPLIT_VARIANTS,
      tasks: DEFAULT_BENCHMARK_TASKS,
    });
    expect(fullAxes()?.sessionClasses).toHaveLength(DEFAULT_SESSION_CLASSES.length);
  });

  it('a session-class filter narrows to that one class, keeping every other axis full', () => {
    const axes = fullAxes({ sessionClass: 'interactive' });
    expect(axes?.sessionClasses.map((c) => c.sessionClass)).toEqual(['interactive']);
    expect(axes?.maxTurnTargetsTokens).toEqual(DEFAULT_MAXTURN_TARGETS_TOKENS);
  });

  it('a filter matching nothing returns null — never silently the whole matrix', () => {
    expect(fullAxes({ sessionClass: 'typo-class' as never })).toBeNull();
    expect(fullAxes({ targetTokens: 12_345 })).toBeNull();
  });

  it('main() fails loud (exit 1, mode:error) on an unmatched --full filter without building a driver', async () => {
    const runSweep = vi.fn();
    const makeDriver = vi.fn();
    const out = vi.fn();
    const code = await main({
      argv: ['--full', '--execute', '--session-class', 'typo-class'],
      runSweep: runSweep as never,
      makeDriver: makeDriver as never,
      out,
    });
    expect(code).toBe(1);
    expect(runSweep).not.toHaveBeenCalled();
    expect(makeDriver).not.toHaveBeenCalled();
    expect(JSON.parse(out.mock.calls[0][0] as string).mode).toBe('error');
  });
});

describe('main() — --execute arms the live driver', () => {
  it('builds the driver, arms the sweep, and scores the results', async () => {
    const cellResult: CellResult = {
      cellId: 'ornith-drone__mt2k__baked__drain',
      cell: {} as never,
      config: {} as never,
      repeats: 1,
      status: 'ok',
      metrics: { ...emptyCellMetrics(), taskSuccessRate: 1 },
    };
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      expect(input.armed).toBe(true);
      expect(typeof input.driver).toBe('function');
      return stubSweepResult({ ran: true, results: [cellResult], reachableCount: 1 });
    });
    const fakeDriver = vi.fn();
    const makeDriver = vi.fn(() => fakeDriver as never);
    const score = vi.fn((): SweepScoreReport => stubReport());
    const out = vi.fn();

    const code = await main({ argv: ['--execute'], runSweep, makeDriver, score, out });

    expect(code).toBe(0);
    expect(makeDriver).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledWith([cellResult]);
    const printed = JSON.parse(out.mock.calls[0][0] as string);
    expect(printed.mode).toBe('live-canary');
    expect(printed.ran).toBe(true);
  });

  it('reports live-full + exit 1 when --full --execute assembles but nothing ran', async () => {
    const runSweep = vi.fn(async () => stubSweepResult({ ran: false }));
    const code = await main({
      argv: ['--full', '--execute'],
      runSweep,
      makeDriver: vi.fn(() => vi.fn() as never),
      score: vi.fn(() => stubReport()),
      out: vi.fn(),
    });
    expect(code).toBe(1);
  });

  it('--out <file> composes an onCell that appends each driven cell as JSONL', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outFile = join(await mkdtemp(join(tmpdir(), 'sweep-cli-out-')), 'cells.jsonl');

    const cellResult: CellResult = {
      cellId: 'ornith-drone__mt2k__baked__drain',
      cell: {} as never,
      config: {} as never,
      repeats: 1,
      status: 'ok',
      metrics: { ...emptyCellMetrics(), taskSuccessRate: 1 },
    };
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      expect(typeof input.onCell).toBe('function');
      await input.onCell!(cellResult);
      await input.onCell!({ ...cellResult, cellId: 'second-cell', status: 'error' });
      return stubSweepResult({ ran: true, results: [cellResult], reachableCount: 1 });
    });
    const code = await main({
      argv: ['--execute', '--out', outFile],
      runSweep,
      makeDriver: vi.fn(() => vi.fn() as never),
      score: vi.fn(() => stubReport()),
      out: vi.fn(),
    });
    expect(code).toBe(0);
    const rows = (await readFile(outFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0].cellId).toBe('ornith-drone__mt2k__baked__drain');
    expect(rows[1]).toMatchObject({ cellId: 'second-cell', status: 'error' });
  });

  it('--repeats <n> is threaded through to runSweep', async () => {
    let seenRepeats: number | undefined;
    const runSweep = vi.fn(async (input: RunSweepInput = {}) => {
      seenRepeats = input.repeats;
      return stubSweepResult({ ran: true });
    });
    await main({
      argv: ['--execute', '--repeats', '3'],
      runSweep,
      makeDriver: vi.fn(() => vi.fn() as never),
      score: vi.fn(() => stubReport()),
      out: vi.fn(),
    });
    expect(seenRepeats).toBe(3);
  });
});
