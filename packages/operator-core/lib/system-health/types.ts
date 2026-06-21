/**
 * system-health/types — the SystemHealth snapshot contract
 * (system-health-tab-2026-06-15 P-001, D-001).
 *
 * ONE health model, TWO consumers (D-001): the read-only **Health tab** (the
 * full human view) and the autonomous **overwatch** role (overwatch-role-
 * 2026-06-15 C-1, whose `OverwatchBrief` is the *actionable subset* — panels +
 * anomalies + nudges). `computeSystemHealth` (compute.ts) is the single
 * substrate; `computeOverwatchBrief` (B-03) wraps it. Never two health models
 * that drift — so these types are a CONTRACT both sides build against.
 *
 * Each panel is a green/yellow/red status light + a few key counters, so a human
 * grasps "is the system healthy, and if not, which panel is red?" in two seconds
 * (D-003). A flaky source greys its card (`unknown`) — it never blanks the tab.
 */

import type { PerfVerdict } from './perf-budgets';

/**
 * A panel's health light. `unknown` = the source could not be read this tick
 * (greyed, NOT a fabricated outage — fail-soft, mirroring learning-infra-health's
 * leg model). The status model lives in `./thresholds.ts` (one place, unit-tested).
 */
export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

/** A single counter on a card. `tone` optionally colours the value. */
export interface HealthMetric {
  label: string;
  value: string | number;
  /** Optional per-metric tone (e.g. a non-zero failure count → 'crit'). */
  tone?: PanelStatus;
}

/** A drill-down link to the existing detail surface (the Queen pane, /admin/git, …). */
export interface HealthLink {
  label: string;
  href: string;
}

/** The 15 panels, in render order. `overwatch` (#15) is the autonomous
 *  supervisor's own loop health (overwatch-role-2026-06-15 #15, the
 *  who-watches-the-watcher card). */
export type PanelKey =
  | 'queen'
  | 'bees'
  | 'workItems'
  | 'workFeed'
  | 'tokens'
  | 'watchdog'
  | 'deploy'
  | 'plans'
  | 'escalations'
  | 'autonomy'
  | 'observations'
  | 'improvements'
  | 'infra'
  | 'suFleet'
  | 'overwatch';

/** Canonical render order for the tab's status-card grid. */
export const PANEL_ORDER: readonly PanelKey[] = [
  'queen',
  'bees',
  'workItems',
  'workFeed',
  'tokens',
  'watchdog',
  'deploy',
  'plans',
  'escalations',
  'autonomy',
  'observations',
  'improvements',
  'infra',
  'suFleet',
  'overwatch',
] as const;

export const PANEL_LABELS: Record<PanelKey, string> = {
  queen: 'Queen',
  bees: 'Bees / fleet',
  workItems: 'Work items',
  workFeed: 'Work-feed',
  tokens: 'Tokens / gateway',
  watchdog: 'Watchdog',
  deploy: 'Git-sync / deploy',
  plans: 'Plans',
  escalations: 'Escalations',
  autonomy: 'Autonomy',
  observations: 'Observations',
  improvements: 'Improvements',
  infra: 'Infra',
  suFleet: 'SU fleet',
  overwatch: 'Overwatch',
};

/**
 * One status card. `data` carries the raw structured reading (what the overwatch
 * brief maps over + the card drills into); `metrics` is the glanceable subset the
 * card shows. `error` is set (and `status` = 'unknown') when the collector threw.
 */
export interface HealthPanel<T = unknown> {
  key: PanelKey;
  label: string;
  status: PanelStatus;
  /** One human line ("looping, last wake 4m ago" / "STALLED 47m — no wake armed"). */
  summary: string;
  metrics: HealthMetric[];
  link?: HealthLink;
  data: T | null;
  error?: string;
}

// ── per-panel data shapes ────────────────────────────────────────────────────

/** Queen loop health — the failure mode the tab exists for (origin 2026-06-15). */
export interface QueenHealth {
  hiveSlug: string | null;
  /** Is the colony meant to be running (getHiveStarted)? false = paused. */
  started: boolean;
  /** started && stale past the stall threshold && demand queued && not mid-turn. */
  stalled: boolean;
  /** A tracked hive turn is live right now (don't call a working Queen "stalled"). */
  midTurn: boolean;
  /** An active hive-wake routine with a next_fire_at exists. */
  armed: boolean;
  /** ms epoch of the last wake activity (launch fire or routine fire). */
  lastWakeAt: number | null;
  /** ms since the last wake activity (the stall clock). */
  staleForMs: number | null;
  /** ms epoch of the next armed wake. */
  nextFireAt: number | null;
  /** armed && not stalled — the loop is keeping cadence. */
  cadenceOk: boolean;
  /** Hive watchdog fallback fires in the last 24h (a forgot-to-declare signal). */
  watchdogFires24h: number;
  /** Standing demand a forgotten wake would strand. */
  demand: { todoItems: number; startedPlans: number };
  /** Governed decisions this window, auto vs gated (decision-ledger). */
  decisionsWindow: { total: number; auto: number; gated: number };
  /** Open placements the Queen is currently tracking to completion. */
  workingTracked: number;
}

