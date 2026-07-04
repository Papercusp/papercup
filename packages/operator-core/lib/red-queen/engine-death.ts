/**
 * engine-death.ts — the routine-engine-death drill class + the OUT-OF-BAND
 * live sentinel (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * Modeled on the 2026-06-12 DBOS incident (insight:
 * esm-dirname-tsx-file-mode-dbos-stall): a swallowed boot error left the
 * routines engine dead while `:3070` answered /api/health — git-sync, the
 * monitors, AND the deploy train all silently stopped. The incident signature
 * (per the insight's diagnosis runbook): EVERY active routine's next_fire_at
 * sits in the past at once. One stale row = that routine's problem; all of
 * them = the engine is dead.
 *
 * The watchdog cannot see this class — its tick rides the same engine
 * (system:improvement-watchdog is a routine; service-health is a DBOS periodic
 * workflow). So detection here is OUT-OF-BAND twice over:
 *
 *   - the DRILL leg feeds the pure detector a synthetic routines snapshot
 *     (planted as drill payload, never as live `harness_shared.routines` rows —
 *     the engine's listDueCronRoutines() spans every workspace, so a planted
 *     active row would be FIRED by the live engine, not ignored);
 *   - the LIVE sentinel is a plain setInterval armed in host-bootstrap right
 *     after the swallowed `[dbos] boot failed` catch — it deliberately does NOT
 *     ride DBOS, the routines engine, or background-worker workflows, so it
 *     survives exactly the failure it watches for. Flag-gated per D-001
 *     (checked every pass, so a P-001 flag flip arms it without a restart).
 */

import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { WatchdogCollector, WatchdogSignal } from '../harness/improvements/watchdog';
import { captureImprovement } from '../harness/improvements/capture-core';
import { SANDBOX_SCOPE, SANDBOX_WORKSPACE_ID } from './types';

/** The slice of a routines row the detector needs. */
export interface RoutineLivenessRow {
  name: string;
  active: boolean;
  nextFireAt: string | Date | null;
}

export interface EngineDeathOptions {
  /** How far past next_fire_at a routine must be before it counts overdue (min). */
  graceMinutes?: number;
  /** Active routines required before "all overdue" means engine death (not a quiet box). */
  minActiveRoutines?: number;
}

export const ENGINE_DEATH_DEFAULTS = { graceMinutes: 10, minActiveRoutines: 3 } as const;

export interface EngineDeathVerdict {
  dead: boolean;
  activeCount: number;
  overdueCount: number;
  /** Minutes the most-overdue routine has been waiting (0 when none). */
  oldestOverdueMinutes: number;
  reason: string;
}

/**
 * Pure: the 06-12 incident signature. Dead ⟺ there are ≥ minActiveRoutines
 * active routines AND every one of them is overdue past the grace window.
 * A single overdue routine (others healthy) is that routine's own problem —
 * the in-band routine-failure collector's territory, not engine death.
 */
export function detectRoutineEngineDeath(
  rows: RoutineLivenessRow[],
  nowMs: number,
  opts: EngineDeathOptions = {},
): EngineDeathVerdict {
  const grace = (opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes) * 60_000;
  const minActive = opts.minActiveRoutines ?? ENGINE_DEATH_DEFAULTS.minActiveRoutines;
  const active = rows.filter((r) => r.active);
  let overdue = 0;
  let oldestMs = 0;
  for (const r of active) {
    const at = r.nextFireAt instanceof Date ? r.nextFireAt.getTime() : r.nextFireAt ? Date.parse(String(r.nextFireAt)) : NaN;
    // An active routine with no/unparseable next_fire_at can't prove liveness
    // either way — count it neither overdue nor healthy.
    if (!Number.isFinite(at)) continue;
    const lateBy = nowMs - at;
    if (lateBy > grace) {
      overdue += 1;
      if (lateBy > oldestMs) oldestMs = lateBy;
    } else {
      // One routine inside its window = the engine fired (or will) — alive.
      return {
        dead: false,
        activeCount: active.length,
        overdueCount: overdue,
        oldestOverdueMinutes: Math.round(oldestMs / 60_000),
        reason: `routine "${r.name}" is inside its fire window — engine alive`,
      };
    }
  }
  if (active.length < minActive || overdue < minActive) {
    return {
      dead: false,
      activeCount: active.length,
      overdueCount: overdue,
      oldestOverdueMinutes: Math.round(oldestMs / 60_000),
      reason: `${active.length} active routine(s) (< ${minActive}) — too few to distinguish engine death from a quiet box`,
    };
  }
  return {
    dead: true,
    activeCount: active.length,
    overdueCount: overdue,
    oldestOverdueMinutes: Math.round(oldestMs / 60_000),
    reason: `ALL ${overdue} active routines overdue past ${opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes}min — the 06-12 incident signature`,
  };
}

