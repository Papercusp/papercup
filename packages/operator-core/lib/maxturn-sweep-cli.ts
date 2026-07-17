/**
 * maxTurn sweep CLI — the single entry point to actually DRIVE P-025's live
 * canary / matrix (deterministic-context-carry-2026-07-14, WI-5149).
 *
 * Mirrors apps/operator/lib/release/deploy-cli.ts's shape exactly: a safe
 * PLAN-ONLY default (assemble + print the cell matrix, spend nothing) that
 * only actually drives live sessions behind an explicit `--execute` flag
 * (D-001/D-012 — a sweep that binds overrides on live sessions and spends is
 * opt-in, never a default). `main` is fully injectable (argv + the sweep/
 * driver seams) so the CLI's argument handling + preview assembly is unit
 * tested without ever spawning a real headless session.
 *
 *   tsx maxturn-sweep-cli.ts                 # canary PLAN ONLY — 1 cheapest
 *                                             # cell, prints the assembled
 *                                             # cell + resolved config, spends
 *                                             # nothing
 *   tsx maxturn-sweep-cli.ts --execute        # actually run that ONE cell
 *                                             # live (spawns a real headless
 *                                             # psu session, up to
 *                                             # DEFAULT_SWEEP_TASK_TIMEOUT_MS)
 *   tsx maxturn-sweep-cli.ts --full --execute # run the FULL reachable matrix
 *                                             # live — a real multi-hour spend;
 *                                             # get an explicit go/no-go before
 *                                             # ever passing --full --execute
 *   tsx maxturn-sweep-cli.ts --repeats 3 --execute
 *
 * Flags: --execute | --full | --repeats <n> | --session-class <ornith-drone|
 *        gateway-claude-drone|interactive> | --target-tokens <n>
 *
 * The canary default cell (no --full): the SMALLEST maxTurn target
 * (DEFAULT_MAXTURN_TARGETS_TOKENS[0], currently 2K), ornith-drone (the
 * cheapest/smallest-window class), the 'baked' door-split, the 'drain-style'
 * task — exactly the bounded first canary WI-5149 recommends before
 * committing to the full ~162-reachable-cell campaign.
 */

import { isCliEntry } from './util/cli-entry';
import {
  DEFAULT_SWEEP_AXES,
  DEFAULT_MAXTURN_TARGETS_TOKENS,
  DEFAULT_SESSION_CLASSES,
  DEFAULT_DOOR_SPLIT_VARIANTS,
  DEFAULT_BENCHMARK_TASKS,
  runMaxTurnSweep,
  scoreMaxTurnSweep,
  type SweepAxes,
  type SweepSessionClass,
  type SweepRunResult,
  type SweepScoreReport,
} from './maxturn-sweep';
import { makeHeadlessPsuCellDriver } from './maxturn-sweep-live';

/** Injectable seams for `main` — default to the real wiring; tests override
 *  both to drive the CLI's arg-handling/preview branches against stubs. */
export interface MaxTurnSweepCliDeps {
  /** argv to parse (default `process.argv`). */
  argv?: string[];
  /** Assemble + (optionally) drive the sweep (default the real `runMaxTurnSweep`). */
  runSweep?: typeof runMaxTurnSweep;
  /** Build the live driver (default the real `makeHeadlessPsuCellDriver`). Only
   *  called when `--execute` is passed. */
  makeDriver?: typeof makeHeadlessPsuCellDriver;
  /** Score the results (default the real `scoreMaxTurnSweep`). */
  score?: typeof scoreMaxTurnSweep;
  /** Where the CLI prints its JSON summary (default `console.log`). */
  out?: (line: string) => void;
}

function has(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Build the bounded single-cell axes the canary default runs (before ever
 *  reaching for `--full`'s whole matrix). Pure. */
export function canaryAxes(opts: { sessionClass?: SweepSessionClass; targetTokens?: number } = {}): SweepAxes {
  const targetTokens = opts.targetTokens ?? DEFAULT_MAXTURN_TARGETS_TOKENS[0];
  const sessionClass = opts.sessionClass ?? 'ornith-drone';
  const cls = DEFAULT_SESSION_CLASSES.find((c) => c.sessionClass === sessionClass) ?? DEFAULT_SESSION_CLASSES[0];
  return {
    maxTurnTargetsTokens: [targetTokens],
    sessionClasses: [cls],
    doorSplitVariants: [DEFAULT_DOOR_SPLIT_VARIANTS[0]],
    tasks: [DEFAULT_BENCHMARK_TASKS[0]],
  };
}

export async function main(deps: MaxTurnSweepCliDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const runSweep = deps.runSweep ?? runMaxTurnSweep;
  const makeDriver = deps.makeDriver ?? makeHeadlessPsuCellDriver;
  const score = deps.score ?? scoreMaxTurnSweep;
  const out = deps.out ?? ((line: string) => console.log(line));

  const execute = has(argv, '--execute');
  const full = has(argv, '--full');
  const repeats = Number(valueOf(argv, '--repeats') ?? '1') || 1;
  const sessionClass = valueOf(argv, '--session-class') as SweepSessionClass | undefined;
  const targetTokensRaw = valueOf(argv, '--target-tokens');
  const targetTokens = targetTokensRaw != null ? Number(targetTokensRaw) : undefined;

  const axes = full ? DEFAULT_SWEEP_AXES : canaryAxes({ sessionClass, targetTokens });

  if (!execute) {
    // PLAN ONLY — assemble + print the matrix; spends nothing, spawns nothing.
    const preview: SweepRunResult = await runSweep({ axes, armed: false });
    out(
      JSON.stringify(
        {
          mode: 'plan-only',
          cellCount: preview.cells.length,
          reachableCount: preview.reachableCount,
          unreachableCells: preview.unreachableCells,
          cells: preview.cells,
          hint: '--execute actually drives this matrix live (spawns real headless sessions, spends real tokens). Not passed here — nothing ran.',
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const driver = makeDriver();
  const result: SweepRunResult = await runSweep({ axes, armed: true, driver, repeats });
  const report: SweepScoreReport = score(result.results);
  out(
    JSON.stringify(
      {
        mode: full ? 'live-full' : 'live-canary',
        ran: result.ran,
        reachableCount: result.reachableCount,
        results: result.results,
        report,
      },
      null,
      2,
    ),
  );
  return result.ran ? 0 : 1;
}

// Run as the CLI only — bundle-safe (see isCliEntry / EI-650). An `import` of
// this module (a test) is side-effect-free.
if (isCliEntry(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[maxturn-sweep-cli] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
