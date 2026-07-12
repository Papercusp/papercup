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

/** The 20 panels, in render order. `overwatch` is the autonomous
 *  supervisor's own loop health (overwatch-role-2026-06-15 #15, the
 *  who-watches-the-watcher card). `toolEfficiency` (WI-839) folds the 3
 *  measuring-code-run-adoption.mdx tool-usage metrics into one recurring card.
 *  `loops` / `coordination` / `memory` are the health-tab-v2-2026-07-12 legs
 *  (P-008/P-009/P-010) for the post-June platform machinery. */
export type PanelKey =
  | 'queen'
  | 'bees'
  | 'workItems'
  | 'workFeed'
  | 'loops'
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
  | 'coordination'
  | 'overwatch'
  | 'scout'
  | 'memory'
  | 'toolEfficiency';

/** Canonical render order for the tab's status-card grid. */
export const PANEL_ORDER: readonly PanelKey[] = [
  'queen',
  'bees',
  'workItems',
  'workFeed',
  'loops',
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
  'coordination',
  'overwatch',
  'scout',
  'memory',
  'toolEfficiency',
] as const;

export const PANEL_LABELS: Record<PanelKey, string> = {
  queen: 'Mug',
  bees: 'Cups / fleet',
  workItems: 'Work items',
  workFeed: 'Work-feed',
  loops: 'Engine loops',
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
  coordination: 'Coordination',
  overwatch: 'Kettle',
  scout: 'Blender / ideation',
  memory: 'Memory',
  toolEfficiency: 'Tool efficiency',
};

/**
 * An owner acknowledgement on a panel (health-tab-v2 P-004 / D-A). An acked
 * panel renders muted-with-badge and is EXCLUDED from `overall`. The ack covers
 * severities UP TO `status` (an ack at 'warn' does NOT mute a later 'crit' —
 * escalation re-alarms) and auto-clears when the panel recovers to ok or the
 * snooze expires.
 */
export interface PanelAck {
  /** The severity acked ('warn' | 'crit'). */
  status: Extract<PanelStatus, 'warn' | 'crit'>;
  reason: string;
  ackedBy: string;
  /** ms epoch. */
  ackedAt: number;
  /** ms epoch hard expiry, or null (= until recovery). */
  snoozeUntil: number | null;
}

/**
 * One status card. `data` carries the raw structured reading (what the overwatch
 * brief maps over + the card drills into); `metrics` is the glanceable subset the
 * card shows. `error` is set (and `status` = 'unknown') when the collector threw.
 * `ack` (P-004) marks an owner-acknowledged panel — muted in the UI, excluded
 * from the overall roll-up while the ack covers the current severity.
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
  ack?: PanelAck;
}

// ── per-panel data shapes ────────────────────────────────────────────────────

/** Queen loop health — the failure mode the tab exists for (origin 2026-06-15). */
export interface QueenHealth {
  potSlug: string | null;
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
  /** Count of the most-recent CONSECUTIVE Queen wakes that ran 0 LLM tokens — the
   *  agent launched but the LLM never executed (infra / rate-limit loss), DISTINCT
   *  from a healthy short wake (which still spends tokens deciding "nothing to do").
   *  Feeds the queen-placement-stalled detector (hive-loop-supervision 2026-06-21). */
  consecutiveZeroTokenWakes: number;
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
  /** Recent autonomous-role spawns that failed before a turn because the selected model is unavailable/inaccessible. */
  invalidModelFailures: number;
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
  /** Active plan-item reservations past grace still held by a dead holder (EI-2535). */
  deadHeldAssignments?: number;
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
  /** Of `frontier`, the count still unplaced past the stuck window
   *  (PAPERCUSP_FRONTIER_STUCK_HOURS, default 3h). An unblocked item the Queen
   *  leaves waiting for hours while she turns on cadence isn't fresh placeable
   *  work — it's gated on something she can't resolve (owner decision / live
   *  rig / fixture), i.e. correct idle. A frontier that is ALL stuck must NOT
   *  read as a placement stall (WI-3597). Subset of `frontier`; absent ⇒ 0. */
  frontierStuck?: number;
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
  /** P-005/W3 (D-001): a leaked admission slot the self-heal valve could NOT reclaim (the gateway's own
   *  reconcile guard counted a mismatch) — surfaces the leak as a signal instead of a silent wedge/restart. */
  slotLeak: boolean;
  /** WI-3565: instantaneous risk — the admission backlog is deep vs the LIVE ceiling (distinct from
   *  `saturated`, which needs every slot pinned; a starved queue can sit below the ceiling). */
  admissionStarvationRisk: boolean;
  /** WI-3565: `admissionStarvationRisk` CONFIRMED sustained ≥5min — the alert-worthy signal (mirrors
   *  `wedge` confirming `saturated`). Combined with idle-account headroom in `tokensStatus` /
   *  `collectTokens` to produce the crit alert (a deep queue with NO idle capacity is just normal
   *  pressure; a deep queue WITH idle healthy accounts sitting unused is the starvation bug). */
  admissionStarved: boolean;
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
  /** Live superproject + submodule commits ahead of upstream. 0 proves a stale
   *  error counter no longer means commits are waiting to reach origin; null means
   *  the live git check was unavailable, so the metadata counter stays authoritative. */
  gitSyncPushBacklog: number | null;
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
  /** Plans force-STARTED while still status=draft — the queen-plan-selection
   *  anti-pattern the rubric flags ("does not force-start a draft"). Surfaced so the
   *  Overwatch can rate queen-plan-selection instead of 'unknown' (hive-loop-supervision
   *  2026-06-21). */
  startedDraft: number;
}

