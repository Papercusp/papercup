/**
 * terminal-residue-census — the LEADING indicator for dead-terminal-window residue
 * (process-lifecycle-no-orphans-2026-08-02, P-013 / D-017).
 *
 * ── WHY THIS DOES NOT REUSE `summary.unaccounted` ───────────────────────────
 *
 * The obvious implementation of P-013 is "trend the reconciler's unaccounted
 * count". That number is structurally pinned near 0 for this residue class, so a
 * trend over it can never fire. Measured 2026-08-03 02:50Z, at one instant:
 *
 *   • direct cgroup census   → 14 dead-window scopes holding 59 processes
 *   • processes:list {live}  → unaccounted: 0, foreign: 1, degraded: FALSE
 *   • task_ledger            → 0 rows in state 'unaccounted', ever (of 953)
 *
 * The cause is ORDERING, not classification. `classifyScope` already returns
 * `unaccounted` for a dead window (scope-class.ts), but it is never reached:
 * `scan.ts` skips a foreign process on the repo-root signature BEFORE `push()`,
 * and `push()` is the only caller of the window probe. So window-liveness sits
 * DOWNSTREAM of a cmdline filter, and 50 of those 59 processes can never be
 * classified at all. (Filed EI-19398679054297365.)
 *
 * This module therefore censuses SCOPES directly. It reuses the existing probe
 * (`readTerminalAppPids` + `terminalWindowAlive`) unchanged — those read
 * `cgroup.procs` and `/proc/<pid>/stat` only, need no cmdline match, and so are
 * immune to the filter that blinds the scan.
 *
 * ── WHY THE SIGNAL IS THE FLOOR, NOT THE LEVEL ──────────────────────────────
 *
 * D-016 measured the steady state: 14 of 15 dead-window scopes held live agent
 * sessions or shared infra. So an absolute-level alarm is ~93% false-positive and
 * would be muted within a day — the failure this indicator exists to avoid.
 *
 * What actually distinguishes residue from ordinary use is that residue never
 * goes away. Windows open and close all day, which moves the MAXIMUM constantly;
 * only a floor that climbs means scopes are accumulating and never being cleared.
 * So the verdict compares the MINIMUM of a recent window against the MINIMUM of
 * an older one. That is the "16 days of silent accumulation" shape, and it is
 * deliberately insensitive to churn.
 *
 * ── REPORT-ONLY (D-006 / D-010 / D-016) ─────────────────────────────────────
 *
 * Nothing here terminates anything, and nothing here should grow that power
 * without re-deciding D-016. A dead window is NOT proof of abandonment — it is
 * "a window closed but these kept running". Consumers must render it that way.
 *
 * Also binding, from D-015: never key success on a scope's unit `ActiveState` or
 * on a `systemctl stop` exit code. A vte-spawn scope sets `KillMode=process`, so
 * a stop returns rc=0, flips the unit to inactive(dead), and leaves every task
 * running — unit state LAUNDERS this residue.
 */

import { parseCgroupProcs, type CgroupFs } from './cgroup-read';
import { isTerminalWindowScope } from './scope-class';
import { readTerminalAppPids, terminalWindowAlive } from './terminal-window';

/** One scope observed to have no live window. */
export interface DeadWindowScope {
  /** The scope's leaf unit name, e.g. `vte-spawn-<uuid>.scope`. */
  scope: string;
  /** How many processes it still holds. */
  pidCount: number;
}

export interface ResidueCensus {
  /** Terminal window scopes seen at all. */
  scopesTotal: number;
  /** Scopes whose window is positively observed DEAD. */
  scopesDead: number;
  /** Processes held by those dead-window scopes. */
  deadPids: number;
  /**
   * Scopes the probe could not decide (`null`) — an unreadable scope, an empty
   * one, no identifiable terminal application. Reported, never counted as dead:
   * unknown is not dead, exactly as `classifyScope` treats it.
   */
  unprobeable: number;
  /** The dead-window scopes themselves, for a report-only surface. */
  dead: DeadWindowScope[];
}

/**
 * Census the terminal slice. Pure with respect to the injected `fs` — no clock,
 * no subprocess, no writes.
 *
 * `terminalSliceAbs` is the absolute cgroup dir of the terminal application slice
 * (the parent of the `vte-spawn-*.scope` dirs).
 */