/** Pure: a dead-engine verdict → the watchdog signal (shared by drill + sentinel). */
export function engineDeathSignal(
  verdict: EngineDeathVerdict,
  scope: { key: string; origin?: 'drill'; captureScope?: string },
): WatchdogSignal {
  return {
    source: 'routine-engine-death',
    key: scope.key,
    title: 'The routines engine is dead — every active routine is overdue',
    body:
      `Watchdog signal (routine-engine-death, detected OUT-OF-BAND): ${verdict.overdueCount}/${verdict.activeCount} ` +
      `active routines are overdue (oldest ~${verdict.oldestOverdueMinutes}min) — ${verdict.reason}.\n\n` +
      `This is the 2026-06-12 DBOS incident class: a dead engine means no git-sync sweeps, no monitors, and no ` +
      `auto-deploys (the deploy train cannot carry its own fix). Runbook: ` +
      `agent-insights/esm-dirname-tsx-file-mode-dbos-stall — check the journal for '[dbos] boot failed', ` +
      `then the manual recovery chain.`,
    severity: 'critical',
    kind: 'bug',
    paths: ['packages/operator-core/lib/dbos/routines-workflow.ts', 'apps/operator/bin/host-bootstrap.ts'],
    ...(scope.origin ? { origin: scope.origin } : {}),
    ...(scope.captureScope ? { scope: scope.captureScope } : {}),
  };
}

/**
 * The drill leg's sandbox collector: runs the REAL detector over the planted
 * synthetic snapshot (drill payload), emitting an origin='drill' signal scoped
 * to the sandbox. The snapshot — not live rows — is deliberate: planting
 * active rows in harness_shared.routines would be FIRED by the live engine.
 */
export function engineDeathDrillCollector(snapshot: RoutineLivenessRow[], nowMs?: number): WatchdogCollector {
  return {
    name: 'red-queen-routine-engine-death',
    collect: async () => {
      const verdict = detectRoutineEngineDeath(snapshot, nowMs ?? Date.now());
      if (!verdict.dead) return { signals: [], note: verdict.reason };
      return [
        engineDeathSignal(verdict, {
          key: `engine:${SANDBOX_WORKSPACE_ID}`,
          origin: 'drill',
          captureScope: SANDBOX_SCOPE,
        }),
      ];
    },
  };
}

/** Read the live routine-liveness slice (read-only; safe out-of-band). */
export async function readRoutineLivenessRows(sql: Sql): Promise<RoutineLivenessRow[]> {
  const rows = await sql<{ name: string; active: boolean; next_fire_at: string | Date | null }[]>`
    SELECT name, active, next_fire_at
      FROM harness_shared.routines
     WHERE active = true
     LIMIT 500`;
  return rows.map((r) => ({ name: r.name, active: r.active, nextFireAt: r.next_fire_at }));
}

/** Injectable seam for the sentinel (tests run without PG/flags). */
export interface EngineDeathSentinelDeps {
  isArmed: () => Promise<boolean>;
  readRows: () => Promise<RoutineLivenessRow[]>;
  capture: typeof captureImprovement;
  log: (msg: string) => void;
}