/** Bees / fleet. */
export interface BeesHealth {
  /** Live `bee`-role nursery spawns (running / restarting). */
  running: number;
  alive: number;
  /** Running but presence-stale (wedged / dead). */
  stale: number;
  /** Active claims whose holder is gone/stale. */
  orphanedClaims: number;
  totalLoad: number;
  /** Open-placement dispositions (the completion watchdog). */
  placements: { recovering: number; cursed: number; stranded: number; workingTracked: number };
}

/** Work items by lifecycle state. */
export interface WorkItemsHealth {
  total: number;
  byState: Record<string, number>;
  todo: number;
  inProgress: number;
  blocked: number;
  needsHuman: number;
  done: number;
  // Stuck-items recovery health (work-queue-stuck-item-recovery P-008 / P-009).
  // OPTIONAL — absent when the work-queue-health read failed this tick (the panel
  // still renders its base counts, fail-soft).
  /** Freed-but-non-dispatchable feature rows (should be ~0; any >0 is a real anomaly). */
  stuckFeatures?: number;
  /** Feature claims past grace still held by a dead holder (reaper backlog). */
  deadHeldClaims?: number;
  /** Open bug/change issues past grace still assigned to a dead holder. */
  deadAssignedIssues?: number;
  /** Age of the stale-claim reaper's last recorded run, in seconds; null if never
   *  recorded (fresh boot / unknown). */
  reaperAgeSec?: number | null;
  /** The reaper hasn't run within its staleness window (likely wedged) — P-009. */
  reaperStale?: boolean;
}

/** Work-feed flow. */
export interface WorkFeedHealth {
  /** Ready-to-place frontier items (unblocked todo feature-family). */
  frontier: number;
  /** Lanes held by unsatisfied blocked_by. */
  frontierBlocked: number;
  startedPlans: number;
  /** Auto-eligible improvements stuck at attempts:0 — eligible but never dispatched
   *  (the EI-584 dead-feed signature: the feed isn't pumping ready work). */
  autoEligibleStuck: number;
  /** Active routines whose next_fire_at is long overdue (the dead-routine / EI-584 signal). */
  deadRoutines: number;
  deadRoutineNames: string[];
}

/**
 * The structured gateway-internal metrics + the wedge/throttle verdict (B-GW-5). Sourced from the
 * gateway's own `/stats` (its admission queue + AIMD state), DISTINCT from the fleet rate-governor's
 * view (`fleetInFlight`/`fleetCap`). Makes the watchdog's silent auto-restart signature VISIBLE.
 * Null on `TokensHealth.gateway` when the gateway is unreachable / not in the egress path.
 */
export interface GatewayPanelMetrics {
  inFlight: number;
  queueDepth: number;
  /** Live effective admission cap (AIMD-adjusted). */
  maxConcurrent: number;
  /** Configured admission ceiling; null on a pre-AIMD gateway (deploy-skew). */
  concurrencyCap: number | null;
  shed429: number;
  shedAllThrottled: number;
  failovers: number;
  upstream429: number;
  utilizationPct: number | null;
  /** AIMD effective concurrency; null on a pre-AIMD gateway. */
  aimdEffective: number | null;
  /** AIMD ceiling; null on a pre-AIMD gateway. */
  aimdCap: number | null;
  /** CONFIRMED wedge: every slot pinned + a growing queue + totalRequests frozen (watchdog restarts on this). */
  wedge: boolean;
  /** Instantaneous wedge-RISK: at the slot ceiling with work queued (not yet confirmed frozen). */
  saturated: boolean;
  /** Sustained upstream throttle (AIMD cut concurrency, fail-fast shed, or backlog overflow). */
  sustainedThrottle: boolean;
  /** Human reasons for any non-ok signal (surfaced on the panel + the overwatch anomaly). */
  reasons: string[];
}

