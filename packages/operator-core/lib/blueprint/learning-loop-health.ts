/**
 * learning-loop-health.ts — pure health classifier for the self-learning loop
 * routines (relight-self-learning-edges-2026-06-14 P-030).
 *
 * The recurring self-learning failure class is a loop that was BUILT but is
 * silently DARK — seeded inactive behind a default-OFF flag and never armed
 * (calibration's maturation sweep, scout's lens weights, the autonomy scan), or
 * an always-on loop that wedged and stopped firing (the gym D-007 / implement-
 * lane class). Nothing surfaced it, so it rotted unseen. This classifier turns
 * the routine state of the workspace-singleton learning loops into a per-loop
 * verdict so a "dark loop" is VISIBLE on a health read.
 *
 * Pure — the PG glue (read routines, call this) lives in the
 * `improvements:learning_loops` tool. The loop list is passed in and the
 * always-on set is defined here so the core is import-cheap + exhaustively
 * unit-testable (no DB, no Date.now()).
 */

/** The reserved host slug the workspace-singleton cadence rows live under. */
export const SINGLETON_HOST_SLUG = '@singleton';

/**
 * The 3 ALWAYS-ON learning loops (they declare `singletonActive: true`, so a
 * fresh workspace seeds them live). Dark here is a PROBLEM, not by-design. Source
 * of truth: LEARNING_SINGLETONS in seed-learning-singletons.ts (the always-on tail).
 */
export const ALWAYS_ON_LEARNING_LOOPS = new Set<string>(['change-ledger', 'scout', 'iq-battery']);

/** An active loop that has not fired within this many days is "stale" (a wedge). */
export const DEFAULT_LOOP_STALE_AFTER_DAYS = 3;

const DAY_MS = 86_400_000;

/** A routine row, narrowed to what the classifier reads. */
export interface LearningRoutineRow {
  installSlug: string;
  name: string;
  active: boolean;
  /** ISO timestamp of the last fire, or null if it never fired. */
  lastFiredAt: string | null;
}

/** A learning loop's identity: its blueprint id + the legacy `papercup`-slug routine name. */
export interface LearningLoopSpec {
  blueprintId: string;
  legacyRoutine: string;
}

export type LearningLoopStatus =
  | 'firing' // active + fired within the stale window
  | 'stale' // active but has not fired in > the stale window (a wedge — investigate)
  | 'dark-by-design' // a frontier loop, inactive (expected until the owner arms it)
  | 'should-be-on-but-dark' // an ALWAYS-ON loop that is inactive (a real gap)
  | 'absent'; // no routine row seeded for this loop at all

export interface LearningLoopHealth {
  blueprintId: string;
  alwaysOn: boolean;
  /** The matched @singleton routine row (the canonical home), if present. */
  singletonRow: LearningRoutineRow | null;
  /** The legacy papercup-slug row, if still present. */
  legacyRow: LearningRoutineRow | null;
  /** BOTH a @singleton and a legacy row exist — the migration double-state (D-023). */
  collision: boolean;
  active: boolean;
  lastFiredAt: string | null;
  daysSinceFire: number | null;
  status: LearningLoopStatus;
}

/** The workspace-singleton cadence routine name a blueprint materializes. */
export function singletonRoutineName(blueprintId: string): string {
  return `bp-singleton-${blueprintId}-0`;
}

/**
 * Classify each learning loop's routine health. A loop's routine may live at the
 * canonical `@singleton/bp-singleton-<id>-0` row OR (pre-migration) the legacy
 * `papercup/<legacyRoutine>` row; the @singleton row wins when both exist, and
 * BOTH existing is flagged as a `collision` (the exact double-state the migration
 * collision guards prevent).
 */
export function computeLearningLoopHealth(
  loops: readonly LearningLoopSpec[],
  routines: readonly LearningRoutineRow[],
  opts: {
    nowMs: number;
    staleAfterDays?: number;
    singletonHostSlug?: string;
    alwaysOn?: ReadonlySet<string>;
  },
): LearningLoopHealth[] {
  const staleMs = (opts.staleAfterDays ?? DEFAULT_LOOP_STALE_AFTER_DAYS) * DAY_MS;
  const singletonHost = opts.singletonHostSlug ?? SINGLETON_HOST_SLUG;
  const alwaysOnSet = opts.alwaysOn ?? ALWAYS_ON_LEARNING_LOOPS;
  return loops.map((loop) => {
    const sName = singletonRoutineName(loop.blueprintId);
    const singletonRow = routines.find((r) => r.installSlug === singletonHost && r.name === sName) ?? null;
    const legacyRow = routines.find((r) => r.installSlug === 'papercup' && r.name === loop.legacyRoutine) ?? null;
    const row = singletonRow ?? legacyRow;
    const alwaysOn = alwaysOnSet.has(loop.blueprintId);
    const active = row?.active ?? false;
    const lastFiredAt = row?.lastFiredAt ?? null;
    const firedMs = lastFiredAt ? Date.parse(lastFiredAt) : NaN;
    const daysSinceFire = Number.isNaN(firedMs) ? null : Math.floor((opts.nowMs - firedMs) / DAY_MS);

    let status: LearningLoopStatus;
    if (!row) status = 'absent';
    else if (!active) status = alwaysOn ? 'should-be-on-but-dark' : 'dark-by-design';
    else if (Number.isNaN(firedMs) || opts.nowMs - firedMs > staleMs) status = 'stale';
    else status = 'firing';

    return {
      blueprintId: loop.blueprintId,
      alwaysOn,
      singletonRow,
      legacyRow,
      collision: singletonRow !== null && legacyRow !== null,
      active,
      lastFiredAt,
      daysSinceFire,
      status,
    };
  });
}

/** A rollup for the tool summary + the "needs attention" partition. */
export interface LearningLoopHealthSummary {
  total: number;
  firing: number;
  stale: number;
  darkByDesign: number;
  shouldBeOnButDark: number;
  absent: number;
  collisions: number;
  /** Loops that warrant a look: always-on-but-dark, stale, absent-when-always-on, or a collision. */
  needsAttention: string[];
}

export function summarizeLearningLoopHealth(rows: readonly LearningLoopHealth[]): LearningLoopHealthSummary {
  const needsAttention = rows
    .filter(
      (r) =>
        r.status === 'should-be-on-but-dark' ||
        r.status === 'stale' ||
        (r.status === 'absent' && r.alwaysOn) ||
        r.collision,
    )
    .map((r) => r.blueprintId);
  return {
    total: rows.length,
    firing: rows.filter((r) => r.status === 'firing').length,
    stale: rows.filter((r) => r.status === 'stale').length,
    darkByDesign: rows.filter((r) => r.status === 'dark-by-design').length,
    shouldBeOnButDark: rows.filter((r) => r.status === 'should-be-on-but-dark').length,
    absent: rows.filter((r) => r.status === 'absent').length,
    collisions: rows.filter((r) => r.collision).length,
    needsAttention,
  };
}
