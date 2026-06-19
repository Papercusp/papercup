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
  OverwatchPanelHealth,
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

/**
 * queenAlive — the who-watches-the-watcher LIVENESS signal (D-004), deliberately
 * DISTINCT from the `stalled` panel state so the overwatch's queen-stalled
 * detector isn't dead code (EI-623). DARK (false) ONLY when the loop is genuinely
 * gone: started AND no next wake armed AND stalled. A started-but-ARMED Queen is
 * alive even when stalled (the wake will fire / the watchdog re-arms — `armed`
 * absorbs a normal stall, so `stalled` flows to its OWN detector, not queen-dark).
 * A paused Queen (not started) is intentionally off → alive, never a false dark.
 * An unreadable queen (null) is conservatively alive (favour not-alarming, D-002).
 *
 * ONE definition, shared by the SystemHealth model (compute.ts) and the overwatch
 * brief mapper (overwatch/compute-brief.ts) so the two can never drift apart again
 * — the duplicated copies that DID drift were the EI-623 root cause.
 */
export function deriveQueenAlive(queen: QueenHealth | null): boolean {
  if (!queen) return true; // unreadable ⇒ conservatively alive (never a false dark)
  if (!queen.started) return true; // paused ⇒ intentional, alive
  return queen.armed || !queen.stalled; // started ⇒ dark only when unarmed AND stalled
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
  // P-009: a recorded-but-aged-out reaper is WEDGED — the most severe work-queue
  // failure (stuck items accumulate silently). A null age = never recorded (fresh
  // boot / unknown) → warn, not crit, to avoid alarming on the ~1 boot interval
  // before the first sweep stamps its heartbeat.
  if (d.reaperStale && d.reaperAgeSec != null) return 'crit';
  // P-008: any genuinely stuck row, a dead-held claim backlog, or a dead-assigned issue.
  if ((d.stuckFeatures ?? 0) > 0 || (d.deadHeldClaims ?? 0) > 0 || (d.deadAssignedIssues ?? 0) > 0) return 'warn';
  if (d.reaperStale) return 'warn';
  if (d.needsHuman > 0) return 'warn';
  return 'ok';
}

/** Work-feed. crit = a dead routine (EI-584 — a stalled routine starves the whole
 *  feed). warn = auto-eligible work stuck at attempts:0 while routines are alive
 *  (ready work not flowing — mirrors the overwatch's work-feed-stuck nudge). ok
 *  otherwise (frontier depth alone is not unhealthy). */
export function workFeedStatus(d: WorkFeedHealth): PanelStatus {
  if (d.deadRoutines > 0) return 'crit';
  if (d.autoEligibleStuck > 0) return 'warn';
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

/** Consecutive failed git-sync ticks that red the deploy panel — mirrors
 *  PUSH_FAILURE_ESCALATION_TICKS in git-sync-escalation.ts (EI-18: ~30 min of the
 *  push not reaching origin). Kept as a sibling constant so the standing health
 *  signal and the escalation fire on the same threshold. */
export const GIT_SYNC_PUSH_FAIL_CRIT = 3;

/**
 * Deploy. crit = git-sync push FAILING (>= GIT_SYNC_PUSH_FAIL_CRIT consecutive ticks:
 * local commits are NOT reaching origin — the EI-18 silent-failure class, the one
 * deploy condition severe enough to red the system; the ref-based checks below are
 * blind to it because new local commits keep `lastCommitAtMs` fresh). unknown = no
 * refs resolved (a box without the release checkout). warn = git-sync erroring or
 * excluding oversized blobs, git-sync lag (no recent staging commit), or the live
 * host far behind staging. ok otherwise.
 */
export function deployStatus(d: DeployHealth, now: number): PanelStatus {
  if (d.gitSyncConsecutiveErrorTicks >= GIT_SYNC_PUSH_FAIL_CRIT) return 'crit';
  if (d.deployedShortSha === null && d.lastCommitAtMs === null) return 'unknown';
  if (d.gitSyncStatus === 'error' || d.gitSyncOversizedCount > 0) return 'warn';
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

/** Infra. crit = a per-thread perf WEDGE (operator unreachable / event-loop-lag /
 *  CLOSE_WAIT storm — F1/P-030) or the gateway is enabled but unreachable (the spine
 *  is down). unknown = PG unreadable. warn = a per-thread perf warn (hot worker / RSS
 *  / gateway flap). ok otherwise. A null/stale perf verdict contributes nothing. */
export function infraStatus(d: InfraHealth): PanelStatus {
  if (d.perf?.status === 'crit') return 'crit';
  if (d.pg === null) return 'unknown';
  if (d.gatewayReachable === false) return 'crit';
  if (d.perf?.status === 'warn') return 'warn';
  return 'ok';
}

/**
 * Overwatch (#15) — the autonomous supervisor's OWN loop health (the
 * who-watches-the-watcher panel, D-004). The role ships default-OFF until proven
 * (D-009), so flag-off — and an owner-paused proven loop — are the INTENDED-dark
 * states, greyed (`unknown`), never a red/yellow alarm (and `unknown` never reds
 * the overall, so a not-yet-activated overwatch can't make the dashboard look
 * sick). Once live (flag on + started): crit = DARK (the supervisor loop itself
 * died — B-09 liveness false, the failure D-004 exists to catch); warn = repeated
 * watchdog fallback fires (a forgot-to-declare-next-wake bug); ok = looping.
 */
export function overwatchStatus(d: OverwatchPanelHealth): PanelStatus {
  if (!d.flagEnabled) return 'unknown'; // intentionally dark (default-off, D-009)
  if (!d.started) return 'unknown'; // proven-but-paused by the owner — idle by choice
  if (d.alive === false) return 'crit'; // started + dark = the supervisor itself died (D-004)
  if (d.watchdogFires24h >= WATCHDOG_FIRES_WARN) return 'warn';
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