/**
 * One sentinel pass: read live routine liveness, detect, and — only on a dead
 * verdict — file ONE organic capture (this is a REAL outage signal, not a
 * drill; dedupScope 'open' keeps it to one open item per outage). Never
 * throws; flag-dark passes do zero PG reads.
 */
export async function runEngineDeathSentinelPass(
  deps: EngineDeathSentinelDeps,
  opts: EngineDeathOptions = {},
  nowMs?: number,
): Promise<{ checked: boolean; verdict?: EngineDeathVerdict; captured?: boolean }> {
  try {
    if (!(await deps.isArmed())) return { checked: false };
    const rows = await deps.readRows();
    const verdict = detectRoutineEngineDeath(rows, nowMs ?? Date.now(), opts);
    if (!verdict.dead) return { checked: true, verdict };
    const signal = engineDeathSignal(verdict, { key: 'engine:live' });
    const res = await deps.capture({
      title: signal.title,
      kind: 'bug',
      body: signal.body,
      severity: signal.severity,
      paths: signal.paths,
      scope: 'operator',
      foundDuring: 'red-queen-engine-death-sentinel',
      createdBy: 'system:red-queen-sentinel',
      sourceRole: 'system',
      source: 'su',
      dedupScope: 'open',
      watchdogKey: `routine-engine-death:${signal.key}`,
      // The live sentinel is an availability monitor — a dead engine is an
      // ORGANIC signal (no origin override), unlike the sandbox drill leg.
    });
    deps.log(`ENGINE DEATH detected (${verdict.reason}) — capture ${res.created ? `filed ${res.issue?.id}` : `declined (${res.reason})`}`);
    return { checked: true, verdict, captured: res.created };
  } catch (e) {
    deps.log(`sentinel pass failed (next interval retries): ${e instanceof Error ? e.message : e}`);
    return { checked: false };
  }
}

/** Default sentinel cadence — frequent enough to beat the 30s tick's users noticing. */
export const ENGINE_DEATH_SENTINEL_INTERVAL_MS = 5 * 60_000;

let sentinelTimer: ManagedHandle | null = null;

/**
 * Arm the out-of-band sentinel: a managedSetInterval (out-of-band — never DBOS,
 * never the routines engine; it must survive exactly the failure it watches for,
 * so it registers for VISIBILITY but stays bespoke per D-005).
 * Call once from host-bootstrap AFTER the dbos start block. The
 * `papercusp-red-queen` flag is checked inside every pass, so the sentinel is
 * inert while dark and a P-001 flag flip arms it without a restart.
 */
export function armEngineDeathSentinel(intervalMs: number = ENGINE_DEATH_SENTINEL_INTERVAL_MS): void {
  if (sentinelTimer) return;
  const deps: EngineDeathSentinelDeps = {
    isArmed: async () => {
      const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
      return getFlag(FLAGS.RED_QUEEN, 'red-queen-sentinel');
    },
    readRows: async () => readRoutineLivenessRows((await import('@papercusp/db-org')).getOrgPg().sql),
    capture: captureImprovement,
    log: (m) => console.log(`[red-queen-sentinel] ${m}`),
  };
  sentinelTimer = managedSetInterval(
    'red-queen-engine-death',
    intervalMs,
    // managedSetInterval's callback is `() => void | Promise<void>` — runEngineDeathSentinelPass()
    // resolves a richer { checked, verdict?, captured? } shape. `.then(() => {})` (no rejection
    // handler) collapses the RESOLVED type to void while still PROPAGATING a rejection, so
    // managedSetInterval's own tick tracking (rec.entry.lastError) keeps seeing sentinel
    // failures — swallowing the rejection here (a bare `.catch`) would silently blind that
    // tracking, which is exactly the failure class this sentinel exists to catch.
    () => runEngineDeathSentinelPass(deps).then(() => {}),
    { category: 'watchdog' },
  );
}

/** Disarm (tests). */
export function disarmEngineDeathSentinel(): void {
  if (sentinelTimer) sentinelTimer.stop();
  sentinelTimer = null;
}