/** Escalations. */
export interface EscalationsHealth {
  open: number;
  oldestAgeMs: number | null;
  bySeverity: Record<string, number>;
  /** Open escalations older than the aging threshold. */
  aging: number;
  /** Of `aging`, those that CROSSED the threshold within the last 24h — the
   *  "new incident" subset the panel status keys on (health-tab-v2 P-003).
   *  Standing aging (aging - agingNew) is a muted metric, not an alarm: a
   *  month-old backlog re-warning every tick is banner blindness, not signal. */
  agingNew: number;
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
  /** Open observations — the TRUE count (countIssues), not the sampled list
   *  length (health-tab-v2 P-002: the old read pinned at the 500 list cap). */
  laneCount: number;
  /** recentByRole/newestAt derive from a bounded sample (newest 500); true when
   *  laneCount exceeds the sample, so per-role counts are partial. */
  sampled?: boolean;
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

/**
 * MCP tool-call transport health — the resilient MCP proxy's windowed FAILURE summary
 * (backend-reliability-100pct-2026-07-03 W8 / P-008). Sourced from the proxy's durable
 * failure ledger (~/.papercusp/mcp-proxy-failures.jsonl, written by
 * apps/operator/lib/mcp-proxy/proxy.ts). These connection-level failures NEVER create a
 * `tool_invocations` row (they error at the HTTP layer, below tool dispatch), so the
 * agent-facing failure rate was under-counted and "transient errors" felt normal — this
 * is the SLO signal that ends that culture. Null on `InfraHealth.mcpProxy` when the
 * ledger is unreadable (greyed leg, never fabricated). Computed by
 * system-health/mcp-proxy-health.ts (`summarizeMcpProxyHealth`).
 */
export interface McpProxyHealth {
  /** The lookback window these counts cover (ms). */
  windowMs: number;
  /** All failure records in the window (hard + soft). */
  total: number;
  /** HARD failures — a real agent-facing tool-call error the proxy could NOT hide: the
   *  retry window exhausted (upstream refused the whole time → 503), a post-connect
   *  upstream error not safely retried (→ 502), or a forwarded non-2xx bearing the
   *  stale-socket-400 signature (W1.3 regression: status 400 + `connection: close`). The
   *  SLO number — sustained non-zero reds the Infra panel → operator_degraded → overall. */
  hardFailures: number;
  /** SOFT: the proxy retried a refused upstream and RECOVERED (a deploy-restart window it
   *  absorbed; the agent saw success). Informational — elevated under deploy churn, never
   *  alarming (the resilience working as designed). */
  recovered: number;
  /** Forwarded non-2xx that were NOT the stale-socket signature NOR a benign probe (a
   *  genuine upstream 4xx/5xx). */
  otherNon2xx: number;
  /** P-006: benign probe/heartbeat non-2xx (408 heartbeat, GET-405 liveness probe) —
   *  explicitly separated so it can never inflate hardFailures/otherNon2xx or any alarm.
   *  Informational only. */
  benign: number;
  /** Count by raw `kind` (recovered | upstream_non2xx | exhausted_refused | upstream_error
   *  | post_connect_retry). */
  byKind: Record<string, number>;
  /** ms epoch of the newest failure record in the window, or null when none. */
  newestAt: number | null;
}

/** Infra — PG + gateway reachability + the per-thread perf verdict (F1/P-030) + the
 *  MCP tool-call transport SLO (W8/P-008). */
export interface InfraHealth {
  pg: {
    version: string;
    total: number;
    active: number;
    idle: number;
    /** P-008: postmaster boot time, epoch MILLIS (null = unreadable). A change
     *  across ticks = a PG restart; the infra-liveness alarm watches it for drift. */
    postmasterStartMs: number | null;
  } | null;
  gatewayReachable: boolean | null;
  /** Per-thread perf-SLO verdict from Lane E's latest perf-signals-v1 capture
   *  (F1/P-030). null = no capture / E1 not running on this box; status 'unknown' =
   *  stale. Budgets are per-thread (worker CPU%, event-loop lag, CLOSE_WAIT,
   *  reachability) — never loadavg-absolute (128-core box; round-4 D-002 reframe). */
  perf: PerfVerdict | null;
  /** MCP proxy windowed failure summary (W8/P-008). null = ledger unreadable this tick
   *  (greyed leg, fail-soft — never blanks the panel). Absent-file = a healthy zero. */
  mcpProxy: McpProxyHealth | null;
  /**
   * PG connection-pool acquisition pressure (P-006/W4). `probeMs` = the latency of this
   * tick's pgHealth() round-trip (a coarse but real acquire-latency proxy: pgHealth
   * acquires a connection + runs two pg_stat_activity aggregates); `band` classifies it
   * (elevated ⇒ contended, critical ⇒ starved — the routinesTick freeze mode). Measured
   * from THIS process, so it observes the shared PG server cross-process-safely (it does
   * NOT read the bg-host tick's in-process shed counter). OPTIONAL (deploy-skew-safe):
   * absent on an older projection ⇒ treated as no signal. null when PG is unreadable. */
  pool?: { probeMs: number; band: 'ok' | 'elevated' | 'critical' } | null;
  /** Disk pressure (health-tab-v2 P-011, mirrors the fedplane script's 90% warn):
   *  used% per watched mount (~/.papercusp + the repo volume, deduped by device).
   *  OPTIONAL + null when statfs is unavailable — never fabricated. */
  disk?: Array<{ path: string; usedPct: number }> | null;
  /** Backup freshness (P-011): newest SUCCESSFUL kopia snapshot. null = tables
   *  unreadable/absent this tick (greyed leg). */
  backup?: { lastOkAtMs: number | null; ageMs: number | null; lastStatus: string | null } | null;
  /** Migration drift (P-011, the db:check_drift source): migrations on disk not
   *  yet recorded in schema_migrations. null = drift unreadable this tick. */
  migrationDrift?: { unapplied: number } | null;
}

/** SU fleet (interactive collaborators) presence. */
export interface SuFleetHealth {
  total: number;
  live: number;
  stale: number;
  byRole: Record<string, number>;
}

/**
 * Engine loops (health-tab-v2 P-008) — the `loop:arm` self-wake mechanism's
 * health: active `loop-*` routines (armed), how many are overdue past the
 * dead-routine window, and recent failure streaks from `autoloop_state`.
 * Only RECENTLY-FIRED autoloop rows count (the table accretes one row per
 * historical loop owner — ~370 stale rows at v2 time — so raw counts lie).
 */
export interface LoopsHealth {
  /** Active loop-* routines (armed self-wakes). */
  armed: number;
  /** Of `armed`, next_fire_at overdue past the dead-routine window. */
  overdue: number;
  overdueNames: string[];
  /** autoloop_state loop-* rows fired in the last 24h with consecutive_errors >= 3. */
  failureStreaks: number;
  /** ms epoch of the newest loop-* fire in the last 24h, or null. */
  lastFireAt: number | null;
}

/**
 * Coordination health (health-tab-v2 P-009) — the fleet-coordination failure
 * modes the playbook treats as highest-priority, previously visible only via
 * coord:glance: unanswered DIRECTED messages (a blocked peer waiting on a
 * reply), sessions at critical context (about to force-compact), event-await
 * waiters with no expiry going stale (the "sleeps-forever" class), and fleets
 * with live members but NO live leader (the silent-mass-failure mode).
 */
export interface CoordinationHealth {
  /** Live sessions with >=1 unanswered directed message addressed to them. */
  unansweredAgents: number;
  /** Total unanswered directed messages across live sessions. */
  unansweredTotal: number;
  /** Age of the oldest unanswered directed message (ms), or null. */
  unansweredOldestMs: number | null;
  /** Live sessions past ~90% of their compaction limit. */
  criticalContext: number;
  /** Live sessions past ~75% of their compaction limit. */
  highContext: number;
  /** Active event_awaits (fired_at/cancelled_at null). */
  activeAwaits: number;
  /** Active awaits with NO expiry older than 24h — likely stranded waiters. */
  staleAwaits: number;
  /** Fleets with >=1 live member and no live leader. */
  leaderlessFleets: number;
  /** Distinct fleets with >=1 live member. */
  liveFleets: number;
  /** Active claims whose holder is DEAD (ended/heartbeat-stale) — abandoned work
   *  awaiting reclaim (WI-4460; same derivation as coord:glance's orphaned_claims). */
  orphanedClaims: number;
  /** Active claims whose holder is ALIVE but not advancing the item — the
   *  live-but-not-progressing reclaimable set. NB: unlike the claim-integrity
   *  watchdog (EI-10125), this count does NOT suppress checkpoint-documented
   *  holds, so it can legitimately sit >0 on a deliberately-parked lane. */
  stalledClaims: number;
  /** Plan-item deliverables held by >1 principal via the work-item↔plan-item
   *  coverage edge (EI-6074) — the cross-claim-table duplicate that reads as
   *  orphaned:0/stalled:0 while two live agents run the same work. */
  coverageCollisions: number;
  /** Live members deliberately parked on a non-inbox events:await key — benched
   *  by design (idle-but-healthy), NOT stalled/abandoned. Informational only. */
  parkedMembers: number;
}

/**
 * Memory-system health (health-tab-v2 P-010) — folds the SAME readMemoryHealth
 * the Learning tab's MemoryHealthCard renders (D-C: reuse the computer, never a
 * second derivation). `entityRows` is the EI-366 fragment-leak canary's input;
 * the card links to the Learning tab for the full view.
 */
export interface MemoryPanelHealth {
  /** REAL memories (entity rows excluded — the honest count). */
  totalMemories: number;
  /** Segregated mem0 entity-linking rows sharing the canonical table. */
  entityRows: number;
  /** memory_feedback events in the trailing 30 days — the loop's pulse. */
  feedback30d: number;
  /** Recall zero-hit rate (0..1) when the telemetry exposes one, else null. */
  zeroHitRate: number | null;
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
   * the every-wake pot-coordination-health scorecard, checked SINCE the Overwatch's
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

/** Scout ideation health (`scout_ticks`) — surfaced so the Overwatch can rate
 *  ideation-quality instead of 'unknown' (hive-loop-supervision 2026-06-21). */
export interface ScoutHealth {
  /** ms epoch of the newest tick (any status), or null when none. */
  lastTickAt: number | null;
  /** ms epoch of the newest RAN tick (a full cycle), or null. */
  lastRanAt: number | null;
  /** Ideas generated by the most recent RAN tick. */
  ideasLastRun: number;
  /** Total ideas generated across RAN ticks in the window. */
  ideasInWindow: number;
  /** RAN ticks (full cycles) in the window. */
  ranInWindow: number;
  /** Transport-death: cycles RAN in-window but generated ZERO ideas (a transport
   *  failure / dead ideator path, NOT low quality). False when no cycle ran (idle,
   *  not dead) or ideas > 0. The plan's "Scout 0 ideas/24h" signal. */
  transportDeath: boolean;
}

/** A rating shared by the three tool-efficiency metrics (mirrors each metric
 *  module's own Grade shape — limit-failure-rate.ts / orient-dedup-rate.ts /
 *  code-run-adoption.ts). */
export interface ToolEfficiencyRating {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/**
 * Tool efficiency (panel #17, WI-839) — the 3 canonical
 * measuring-code-run-adoption.mdx SQL metrics folded into one recurring card,
 * so a regression (a tight new validation cap, the code:run nudge losing
 * effect, agents re-calling what coord:orient already returned) surfaces
 * without a manual audit. Each leg is read + graded by its own already
 * pure+unit-tested module (limit-failure-rate.ts / code-run-adoption.ts /
 * orient-dedup-rate.ts); this panel only folds their outputs.
 */
export interface ToolEfficiencyHealth {
  /** Metric #1 — too-long-string tool-arg validation failures, last 14d. */
  limitFailure: ToolEfficiencyRating & { totalErrs: number };
  /** Metric #2 — code:run/recipes:run adoption among batchable-opportunity spawns, last 7d. */
  codeRunAdoption: ToolEfficiencyRating & { adoptionRatePct: number | null };
  /** Metric #3 — of coord:orient spawns, % that also re-called a subsumed tool, last 24h. */
  orientDedup: ToolEfficiencyRating & { pctRedundant: number | null };
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
  loops: HealthPanel<LoopsHealth>;
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
  coordination: HealthPanel<CoordinationHealth>;
  overwatch: HealthPanel<OverwatchPanelHealth>;
  scout: HealthPanel<ScoutHealth>;
  memory: HealthPanel<MemoryPanelHealth>;
  toolEfficiency: HealthPanel<ToolEfficiencyHealth>;
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
  /** Panels excluded from `overall` by an active owner ack (P-004). */
  ackedCount?: number;
}