/** Tokens / gateway — the two starvation modes (5h-exhaustion AND RPM-pacing) + the gateway wedge. */
export interface TokensHealth {
  gatewayEnabled: boolean;
  /** null when the gateway is not in the egress path (flag off) — not probed. */
  gatewayReachable: boolean | null;
  pausedBuckets: number;
  totalBuckets: number;
  fleetInFlight: number;
  fleetCap: number;
  /** $ spend over the lookback window. */
  spendUsd: number;
  windowMs: number;
  accountsTotal: number;
  accountsAvailable: number;
  accountsPaused: number;
  /** The gateway's own admission/AIMD metrics + wedge/throttle verdict (B-GW-5). null = not read
   *  (gateway unreachable / flag off / /stats failed) — never fabricated. */
  gateway: GatewayPanelMetrics | null;
}

/** Watchdog liveness. */
export interface WatchdogHealth {
  /** Hive watchdog fallback fires in the last 24h. */
  fires24h: number;
  /** A wake is armed for the started hive. */
  livenessArmed: boolean;
  staleForMs: number | null;
  /** Recent error-level notifications (anomaly proxy). */
  recentErrors: number;
}

/** Git-sync / deploy pipeline. */
export interface DeployHealth {
  deployedShortSha: string | null;
  /** Commits the integration branch (staging) has that the live :3070 doesn't. */
  deployedBehindMain: number | null;
  /** Commits staging has that the green pin (main) doesn't — not-yet-green buffer. */
  readyBehindMain: number | null;
  /** Green & deployable but not yet deployed. */
  deployedBehindReady: number | null;
  /** The green pin is exactly at the staging tip (fully caught up). */
  readyAtMainHead: boolean | null;
  deployedAtMs: number | null;
  /** Integration-branch HEAD commit time — a git-sync lag proxy. */
  lastCommitAtMs: number | null;
  errors: string[];
  // ── git-sync UPSTREAM delivery (EI-18 routine metadata) ──────────────────────
  // The refs above measure the DOWNSTREAM half (staging→main→live). These measure
  // the UPSTREAM half: is the local tree's work actually reaching origin? New local
  // commits keep landing while a push FAILS, so `lastCommitAtMs` stays fresh and the
  // refs alone are blind to a stalled push — the EI-18 silent-failure class (a push
  // failed every tick for ~20h with zero fleet-visible signal). Read from the worst
  // active `system:git-sync` routine's metadata that git-sync-action.ts persists.
  /** Worst active git-sync routine's last push outcome, or null if none/unreadable. */
  gitSyncStatus: 'synced' | 'conflict' | 'error' | 'nothing' | 'skipped' | null;
  /** Max consecutive git-sync ticks whose push FAILED across active routines —
   *  >= 3 means local commits are NOT reaching origin (EI-18 escalation threshold). */
  gitSyncConsecutiveErrorTicks: number;
  /** ms epoch of the freshest successful git-sync (metadata.last_synced_at), or null. */
  gitSyncLastSyncedAtMs: number | null;
  /** Oversized files git-sync EXCLUDED from the auto-commit (they will never push). */
  gitSyncOversizedCount: number;
}

/** Plans. */
export interface PlansHealth {
  active: number;
  started: number;
  shipped: number;
  draft: number;
  itemsDone: number;
  itemsTotal: number;
  /** Started plans with no op update in the aging window. */
  stalledPlans: number;
}

/** Escalations. */
export interface EscalationsHealth {
  open: number;
  oldestAgeMs: number | null;
  bySeverity: Record<string, number>;
  /** Open escalations older than the aging threshold. */
  aging: number;
}

/** Autonomy gate ceilings + tripwires. */
export interface AutonomyHealth {
  categories: number;
  locked: number;
  /** category → effectiveCeiling (the compact heatmap). */
  byCeiling: Record<string, number>;
  tripwiresArmed: number;
  tripwiresTripped: number;
  tripwiresReverted: number;
}

/** Observation lane (the pre-idea sensor readings). */
export interface ObservationsHealth {
  /** Open observations. */
  laneCount: number;
  recentByRole: Record<string, number>;
  newestAt: number | null;
}

/** Improvements queue. */
export interface ImprovementsHealth {
  open: number;
  autoEligible: number;
  humanQueue: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
}

/** Infra — PG + gateway reachability + the per-thread perf verdict (F1/P-030). */
export interface InfraHealth {
  pg: { version: string; total: number; active: number; idle: number } | null;
  gatewayReachable: boolean | null;
  /** Per-thread perf-SLO verdict from Lane E's latest perf-signals-v1 capture
   *  (F1/P-030). null = no capture / E1 not running on this box; status 'unknown' =
   *  stale. Budgets are per-thread (worker CPU%, event-loop lag, CLOSE_WAIT,
   *  reachability) — never loadavg-absolute (128-core box; round-4 D-002 reframe). */
  perf: PerfVerdict | null;
}

