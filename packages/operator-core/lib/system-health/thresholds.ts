/**
 * system-health/thresholds — the green/yellow/red status model, in ONE place
 * (system-health-tab-2026-06-15 P-001 / Phase 4, D-003).
 *
 * Pure functions: each takes a panel's data (+ `now`) and returns a PanelStatus.
 * No IO — so the boundaries (Queen stalled > 30m = crit, opus paused = crit,
 * dead routine = crit, sync-lag > 45m = warn, escalation aging > 6h = warn, …)
 * are unit-tested without a database. `computeSystemHealth` calls these; the
 * collectors never decide their own colour. A panel whose collector threw is
 * 'unknown' (greyed) — set by compute.ts, not here.
 */
import type {
  PanelStatus,
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  ImprovementsHealth,
  InfraHealth,
} from './types';

// ── tunable thresholds (the status boundaries) ───────────────────────────────

/** Queen stall: started + quiet this long (+ demand, not mid-turn) = crit. The
 *  failure mode the tab exists for (the watchdog's own fallback default is 30m). */
export const QUEEN_STALL_MS = 30 * 60_000;
/** Frequent watchdog fallback fires (a forgot-to-declare prompt bug) = warn. */
export const WATCHDOG_FIRES_WARN = 3;
/** Git-sync lag: no new staging commit in this long = warn (the firehose stalled). */
export const SYNC_LAG_WARN_MS = 45 * 60_000;
/** Live :3070 this many commits behind staging = warn (deploy pipeline stuck). */
export const DEPLOY_BEHIND_WARN = 80;
/** Open escalation older than this = warn (aging). */
export const ESCALATION_AGING_MS = 6 * 60 * 60_000;

// ── per-panel status deciders ────────────────────────────────────────────────

/**
 * Queen. crit = STALLED (the origin failure mode). warn = paused (idle by
 * choice), or started-but-no-wake-armed with demand queued, or watchdog firing
 * repeatedly. ok = looping with cadence.
 */
export function queenStatus(d: QueenHealth): PanelStatus {
  if (d.stalled) return 'crit';
  if (!d.started) return 'warn'; // paused — nothing is running
  if (!d.armed && !d.midTurn && (d.demand.todoItems > 0 || d.demand.startedPlans > 0)) return 'warn';
  if (d.watchdogFires24h >= WATCHDOG_FIRES_WARN) return 'warn';
  return 'ok';
}

/** Bees. crit = a cursed placement (failed past the breaker, escalated). warn =
 *  orphaned claims / stranded / recovering placements. ok otherwise. */
export function beesStatus(d: BeesHealth): PanelStatus {
  if (d.placements.cursed > 0) return 'crit';
  if (d.orphanedClaims > 0 || d.placements.stranded > 0 || d.placements.recovering > 0) return 'warn';
  return 'ok';
}

/** Work items. warn = a needs-human queue exists. (Backlog depth is not a health
 *  failure on its own — that's the work-feed / plans story.) */
export function workItemsStatus(d: WorkItemsHealth): PanelStatus {
  if (d.needsHuman > 0) return 'warn';
  return 'ok';
}

/** Work-feed. crit = a dead routine (EI-584 — a stalled routine starves the
 *  whole feed). Otherwise ok (frontier depth alone is not unhealthy). */
export function workFeedStatus(d: WorkFeedHealth): PanelStatus {
  if (d.deadRoutines > 0) return 'crit';
  return 'ok';
}

/**
 * Tokens / gateway. crit = full starvation (no account available) or the gateway
 * is in the egress path but unreachable. warn = a paused bucket (RPM-pacing) or a
 * paused account. ok otherwise.
 */
export function tokensStatus(d: TokensHealth): PanelStatus {
  if (d.accountsTotal > 0 && d.accountsAvailable === 0) return 'crit';
  if (d.gatewayEnabled && d.gatewayReachable === false) return 'crit';
  if (d.pausedBuckets > 0 || d.accountsPaused > 0) return 'warn';
  return 'ok';
}

/** Watchdog. warn = firing repeatedly (a prompt bug to fix); the watchdog firing
 *  at all is the safety net working, not a system failure — so never crit. */
export function watchdogStatus(d: WatchdogHealth): PanelStatus {
  if (d.fires24h >= WATCHDOG_FIRES_WARN) return 'warn';
  return 'ok';
}

/**
 * Deploy. unknown = no refs resolved (a box without the release checkout). warn =
 * git-sync lag (no recent staging commit) or the live host far behind staging.
 * ok otherwise. Not crit — a stale deploy degrades, it doesn't break the system.
 */
export function deployStatus(d: DeployHealth, now: number): PanelStatus {
  if (d.deployedShortSha === null && d.lastCommitAtMs === null) return 'unknown';
  if (d.lastCommitAtMs !== null && now - d.lastCommitAtMs > SYNC_LAG_WARN_MS) return 'warn';
  if (d.deployedBehindMain !== null && d.deployedBehindMain > DEPLOY_BEHIND_WARN) return 'warn';
  return 'ok';
}

/** Plans. warn = a started plan has gone stale (no op update in the aging window). */
export function plansStatus(d: PlansHealth): PanelStatus {
  if (d.stalledPlans > 0) return 'warn';
  return 'ok';
}

/** Escalations. warn = an open blocker, or any open escalation aging past the
 *  threshold (needs a human — but the system itself isn't broken, so not crit). */
export function escalationsStatus(d: EscalationsHealth): PanelStatus {
  if (d.aging > 0 || (d.bySeverity.blocker ?? 0) > 0) return 'warn';
  return 'ok';
}

/** Autonomy. warn = a tripped tripwire (a guard fired — may auto-revert, worth a
 *  glance). Locked categories are intentional config, not a failure. */
export function autonomyStatus(d: AutonomyHealth): PanelStatus {
  if (d.tripwiresTripped > 0) return 'warn';
  return 'ok';
}

/** Improvements. Informational — a backlog is not a health failure. ok. */
export function improvementsStatus(_d: ImprovementsHealth): PanelStatus {
  return 'ok';
}

/** Infra. unknown = PG unreadable. crit = the gateway is enabled but unreachable
 *  (the spine is down). ok otherwise. */
export function infraStatus(d: InfraHealth): PanelStatus {
  if (d.pg === null) return 'unknown';
  if (d.gatewayReachable === false) return 'crit';
  return 'ok';
}

// ── overall roll-up ──────────────────────────────────────────────────────────

/**
 * The system's overall light = the worst NON-`unknown` panel (D-003 / fail-soft):
 * a greyed (unreadable) panel never reds the whole system. Only when EVERY panel
 * is unknown does the overall go unknown.
 */
export function worstStatus(statuses: readonly PanelStatus[]): PanelStatus {
  if (statuses.some((s) => s === 'crit')) return 'crit';
  if (statuses.some((s) => s === 'warn')) return 'warn';
  if (statuses.some((s) => s === 'ok')) return 'ok';
  return 'unknown';
}
