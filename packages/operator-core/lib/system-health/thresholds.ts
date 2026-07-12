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
  LoopsHealth,
  CoordinationHealth,
  MemoryPanelHealth,
  PanelAck,
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
/** Disk used% thresholds (health-tab-v2 P-011 — mirrors the fedplane disk script). */
export const DISK_USED_WARN_PCT = 90;
export const DISK_USED_CRIT_PCT = 95;
/** No successful backup snapshot in this long = warn (P-011). */
export const BACKUP_STALE_MS = 48 * 60 * 60_000;
/** An unanswered DIRECTED message older than this warns the Coordination panel
 *  (P-009 — "your minutes are a blocked peer's hours"). */
export const UNANSWERED_DIRECTED_WARN_MS = 30 * 60_000;

/** WI-3565: idle healthy accounts strictly above this count, ALONGSIDE a confirmed
 *  `admissionStarved`, is what makes the starvation a crit (real spare capacity sitting unused
 *  behind an under-recovered admission ceiling) rather than routine full-pool pressure. */
export const ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN = 2;

// ── per-panel status deciders ────────────────────────────────────────────────

/**
 * Queen. crit = STALLED (the origin failure mode) OR paused WITH demand queued (a
 * silent outage — autonomous-loop-canary-reliability P-003: the started-only
 * watchdog seams skip a paused hive, so nothing recovered the multi-day canary
 * stall and this panel only yellowed). warn = paused with nothing queued (idle by
 * choice), started-but-no-wake-armed with demand, or watchdog firing repeatedly.
 * ok = looping with cadence.
 */