export function censusTerminalResidue(terminalSliceAbs: string, fs: CgroupFs): ResidueCensus {
  const appPids = readTerminalAppPids(terminalSliceAbs, fs);

  let scopesTotal = 0;
  let unprobeable = 0;
  const dead: DeadWindowScope[] = [];

  for (const name of fs.readDir(terminalSliceAbs)) {
    if (!isTerminalWindowScope(name)) continue;
    const abs = `${terminalSliceAbs}/${name}`;
    if (!fs.isDir(abs)) continue;
    scopesTotal++;

    const alive = terminalWindowAlive(abs, appPids, fs);
    if (alive === null) {
      unprobeable++;
      continue;
    }
    if (alive) continue;

    const pids = parseCgroupProcs(fs.readFile(`${abs}/cgroup.procs`) ?? '');
    dead.push({ scope: name, pidCount: pids.length });
  }

  return {
    scopesTotal,
    scopesDead: dead.length,
    deadPids: dead.reduce((n, d) => n + d.pidCount, 0),
    unprobeable,
    dead,
  };
}

/** One observation of the dead-window count. */
export interface ResidueSample {
  atMs: number;
  scopesDead: number;
}

export type ResidueTrend = 'rising' | 'steady' | 'falling' | 'unknown';

export interface ResidueTrendVerdict {
  trend: ResidueTrend;
  /** Floor of the recent window minus floor of the older window. */
  floorDelta: number;
  /** The two floors, so a report can show its work rather than assert a verdict. */
  recentFloor: number | null;
  olderFloor: number | null;
  /** True only for a sustained RISING floor — the report-worthy condition. */
  alarm: boolean;
  /** Why, in one line, for the surface that renders this. */
  summary: string;
}

export interface ResidueTrendOptions {
  /** Now, for splitting the samples. */
  nowMs: number;
  /** Samples at or after `nowMs - recentWindowMs` form the recent window. */
  recentWindowMs?: number;
  /** How far back the comparison window reaches. */
  lookbackMs?: number;
  /** Floor rise required to call it rising. */
  minFloorDelta?: number;
  /** Minimum samples in EACH window before a verdict is possible. */
  minSamplesPerWindow?: number;
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MIN_FLOOR_DELTA = 2;
const DEFAULT_MIN_SAMPLES = 3;

/**
 * PURE: is the dead-window population ACCUMULATING?
 *
 * Compares the floor (minimum) of a recent window against the floor of the
 * preceding lookback window. A floor that climbs means scopes are arriving and
 * never leaving; ordinary open/close churn moves the peak, not the floor.
 *
 * Returns `unknown` — never a healthy-looking `steady` — when either window is
 * too thin to support a verdict. A monitor that cannot tell must say so; that is
 * the same rule `terminalWindowAlive` and the reconciler's degraded-scan check
 * already follow, and inventing a reassuring answer here is precisely how a
 * detector launders residue (D-017).
 */
export function evaluateResidueTrend(
  samples: readonly ResidueSample[],
  opts: ResidueTrendOptions,
): ResidueTrendVerdict {
  const recentWindowMs = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const minFloorDelta = opts.minFloorDelta ?? DEFAULT_MIN_FLOOR_DELTA;
  const minSamples = opts.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES;

  const recentFrom = opts.nowMs - recentWindowMs;
  const olderFrom = opts.nowMs - lookbackMs;

  const recent: number[] = [];
  const older: number[] = [];
  for (const s of samples) {
    if (s.atMs >= recentFrom) recent.push(s.scopesDead);
    else if (s.atMs >= olderFrom) older.push(s.scopesDead);
  }

  if (recent.length < minSamples || older.length < minSamples) {
    return {
      trend: 'unknown',
      floorDelta: 0,
      recentFloor: recent.length ? Math.min(...recent) : null,
      olderFloor: older.length ? Math.min(...older) : null,
      alarm: false,
      summary:
        `not enough history to judge accumulation (recent=${recent.length}, older=${older.length}, ` +
        `need ${minSamples} in each) — no verdict, which is not the same as healthy`,
    };
  }

  const recentFloor = Math.min(...recent);
  const olderFloor = Math.min(...older);
  const floorDelta = recentFloor - olderFloor;

  if (floorDelta >= minFloorDelta) {
    return {
      trend: 'rising',
      floorDelta,
      recentFloor,
      olderFloor,
      alarm: true,
      summary:
        `dead-window scopes are ACCUMULATING: the floor rose ${olderFloor} → ${recentFloor} ` +
        `(+${floorDelta}). A window closed but these kept running, and nothing is clearing them. ` +
        `Report-only (D-016) — do NOT reap on this signal; most such scopes hold live tenants.`,
    };
  }
  if (floorDelta <= -minFloorDelta) {
    return {
      trend: 'falling',
      floorDelta,
      recentFloor,
      olderFloor,
      alarm: false,
      summary: `dead-window scope floor fell ${olderFloor} → ${recentFloor} (${floorDelta}) — residue is clearing`,
    };
  }
  return {
    trend: 'steady',
    floorDelta,
    recentFloor,
    olderFloor,
    alarm: false,
    summary: `dead-window scope floor steady at ~${recentFloor} (was ${olderFloor}) — no accumulation`,
  };
}
