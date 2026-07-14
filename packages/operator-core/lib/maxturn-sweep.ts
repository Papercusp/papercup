/**
 * maxturn-sweep — the SWEEP RIG for P-024 (deterministic-context-carry-2026-07-14,
 * Phase 8 — maxTurn behavior sweep).
 *
 * P-024: "using the per-session dynamic override (P-023), run a matrix over the maxTurn
 * cap input ∈ {2K, 4K, 8K, 15K, 25K, 50K, 100K} × session class (Ornith drone /
 * gateway-claude drone / interactive) × door-split variants, on a fixed benchmark task
 * set (drain-style, file-heavy writes, long-log analysis)."
 *
 * This module is the PURE, testable heart of that rig: the axis definitions, the cartesian
 * CELL expansion, and — the substantive part — the cell→config RESOLUTION that turns each
 * cell into the exact {@link DoorConstantsPatch} the P-023 surface would apply
 * (context-doors-config.ts → config:doors-set-session) PLUS the derived doors/thresholds
 * the cell imposes (context-doors.ts computeMaxTurn / computeTurnDoors /
 * computeCompactionThresholds). It also carries the fail-soft, DEFAULT-OFF live entry
 * point ({@link runMaxTurnSweep}); the actual actuation — driving real drone/interactive
 * sessions with the cell's override bound and capturing telemetry — is an injected
 * {@link CellDriver} seam that stays staged (armed:false) until the owner arms it, mirroring
 * the staged-arming discipline of the sibling cores (residual-carry-pass.ts / cold-boot-
 * drill.ts / carry-respawn.ts / maintenance-carry.ts).
 *
 * KEY RIG FINDING (grounded, not guessed): to realize a target maxTurn on an ARBITRARY
 * window you must pin BOTH the floor and the cap to the target — setting only the cap lets
 * the 8K floor override it on small windows (Ornith 204.8K → window/26 ≈ 7.9K, so cap=25K
 * still yields maxTurn=8K). And the P-023 config surface bounds the floor at 50K in BOTH
 * verbs (config:doors-set / -set-session), so the 100K sweep point is NOT reachable through
 * the override tools on any realistic window (window/26 ≥ 100K needs a 2.6M window). The rig
 * reports this per cell via {@link CellConfig.configReachable} + achievedMaxTurnTokens so the
 * live leg either skips or specially-provisions those cells rather than silently running a
 * mislabelled 50K cell as "100K".
 *
 * P-025 (blocked-by P-024) consumes the {@link CellResult}[] this rig produces and scores
 * the per-cell metrics ({@link CellRunMetrics}) into per-class constant recommendations —
 * a human ratifies any constant change, never auto-applied (D-001). P-024 defines the rig +
 * the result/metric shapes; P-025 adds the scorer.
 */
import {
  BAKED_DOOR_CONSTANTS,
  computeMaxTurn,
  computeTurnDoors,
  computeCompactionThresholds,
  type DoorConstants,
  type TurnDoors,
  type CompactionThresholds,
} from './context-doors';
import { resolveDoorConstants, type DoorConstantsPatch } from './context-doors-config';

// ─────────────────────────────────────────────────────────────────────────────
// Axes
// ─────────────────────────────────────────────────────────────────────────────

/** The maxTurn targets to sweep (tokens), the owner's 2K–100K range (plan P-024). */
export const DEFAULT_MAXTURN_TARGETS_TOKENS = [2_000, 4_000, 8_000, 15_000, 25_000, 50_000, 100_000] as const;

/** The session classes under test. The class is a real axis even where two share a window:
 *  the LIVE behavior differs (Ornith small-model drone hops vs gateway-claude drone hops vs
 *  interactive human-paced turns), so the driver runs all three. */
export type SweepSessionClass = 'ornith-drone' | 'gateway-claude-drone' | 'interactive';

export interface SessionClassSpec {
  sessionClass: SweepSessionClass;
  /** The effective window (tokens) this class's thresholds derive from — min(backend n_ctx,
   *  configured limit). What computeMaxTurn/thresholds run on for the cell. */
  effectiveWindowTokens: number;
}

/** Representative windows: Ornith ≈ 200K (204800, floor binds → baseline maxTurn 8K); the
 *  opus[1m] drone + interactive classes ≈ 1M (cap binds → baseline maxTurn 15K). Overridable
 *  by passing a custom `axes`. */
export const DEFAULT_SESSION_CLASSES: readonly SessionClassSpec[] = Object.freeze([
  { sessionClass: 'ornith-drone', effectiveWindowTokens: 204_800 },
  { sessionClass: 'gateway-claude-drone', effectiveWindowTokens: 1_000_000 },
  { sessionClass: 'interactive', effectiveWindowTokens: 1_000_000 },
]);