/** SU fleet (interactive collaborators) presence. */
export interface SuFleetHealth {
  total: number;
  live: number;
  stale: number;
  byRole: Record<string, number>;
}

/**
 * Overwatch — the autonomous system-health supervisor's OWN loop health (panel
 * #15, overwatch-role-2026-06-15 / D-004 who-watches-the-watcher). Sourced from
 * B-07's control state + B-09's liveness + the `papercusp-overwatch` flag — NOT a
 * second aggregation (D-006). `flagEnabled === false` is the role's intended-dark
 * default (greyed, not a failure); a started loop that has gone `alive === false`
 * is the supervisor itself dying (crit).
 */
export interface OverwatchPanelHealth {
  /** The `papercusp-overwatch` activation flag (D-009). false = intentionally dark. */
  flagEnabled: boolean;
  /** The persisted `overwatch_started` bit (B-07). true = the loop should be running. */
  started: boolean;
  /** Liveness (B-09 isOverwatchAlive): true = alive, false = dark, null = not-in-play/uncomputable. */
  alive: boolean | null;
  /** A live `overwatch-wake` routine with a next fire exists (B-09). */
  armed: boolean;
  /** The configured wake cadence in seconds (B-07; default 600). */
  cadenceSec: number;
  /** ms epoch of the last overwatch wake fire, or null (never fired). */
  lastWakeAt: number | null;
  /** ms epoch of the next armed wake, or null. */
  nextFireAt: number | null;
  /** ms since the last wake fire (the stall clock), or null. */
  staleForMs: number | null;
  /** Overwatch watchdog fallback fires in the last 24h (a forgot-to-declare signal). */
  watchdogFires24h: number;
  /**
   * Monitor-the-monitor (hive-loop-supervision 2026-06-21): the emission freshness of
   * the every-wake hive-coordination-health scorecard, checked SINCE the Overwatch's
   * ACTUAL last wake. null when not applicable (paused / never-woke / flag-off / read
   * error). `fresh` = a COMPLETE scorecard landed since the last wake.
   */
  scorecardEmission: {
    status: 'fresh' | 'partial-only' | 'stale';
    lastCompleteAt: string | null;
    missingCount: number;
  } | null;
  /**
   * True when the Overwatch is alive+started, its last wake has SETTLED past the grace,
   * and that wake emitted no COMPLETE scorecard — the Owner-#1 every-wake mandate was
   * skipped. The time-sensitive grace lives in compute.ts (where `now` is available) so
   * the liveness alarm stays a pure read over the snapshot.
   */
  scorecardSkipped: boolean;
}

/**
 * Who-watches-the-watcher (overwatch-role C-1 / D-004). `overwatchAlive` is null
 * until the overwatch role lands (overwatch-role-2026-06-15). The Health tab
 * surfaces it; the overwatch brief raises an anomaly when a counterpart goes dark.
 */
export interface CrossMonitor {
  queenAlive: boolean;
  overwatchAlive: boolean | null;
}

/** The keyed panel set — heterogeneous data per key. */
export interface SystemHealthPanels {
  queen: HealthPanel<QueenHealth>;
  bees: HealthPanel<BeesHealth>;
  workItems: HealthPanel<WorkItemsHealth>;
  workFeed: HealthPanel<WorkFeedHealth>;
  tokens: HealthPanel<TokensHealth>;
  watchdog: HealthPanel<WatchdogHealth>;
  deploy: HealthPanel<DeployHealth>;
  plans: HealthPanel<PlansHealth>;
  escalations: HealthPanel<EscalationsHealth>;
  autonomy: HealthPanel<AutonomyHealth>;
  observations: HealthPanel<ObservationsHealth>;
  improvements: HealthPanel<ImprovementsHealth>;
  infra: HealthPanel<InfraHealth>;
  suFleet: HealthPanel<SuFleetHealth>;
  overwatch: HealthPanel<OverwatchPanelHealth>;
}

/**
 * The whole-system health snapshot. `overall` is the worst non-`unknown` panel
 * status (an unread source greys its card but never reds the system, D-003 / the
 * fail-soft stance). Read by the `health.snapshot` sync resolver (SSE-live) and
 * wrapped by the overwatch brief.
 */
export interface SystemHealth {
  workspaceId: string;
  /** ms epoch of this evaluation. */
  evaluatedAt: number;
  overall: PanelStatus;
  crossMonitor: CrossMonitor;
  panels: SystemHealthPanels;
}