export function queenStatus(d: QueenHealth): PanelStatus {
  if (d.stalled) return 'crit';
  // P-003: paused + demand = a silent outage → red it (was a benign yellow);
  // paused + nothing queued stays warn (intentionally idle).
  if (!d.started) {
    return d.demand.todoItems > 0 || d.demand.startedPlans > 0 ? 'crit' : 'warn';
  }
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

/**
 * PURE: count the most-recent CONSECUTIVE Queen wakes that ran ZERO LLM tokens.
 * Samples are newest-first (as queenWakeEfficiency returns them). A 0-token wake =
 * the agent process launched but the LLM never executed (infra / rate-limit loss) —
 * DISTINCT from a healthy short wake, which still spends tokens deciding "nothing to
 * do". (hive-loop-supervision 2026-06-21 — D-009: the Queen's 0-token-no-op outage.)
 */
export function countLeadingZeroTokenWakes(
  samples: ReadonlyArray<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>,
): number {
  let n = 0;
  for (const s of samples) {
    const tokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    if (tokens === 0) n += 1;
    else break;
  }
  return n;
}

/**
 * PURE: is the Queen alive-but-not-placing-despite-placeable-work? (hive-loop-supervision
 * 2026-06-21, sibling of overwatchScorecardSkipped). True when her last ≥minConsecutive
 * wakes ran 0 LLM tokens (the LLM never executed — see countLeadingZeroTokenWakes) WHILE a
 * placeable frontier waits and placement is not paused. This catches the silent stall the
 * cadence-based `queen-stalled` signal MISSES: the Queen wakes ON cadence (looks healthy) but
 * her wakes are empty, so nothing is placed. A known bee-cap fullness suppresses it (a full
 * fleet, not a stall). Default threshold 3 (≈1.5h at a 30-min cadence) avoids a one-off blip.
 */
export function queenPlacementStalled(args: {
  consecutiveZeroTokenWakes: number;
  frontier: number;
  /** Of `frontier`, how many are long-unplaced/gated (WI-3597) — subtracted so a
   *  frontier that is ALL stuck reads as correct idle, not a placement stall.
   *  Absent/0 ⇒ every frontier item counts as fresh (prior behaviour). */
  frontierStuck?: number;
  paused: boolean;
  beesBusy?: number;
  beesCap?: number;
  minConsecutive?: number;
}): boolean {
  if (args.paused) return false;
  // Only FRESH frontier — unblocked AND not aged past the stuck window — is
  // placeable work the Queen is expected to act on. When every ready item has
  // been waiting for hours while she turns on cadence, the frontier is gated on
  // something she can't resolve (owner decision / live rig / fixture): correct
  // idle, not a stall (WI-3597, the false "queen-workitem-selection broken" grade).
  const fresh = args.frontier - (args.frontierStuck ?? 0);
  if (fresh <= 0) return false; // no FRESH placeable work → not a stall
  if (
    typeof args.beesCap === 'number' && args.beesCap > 0 &&
    typeof args.beesBusy === 'number' && args.beesBusy >= args.beesCap
  ) {
    return false; // fleet is full — the lack of new placements isn't the bug
  }
  return args.consecutiveZeroTokenWakes >= (args.minConsecutive ?? 3);
}

/** Bees. crit = a cursed placement (failed past the breaker, escalated). warn =
 *  orphaned claims / stranded / recovering placements. ok otherwise. */
export function beesStatus(d: BeesHealth): PanelStatus {
  if (d.placements.cursed > 0) return 'crit';
  if (d.orphanedClaims > 0 || d.invalidModelFailures > 0 || d.placements.stranded > 0 || d.placements.recovering > 0) return 'warn';
  return 'ok';
}

/** Work items. warn = a needs-human queue exists. (Backlog depth is not a health
 *  failure on its own — that's the work-feed / plans story.) */
export function workItemsStatus(d: WorkItemsHealth): PanelStatus {
  // The recovery-layer backlog the reaper is responsible for clearing: freed-but-
  // non-dispatchable rows + dead-held feature claims + dead-assigned issues + dead-
  // held plan-item reservations (P-008 / EI-2535).
  const stuckBacklog =
    (d.stuckFeatures ?? 0) +
    (d.deadHeldClaims ?? 0) +
    (d.deadAssignedIssues ?? 0) +
    (d.deadHeldAssignments ?? 0);

  // P-009: a recorded-but-aged-out reaper is WEDGED — the most severe work-queue
  // failure (stuck items accumulate silently). A null age = never recorded (fresh
  // boot / unknown) → warn, not crit, to avoid alarming on the ~1 boot interval
  // before the first sweep stamps its heartbeat.
  if (d.reaperStale && d.reaperAgeSec != null) return 'crit';
  // EI-2534: a reaper that has NEVER recorded a run (null age) is normally a benign
  // fresh-boot blip (warn, below) — UNLESS a real dead-held backlog is already
  // stranded. A never-armed/dark sweep WITH stuck rows is not a boot blip; it is the
  // reclaim-lane-not-firing incident (claims sat ~3h reading as a passive warn while
  // the un-armed sweep never freed them). Surface it as crit so a stranded backlog
  // under a non-firing reaper is loud, not silently yellow.
  if (d.reaperStale && d.reaperAgeSec == null && stuckBacklog > 0) return 'crit';
  // P-008 / EI-2535: any genuinely stuck row, a dead-held claim backlog, a
  // dead-assigned issue, or a dead-held plan-item reservation (reaper alive →
  // transient backlog it is actively clearing → warn).
  if (stuckBacklog > 0) return 'warn';
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
 * Tokens / gateway. crit = full starvation (no account available), the gateway is in the egress
 * path but unreachable, OR the gateway is WEDGED (B-GW-5: the watchdog auto-restart signature —
 * every slot pinned + a growing queue + frozen totalRequests), OR a CONFIRMED sustained admission
 * backlog with idle healthy accounts sitting unused (WI-3565: the deep-queue-below-ceiling starvation
 * mode `saturated` cannot see — > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN idle accounts + a queue
 * persisted > ADMISSION_STARVATION_QUEUE_RATIO x the live ceiling for ≥5min). warn = the gateway is
 * saturated, sustained-throttling, or admission-starvation-AT-RISK (not yet 5min-confirmed), a paused
 * bucket (RPM-pacing), or a paused account. ok otherwise.
 */
export function tokensStatus(d: TokensHealth): PanelStatus {
  if (d.accountsTotal > 0 && d.accountsAvailable === 0) return 'crit';
  if (d.gatewayEnabled && d.gatewayReachable === false) return 'crit';
  if (d.gateway?.wedge) return 'crit';
  // WI-3565: a confirmed, sustained starvation WITH idle healthy accounts sitting unused is crit —
  // it is exactly the "queue deep, pool idle, nothing alarmed" incident this detector exists to catch.
  // Without idle headroom the same deep queue is just normal full-pool pressure (the warn branch below).
  if (d.gateway?.admissionStarved && d.accountsAvailable > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN) return 'crit';
  // P-005/W3 (D-001): a leaked admission slot the valve can't reclaim is an early warn — the root-cause
  // signal that PRECEDES the wedge it would otherwise silently ride to (the wedge itself stays crit above).
  if (d.gateway?.saturated || d.gateway?.sustainedThrottle || d.gateway?.slotLeak) return 'warn';
  if (d.gateway?.admissionStarvationRisk) return 'warn';
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
  if (d.gitSyncConsecutiveErrorTicks >= GIT_SYNC_PUSH_FAIL_CRIT && d.gitSyncPushBacklog !== 0) return 'crit';
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
  // health-tab-v2 P-003: status keys on NEW aging (crossed the threshold in the
  // last 24h) + open blockers. STANDING aging (a weeks-old acknowledged backlog)
  // renders as a muted metric instead of re-warning every tick — a panel that is
  // yellow for a month is wallpaper, not signal.
  if (d.agingNew > 0 || (d.bySeverity.blocker ?? 0) > 0) return 'warn';
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

/**
 * MCP tool-call transport SLO (backend-reliability-100pct-2026-07-03 W8 / P-008): HARD
 * MCP-proxy failures in the window at/above this count RED the Infra panel (→
 * operator_degraded → the overall system light → a page). Calibrated for the "transient
 * is NOT normal" mandate: normal deploy restarts are ABSORBED by the proxy's retry window
 * (they log as SOFT `recovered`, not hard failures), so a hard-failure stream this size is
 * a genuine regression (a >retry-window outage, a post-connect error storm, or the W1.3
 * stale-socket-400 class returning) — never routine churn. ANY hard failure (>0) is a
 * WARN (visible), ending the culture of dismissing tool-call errors as normal. */
export const MCP_PROXY_HARD_FAIL_CRIT = 10;

/** Infra. crit = a per-thread perf WEDGE (operator unreachable / event-loop-lag /
 *  CLOSE_WAIT storm — F1/P-030), a sustained MCP tool-call-transport failure stream
 *  (W8/P-008, ≥ MCP_PROXY_HARD_FAIL_CRIT hard failures/window), or the gateway is enabled
 *  but unreachable (the spine is down). unknown = PG unreadable. warn = a per-thread perf
 *  warn (hot worker / RSS / gateway flap) or ANY MCP-proxy hard failure in the window
 *  (visible, sub-page). ok otherwise. A null/stale perf verdict — and a null (unreadable)
 *  mcpProxy leg — contribute nothing (fail-soft). */
export function infraStatus(d: InfraHealth): PanelStatus {
  if (d.perf?.status === 'crit') return 'crit';
  // A real, agent-facing tool-call failure stream OUTRANKS a greyed PG leg: a crit
  // MCP-proxy SLO breach reds Infra even if PG is momentarily unreadable this tick.
  if ((d.mcpProxy?.hardFailures ?? 0) >= MCP_PROXY_HARD_FAIL_CRIT) return 'crit';
  // Disk pressure (health-tab-v2 P-011, thresholds mirror the fedplane script):
  // >=95% used on any watched volume is a crit (writes are about to fail).
  const worstDiskPct = d.disk && d.disk.length > 0 ? Math.max(...d.disk.map((v) => v.usedPct)) : null;
  if (worstDiskPct !== null && worstDiskPct >= DISK_USED_CRIT_PCT) return 'crit';
  if (d.pg === null) return 'unknown';
  if (d.gatewayReachable === false) return 'crit';
  if (d.perf?.status === 'warn') return 'warn';
  if ((d.mcpProxy?.hardFailures ?? 0) > 0) return 'warn';
  if (worstDiskPct !== null && worstDiskPct >= DISK_USED_WARN_PCT) return 'warn';
  // Unapplied migrations = every deploy is one restart away from surprise DDL (P-011).
  if ((d.migrationDrift?.unapplied ?? 0) > 0) return 'warn';
  // Backup staleness: no successful snapshot in 48h (cadence is ~hours) (P-011).
  if (d.backup && d.backup.ageMs !== null && d.backup.ageMs > BACKUP_STALE_MS) return 'warn';
  // P-006/W4: PG-pool starvation is the routinesTick freeze mode — warn (not crit: the
  // pgHealth-latency proxy is coarse, matching P-005 slotLeak → warn, so one slow tick
  // doesn't red the panel; a sustained freeze still crits via the dead-routine detector).
  if (d.pool?.band === 'critical') return 'warn';
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

// ── health-tab-v2 (2026-07-12) additions ─────────────────────────────────────

/** Numeric severity for ack-coverage comparison (P-004). ok/unknown = 0. */
export function statusSeverity(s: PanelStatus): number {
  return s === 'crit' ? 2 : s === 'warn' ? 1 : 0;
}

/**
 * Does an ack COVER a panel's current status? (P-004 / D-A). An ack mutes
 * severities up to the acked one — an ack taken at 'warn' does NOT mute a later
 * 'crit' (escalation re-alarms); an expired snooze covers nothing. ok/unknown
 * need no coverage (the ack is cleared by the sweep instead).
 */
export function ackCovers(ack: Pick<PanelAck, 'status' | 'snoozeUntil'>, current: PanelStatus, now: number): boolean {
  if (statusSeverity(current) === 0) return false;
  if (ack.snoozeUntil !== null && now > ack.snoozeUntil) return false;
  return statusSeverity(current) <= statusSeverity(ack.status);
}

/**
 * P-001 — the paused-Mug cry-wolf fix. queenStatus() crits a paused colony with
 * ANY queued todo, but a paused pot whose queue is entirely UNPLACEABLE (the
 * work-feed frontier is empty or long-stuck/gated) is idle BY CHOICE — reddening
 * the whole tab for weeks over unplaceable residue is how the dashboard became
 * wallpaper. Reconciles the queen panel against the work-feed's PLACEABLE
 * frontier: paused + placeable demand stays crit (a genuine silent outage);
 * paused + only unplaceable residue downgrades to warn with a summary that
 * AGREES with the status. Returns null when no adjustment applies (not paused,
 * not crit, or the work-feed was unreadable this tick — fail-soft keeps the
 * conservative crit).
 */
export function reconcilePausedQueen(
  queen: { status: PanelStatus; data: QueenHealth | null },
  workFeed: { data: WorkFeedHealth | null },
): { status: PanelStatus; summary: string } | null {
  const q = queen.data;
  if (!q || q.started || queen.status !== 'crit') return null;
  const wf = workFeed.data;
  if (!wf) return null; // frontier unreadable — keep the conservative crit
  const placeable = Math.max(0, wf.frontier - (wf.frontierStuck ?? 0));
  if (placeable > 0 || wf.startedPlans > 0) {
    return {
      status: 'crit',
      summary: `paused — ${placeable > 0 ? `${placeable} placeable item(s)` : `${wf.startedPlans} started plan(s)`} queued (silent outage)`,
    };
  }
  const residue = q.demand.todoItems;
  return {
    status: 'warn',
    summary: residue > 0
      ? `paused — idle by choice (${residue} queued item(s), none placeable)`
      : 'paused — colony idle by choice',
  };
}

/** Engine loops (P-008). Overdue armed loops / recent failure streaks = warn —
 *  a dead loop stalls ITS lane, not the running system (the workFeed dead-routine
 *  crit already covers an engine-wide freeze). */
export function loopsStatus(d: LoopsHealth): PanelStatus {
  if (d.overdue > 0 || d.failureStreaks > 0) return 'warn';
  return 'ok';
}

/**
 * Coordination (P-009). Deliberately WARN-max for its burn-in period (D-D:
 * a brand-new panel must not red the overall tab until its thresholds have
 * survived contact with reality — the exact cry-wolf failure P-001 fixes).
 */
export function coordinationStatus(d: CoordinationHealth, now?: number): PanelStatus {
  void now;
  if (d.leaderlessFleets > 0) return 'warn';
  if (d.staleAwaits > 0) return 'warn';
  if (d.criticalContext > 0) return 'warn';
  if (d.unansweredOldestMs !== null && d.unansweredOldestMs > UNANSWERED_DIRECTED_WARN_MS) return 'warn';
  // Claim-health (WI-4460): a dead holder's claim is abandoned work; a coverage
  // collision is two live principals on one deliverable — both real smells.
  if (d.orphanedClaims > 0) return 'warn';
  if (d.coverageCollisions > 0) return 'warn';
  // Stalled = alive-but-not-progressing. Unlike the watchdog this count doesn't
  // suppress checkpoint-documented holds (see types.ts), so warn only — and
  // parkedMembers (benched-by-design) never affects status at all.
  if (d.stalledClaims > 0) return 'warn';
  return 'ok';
}

/** Memory (P-010). Warn only on a degraded recall signal over a real store —
 *  an empty/new store is not a failure, and the store size itself is
 *  informational. */
export function memoryStatus(d: MemoryPanelHealth): PanelStatus {
  if (d.totalMemories > 100 && d.zeroHitRate !== null && d.zeroHitRate >= 0.9) return 'warn';
  return 'ok';
}