/** A named door-split variant — the proportions of maxTurn given to output / each tool
 *  result / injections. Must sum to 1 (output + resultSlots×resultEach + injections). */
export interface DoorSplitVariant {
  id: string;
  split: DoorConstants['doorSplit'];
}

/** The default split (baked) plus two task-shaped alternatives: result-heavy (widen the tool
 *  door for file-heavy / long-log paging) and output-heavy (widen output for write-heavy
 *  generation). All sum to exactly 1 with 2 result slots. */
export const DEFAULT_DOOR_SPLIT_VARIANTS: readonly DoorSplitVariant[] = Object.freeze([
  { id: 'baked', split: BAKED_DOOR_CONSTANTS.doorSplit },
  { id: 'result-heavy', split: { output: 0.375, resultEach: 0.25, resultSlots: 2, injections: 0.125 } },
  { id: 'output-heavy', split: { output: 0.625, resultEach: 0.125, resultSlots: 2, injections: 0.125 } },
]);

/** The fixed benchmark workloads (plan P-024). */
export type BenchmarkTaskKind = 'drain-style' | 'file-heavy-writes' | 'long-log-analysis';

export interface BenchmarkTask {
  id: string;
  kind: BenchmarkTaskKind;
  /** One line on what the task exercises — the driver maps this to a concrete scenario. */
  summary: string;
}

export const DEFAULT_BENCHMARK_TASKS: readonly BenchmarkTask[] = Object.freeze([
  { id: 'drain', kind: 'drain-style', summary: 'Drain a backlog of small work-items — many short hops, tests the compaction cadence.' },
  { id: 'file-writes', kind: 'file-heavy-writes', summary: 'Author/edit many files — large model output per hop, tests the output door.' },
  { id: 'log-analysis', kind: 'long-log-analysis', summary: 'Analyze a long log/artifact — large tool results, tests the result door + spill-chase.' },
]);

export interface SweepAxes {
  maxTurnTargetsTokens: readonly number[];
  sessionClasses: readonly SessionClassSpec[];
  doorSplitVariants: readonly DoorSplitVariant[];
  tasks: readonly BenchmarkTask[];
}

export const DEFAULT_SWEEP_AXES: SweepAxes = Object.freeze({
  maxTurnTargetsTokens: DEFAULT_MAXTURN_TARGETS_TOKENS,
  sessionClasses: DEFAULT_SESSION_CLASSES,
  doorSplitVariants: DEFAULT_DOOR_SPLIT_VARIANTS,
  tasks: DEFAULT_BENCHMARK_TASKS,
});

// ─────────────────────────────────────────────────────────────────────────────
// P-023 config-surface bounds (mirrored from the config:doors-set[-session] zod schemas)
// ─────────────────────────────────────────────────────────────────────────────

/** The floor override's schema minimum in BOTH config verbs. */
export const SESSION_DOOR_FLOOR_MIN = 1_000;
/** The floor override's schema MAXIMUM in BOTH config verbs — the hard reason the 100K
 *  sweep point is unreachable through the override surface (you cannot pin floor=100K). */
export const SESSION_DOOR_FLOOR_MAX = 50_000;
/** The cap override's schema maximum in BOTH config verbs. */
export const SESSION_DOOR_CAP_MAX = 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// Cells
// ─────────────────────────────────────────────────────────────────────────────

/** `2000 → "2k"`, `100000 → "100k"`, non-round → the raw number. */
function fmtTok(n: number): string {
  return n % 1000 === 0 ? `${n / 1000}k` : `${n}`;
}

/** One point in the sweep matrix. */
export interface SweepCell {
  cellId: string;
  maxTurnTargetTokens: number;
  sessionClass: SweepSessionClass;
  effectiveWindowTokens: number;
  doorSplitVariantId: string;
  taskId: string;
  taskKind: BenchmarkTaskKind;
}

/** Stable, human-readable cell id — order-independent of the axes iteration. */
export function cellId(sessionClass: SweepSessionClass, targetTokens: number, splitVariantId: string, taskId: string): string {
  return `${sessionClass}__mt${fmtTok(targetTokens)}__${splitVariantId}__${taskId}`;
}

/** Expand the axes into the full cartesian product of cells. Pure. */
export function expandSweepCells(axes: SweepAxes = DEFAULT_SWEEP_AXES): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const cls of axes.sessionClasses) {
    for (const target of axes.maxTurnTargetsTokens) {
      for (const variant of axes.doorSplitVariants) {
        for (const task of axes.tasks) {
          cells.push({
            cellId: cellId(cls.sessionClass, target, variant.id, task.id),
            maxTurnTargetTokens: target,
            sessionClass: cls.sessionClass,
            effectiveWindowTokens: cls.effectiveWindowTokens,
            doorSplitVariantId: variant.id,
            taskId: task.id,
            taskKind: task.kind,
          });
        }
      }
    }
  }
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell → config resolution (the substantive pure core)
// ─────────────────────────────────────────────────────────────────────────────

export interface CellConfig {
  /** The DoorConstantsPatch config:doors-set-session would apply to realize this cell —
   *  pins floor=cap=target (clamped to the surface's floor bound) + the split variant. */
  patch: DoorConstantsPatch;
  /** BAKED merged with the patch through the REAL resolution (resolveDoorConstants), so the
   *  rig's expectation matches what the live door sites would actually enforce. */
  effectiveConstants: DoorConstants;
  /** The per-door caps this cell imposes on its window. */
  turnDoors: TurnDoors;
  /** The soft/hard compaction thresholds this cell imposes on its window. */
  thresholds: CompactionThresholds;
  /** The maxTurn the config surface can actually realize for this cell's window (== target
   *  when reachable; caps at the floor bound otherwise). */
  achievedMaxTurnTokens: number;
  /** True ⇒ the override tools can realize the target exactly. False ⇒ the target exceeds the
   *  50K floor bound and no realistic window pushes maxTurn there (the 100K point) — the live
   *  leg must special-provision or skip it. */
  configReachable: boolean;
  /** Set when !configReachable — why, and what the live leg must do. */
  clampNote?: string;
}

/**
 * Resolve one cell into the P-023 patch that realizes it + the doors/thresholds it imposes.
 * PURE. Pins floor=cap=target (the only way to realize a target maxTurn on an arbitrary
 * window), clamped to the config surface's bounds, and reports honestly when the target is
 * unreachable (the 100K point).
 */
export function resolveCellConfig(cell: Pick<SweepCell, 'maxTurnTargetTokens' | 'effectiveWindowTokens' | 'doorSplitVariantId'>, axes: SweepAxes = DEFAULT_SWEEP_AXES): CellConfig {
  const target = cell.maxTurnTargetTokens;
  const variant = axes.doorSplitVariants.find((v) => v.id === cell.doorSplitVariantId);

  // Pin floor=cap=target, clamped to what the config verbs accept (floor ≤ 50K, cap ≤ 100K,
  // both ≥ 1K). An out-of-range target yields the closest appliable patch; achieved reflects
  // reality after the real resolver runs.
  const floorTarget = Math.min(Math.max(target, SESSION_DOOR_FLOOR_MIN), SESSION_DOOR_FLOOR_MAX);
  const capTarget = Math.min(Math.max(target, floorTarget), SESSION_DOOR_CAP_MAX);
  const patch: DoorConstantsPatch = {
    maxTurnFloorTokens: floorTarget,
    maxTurnCapTokens: capTarget,
    ...(variant ? { doorSplit: variant.split } : {}),
  };

  const effectiveConstants = resolveDoorConstants({ defaults: patch }, null);
  const achievedMaxTurnTokens = computeMaxTurn(cell.effectiveWindowTokens, effectiveConstants);
  const configReachable = achievedMaxTurnTokens === target;

  return {
    patch,
    effectiveConstants,
    turnDoors: computeTurnDoors(cell.effectiveWindowTokens, effectiveConstants),
    thresholds: computeCompactionThresholds(cell.effectiveWindowTokens, effectiveConstants),
    achievedMaxTurnTokens,
    configReachable,
    ...(configReachable
      ? {}
      : {
          clampNote:
            `target ${fmtTok(target)} exceeds the P-023 floor bound (${fmtTok(SESSION_DOOR_FLOOR_MAX)}); ` +
            `the override surface can only realize maxTurn=${fmtTok(achievedMaxTurnTokens)} on a ${fmtTok(cell.effectiveWindowTokens)}-token window. ` +
            `The live leg must special-provision this cell (raise the tool bound / direct override write) or skip it.`,
        }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-cell result + metric shapes (P-025 fills + scores these)
// ─────────────────────────────────────────────────────────────────────────────

/** The metrics captured per cell (plan P-025). All nullable: a cell that did not run, or a
 *  metric the driver could not capture, is null (never a fabricated 0). */
export interface CellRunMetrics {
  /** Fraction of hops that stopped with stopReason=length (hit the output door). */
  stopReasonLengthRate: number | null;
  /** Fraction of spilled pointers the agent actually read back (did spill-chase work?). */
  spillChaseSuccessRate: number | null;
  hopsPerTask: number | null;
  cacheReadInputTokens: number | null;
  freshInputTokens: number | null;
  compactionCount: number | null;
  wallClockMs: number | null;
  /** Fraction of task repeats that reached a successful terminal state. */
  taskSuccessRate: number | null;
}

/** Every metric null — the shape a staged / not-yet-run cell carries. */
export function emptyCellMetrics(): CellRunMetrics {
  return {
    stopReasonLengthRate: null,
    spillChaseSuccessRate: null,
    hopsPerTask: null,
    cacheReadInputTokens: null,
    freshInputTokens: null,
    compactionCount: null,
    wallClockMs: null,
    taskSuccessRate: null,
  };
}

export type CellRunStatus =
  | 'ok' // driven, metrics captured
  | 'staged' // not driven (sweep not armed, no driver, or cell config-unreachable + onlyReachable)
  | 'error'; // the driver threw — captured fail-soft, sweep continued

export interface CellResult {
  cellId: string;
  cell: SweepCell;
  config: CellConfig;
  repeats: number;
  status: CellRunStatus;
  metrics: CellRunMetrics;
  /** Set on status 'staged' (why it was skipped) or 'error' (the driver's failure). */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The DEFAULT-OFF live entry point (actuation is an injected, deferred seam)
// ─────────────────────────────────────────────────────────────────────────────

/** The LIVE actuation seam — binds the cell's override, runs its benchmark task on a real
 *  session of the cell's class, and returns the captured metrics. Deferred: absent an armed
 *  driver the sweep only ASSEMBLES + inspects the matrix (nothing spends, nothing drives). */
export type CellDriver = (
  cell: SweepCell,
  config: CellConfig,
  opts: { repeats: number; now: () => number },
) => Promise<CellRunMetrics>;

export interface RunSweepInput {
  axes?: SweepAxes;
  /** Repeats per cell (default 1, clamped ≥ 1). */
  repeats?: number;
  /** The live actuation seam. Absent ⇒ the sweep stays staged. */
  driver?: CellDriver;
  /** DEFAULT-OFF: must be true to drive any cell. A sweep that binds overrides on live
   *  drone/interactive sessions and spends is opt-in, never a default. */
  armed?: boolean;
  /** When armed, skip cells the config surface cannot realize (the 100K point). Default true. */
  onlyReachable?: boolean;
  now?: () => number;
}

export interface SweepRunResult {
  cells: SweepCell[];
  results: CellResult[];
  armed: boolean;
  /** True iff at least one cell was actually driven. */
  ran: boolean;
  skippedReason?: 'not-armed' | 'no-driver';
  /** Cells whose target the config surface can realize exactly. */
  reachableCount: number;
  /** Cell ids the config surface cannot realize (the 100K point) — special-provision or skip. */
  unreachableCells: string[];
}

/**
 * Assemble + (optionally) drive the maxTurn sweep. PURE assembly always runs; the live
 * actuation is gated behind `armed` + an injected `driver` and is FAIL-SOFT — a driver that
 * throws on one cell is captured as that cell's status:'error' and never aborts the sweep.
 * Staged by default: with no armed driver every cell comes back status:'staged' with empty
 * metrics, so the whole matrix (cells + resolved configs + reachability) is inspectable
 * without spending or touching a live session.
 */
export async function runMaxTurnSweep(input: RunSweepInput = {}): Promise<SweepRunResult> {
  const axes = input.axes ?? DEFAULT_SWEEP_AXES;
  const repeats = Math.max(1, Math.floor(input.repeats ?? 1));
  const now = input.now ?? Date.now;
  const onlyReachable = input.onlyReachable ?? true;
  const armed = input.armed === true;

  const cells = expandSweepCells(axes);
  const configs = new Map<string, CellConfig>();
  for (const cell of cells) configs.set(cell.cellId, resolveCellConfig(cell, axes));

  const unreachableCells = cells.filter((c) => !configs.get(c.cellId)!.configReachable).map((c) => c.cellId);
  const reachableCount = cells.length - unreachableCells.length;

  const drivable = armed && typeof input.driver === 'function';
  const skippedReason: SweepRunResult['skippedReason'] = !armed ? 'not-armed' : !drivable ? 'no-driver' : undefined;

  const results: CellResult[] = [];
  let ran = false;

  for (const cell of cells) {
    const config = configs.get(cell.cellId)!;
    const base = { cellId: cell.cellId, cell, config, repeats };

    if (!drivable) {
      results.push({ ...base, status: 'staged', metrics: emptyCellMetrics(), note: skippedReason });
      continue;
    }
    if (onlyReachable && !config.configReachable) {
      results.push({ ...base, status: 'staged', metrics: emptyCellMetrics(), note: config.clampNote ?? 'config-unreachable' });
      continue;
    }
    try {
      const metrics = await input.driver!(cell, config, { repeats, now });
      ran = true;
      results.push({ ...base, status: 'ok', metrics });
    } catch (err) {
      ran = true; // an attempt was made; the sweep stays soft and moves on
      results.push({ ...base, status: 'error', metrics: emptyCellMetrics(), note: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    cells,
    results,
    armed,
    ran,
    ...(skippedReason ? { skippedReason } : {}),
    reachableCount,
    unreachableCells,
  };
}
