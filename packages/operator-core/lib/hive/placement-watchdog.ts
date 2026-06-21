/**
 * placement-watchdog.ts — the COMPLETION GUARANTEE for the Queen hive loop
 * (queen-autonomous-execution-2026-06-13 B-09: P-020 / P-021 / P-022 / P-023).
 *
 * The liveness watchdog (./watchdog.ts) guarantees the QUEEN stays awake; THIS
 * module guarantees every unit she PLACES reaches a terminal state — it closes
 * the G3 gap ("steer, don't dispatch" + reactive: a dead/stalled bee was only
 * rediscovered on the next idle wake). It rides the same 30s routinesTick and is
 * a BACKSTOP, not a cadence: every check is a deterministic SQL read; the wake /
 * escalation it MAY fire is the exception path.
 *
 * The reconciliation, per started hive:
 *   - P-020 — for each Queen-placed unit, derive its serving bee's liveness from
 *     `spawned_agents` (status / heartbeat / last_output) and the unit's own
 *     status + `taken_by`. A NON-terminal unit whose serving bee is dead/stalled
 *     and is NOT re-claimed by a live bee fires ONE targeted recovery wake to the
 *     Queen (debounced) so she re-places it WITHOUT waiting for the next idle
 *     wake. The Queen still DISPOSES (re-place / drain / drop) — the watchdog only
 *     surfaces (P-023: completion, not micromanagement).
 *   - P-021 — the cursed-item circuit breaker: after N failed placements (mirrors
 *     the orchestrator worker-chunk-loop `replanStrikes` exhaustion-flip, default
 *     3) the unit flips `cursed` and is escalated to the owner (the D-011 Queue
 *     precursor) instead of re-placed forever.
 *   - P-022 — stranded-work resolution: a `failing`/`failed` blocker that gates
 *     ≥1 non-terminal downstream unit is escalated ONCE so the owner can resolve /
 *     deprecate it and un-gate the downstream.
 *
 * Durable state is `harness_shared.hive_placements` (mig 263) — the per-(hive,
 * work-item) completion ledger holding ONLY the failed-placement counter, the
 * disposition, and the debounce timers. Liveness itself is never mirrored (it is
 * re-derived every sweep — storage policy).
 *
 * Pure deciders (`deriveBeeLiveness`, `evaluatePlacement`) are split from the PG
 * sweep (`reconcileHivePlacements`) so the behavioral contract unit-tests with no
 * database — the same split as wake-frontier-guard.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';
import { placementOverride } from '../hive-control-policy';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { openEscalation, resolveEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { listStartedHives } from './started';

// ── vocabulary (the canonical work-item terminal + stuck states) ──────────────

/** A placed unit is DONE when its status is one of these (work-items.ts: the set
 *  that fires `work-item:done:<id>`). Both kind-family dialects included. */
const TERMINAL_UNIT_STATES = new Set(['passed', 'deprecated', 'resolved', 'closed']);
/** A blocker is STUCK (P-022) when stalled in the feature-family failure band. */
const STUCK_BLOCKER_STATES = new Set(['failing', 'failed']);
/** A bee spawn row in one of these is GONE (its claim/work is no longer live). */
const TERMINAL_SPAWN_STATES = new Set(['done', 'failed', 'cancelled', 'reaped']);

export function isUnitTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_UNIT_STATES.has(status);
}
export function isStuckBlockerState(status: string | null | undefined): boolean {
  return status != null && STUCK_BLOCKER_STATES.has(status);
}

/** The system actor that owns watchdog-fired escalations. */
const WATCHDOG_OWNER = 'system:hive-placement-watchdog';
const watchdogIdentity = { ownerId: WATCHDOG_OWNER } as unknown as AgentIdentity;

// ── tunables (env-overridable, like the liveness watchdog floor) ──────────────

export interface PlacementConfig {
  /** Failed placements before the cursed-item breaker trips (P-021). Mirrors the
   *  orchestrator `replanStrikes` default (3): two recovery wakes, then escalate. */
  breakerThreshold: number;
  /** Minimum gap between recovery wakes for the same stalled unit (debounce) — so
   *  a unit that stays stalled across many 30s ticks wakes the Queen at most once
   *  per window, not every tick. */
  recoveryDebounceMs: number;
  /** F-FIX-041 — the operator-dormancy grace window. The watchdog runs on the 30s
   *  routinesTick; if the gap since this hive's LAST sweep (max last_seen_at over its
   *  placements) exceeds this, the operator/bg-host was DORMANT in between (a frozen
   *  ticker, the EI-1873 session wedge, an overnight dormancy window) — so this is a
   *  post-dormancy RECOVERY sweep and every placement looks "lost" for an INFRA reason,
   *  not item-pathology. On such a sweep a loss is re-placed but counted toward the
   *  BOUNDED infra breaker (infraBreakerThreshold), not the pathology breaker. Far above
   *  the 30s cadence so a merely-slow tick never trips it. */
  dormancyGraceMs: number;
  /** F-FIX-041 — the BOUNDED infra-loss breaker threshold. Infra-attributed losses
   *  (operator dormancy + EI-1758 zombie bees that made 0 tool calls — a no-fair-attempt
   *  loss, NOT item-pathology) accrue in `infra_loss_count` and curse only here, far above
   *  the 3-strike pathology `breakerThreshold`. The BOUND is the safety property: even if a
   *  genuinely-wedging item's losses were all mis-attributed to infra, it still curses at
   *  this count (never the unbounded-retry of EI-865); a real infra outage gets this many
   *  graced re-places to heal. (A reaper-reclaim-WHILE-ACTIVE loss is exempt entirely —
   *  it has positive proof-of-life, see servingBeeReclaimedWhileActive — and never reaches
   *  this counter.) */
  infraBreakerThreshold: number;
}

export function placementConfig(): PlacementConfig {
  const threshold = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_BREAKER ?? 3);
  const debounce = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_DEBOUNCE_MS ?? 5 * 60_000);
  const dormancy = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_DORMANCY_MS ?? 10 * 60_000);
  const infra = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_INFRA_BREAKER ?? 12);
  return {
    breakerThreshold: Number.isFinite(threshold) && threshold >= 1 ? threshold : 3,
    recoveryDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5 * 60_000,
    dormancyGraceMs: Number.isFinite(dormancy) && dormancy >= 0 ? dormancy : 10 * 60_000,
    infraBreakerThreshold: Number.isFinite(infra) && infra >= 1 ? infra : 12,
    // live-configurability-audit P-015: overlay the runtime hive:control_policy override (empty ⇒ env defaults).
    ...placementOverride(),
  };
}

/**
 * EI-865 / WI-233 — a heartbeat-stale / reaper-reclaimed bee that made a governed
 * model call within this window of `now` was demonstrably ALIVE when it went stale
 * or was reclaimed: a SLOW-BUT-ALIVE false reclaim. Generously larger than the
 * reaper's RECLAIM_STALE_MS (5m) so a single long opus:xhigh call (or the WI-204
 * per-call PG overhead in a tight capability:bash loop) that starved the heartbeat
 * past the stale threshold still reads as active. A long model call emits NO stdout,
 * so `last_output_at` is no signal here — `agent_usage_samples` (one row per governed
 * model call) is. The reclaim of such a bee re-places the unit but does NOT count
 * toward the placement curse. Env-overridable like the other watchdog tunables. */
export const ACTIVE_RECLAIM_WINDOW_MS = (() => {
  const v = Number(process.env.PAPERCUSP_HIVE_ACTIVE_RECLAIM_WINDOW_MS ?? 15 * 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 15 * 60_000;
})();

/**
 * Did this spawn land in a terminal state via a REAPER RECLAIM (the P-011
 * orphan-reclaim sweep, or a wedge-reap) rather than a genuine non-zero EXIT? The
 * P-011 reaper stamps an `error_message` of `reclaimed: …` with status 'failed'; a
 * wedge-reap sets status 'reaped'. A genuine bee crash is status 'failed' carrying
 * the bee's OWN error (never a `reclaimed:` prefix); a clean finish is 'done'. Only
 * a reaper reclaim of a still-ALIVE bee is exempt from the placement curse (WI-233)
 * — a genuine crash still counts, so a truly bee-WEDGING item still trips the
 * breaker. Pure; exported for the decider unit tests. */
export function isReaperReclaim(status: string, errorMessage: string | null): boolean {
  if (status === 'reaped') return true;
  return status === 'failed' && errorMessage != null && errorMessage.startsWith('reclaimed:');
}

// ── P-020 pure decider 1: bee liveness from the durable spawn row ─────────────

export type BeeLiveness = 'live' | 'wedged' | 'dead';

export interface BeeLivenessInput {
  status: string;
  heartbeatAtMs: number | null;
  lastOutputAtMs: number | null;
  now: number;
}

/**
 * Derive a bee's liveness from its spawn row, reusing the fleet-reclaim
 * thresholds so the watchdog agrees with orphan-reclaim / wedge-reap:
 *   - terminal spawn status (done/failed/cancelled/reaped) → `dead`;
 *   - running but heartbeat stale beyond RECLAIM_STALE_MS → `dead` (orphaned host);
 *   - running, heartbeat fresh, but output silent beyond WEDGE_SILENT_MS → `wedged`;
 *   - otherwise → `live`.
 * A null heartbeat on a running bee is treated as `live` (freshly spawned, no
 * heartbeat tick yet — reclaim owns the true-orphan case).
 */
export function deriveBeeLiveness(input: BeeLivenessInput): BeeLiveness {
  if (TERMINAL_SPAWN_STATES.has(input.status)) return 'dead';
  const { heartbeatAtMs, lastOutputAtMs, now } = input;
  if (heartbeatAtMs != null && now - heartbeatAtMs > RECLAIM_STALE_MS) return 'dead';
  if (lastOutputAtMs != null && now - lastOutputAtMs > WEDGE_SILENT_MS) return 'wedged';
  return 'live';
}

// ── P-020/P-021 pure decider 2: what to do about one placement ────────────────

export interface PlacementObservation {
  workItemId: string;
  /** The unit row still exists. */
  unitExists: boolean;
  /** The unit reached a terminal state. */
  unitTerminal: boolean;
  /** A LIVE bee currently holds/serves this non-terminal unit (re-placement took,
   *  or the original is still working). */
  hasLiveHolder: boolean;
  /** Failed (item-pathology) placements already recorded for this unit (0 if never
   *  placed) — the 3-strike `breakerThreshold` counter. */
  failCount: number;
  /** F-FIX-041 — INFRA-attributed losses already recorded (operator dormancy / zombie
   *  bees) — the BOUNDED `infraBreakerThreshold` counter, kept separate from failCount so
   *  an infra outage doesn't trip the pathology breaker (0 if never placed). */
  infraLossCount: number;
  /** The existing placement row's status, or null if this is a new placement. */
  placementStatus: string | null;
  /** When the last recovery wake fired (debounce), ms epoch, or null. */
  lastRecoveryAtMs: number | null;
  /** EI-865 / WI-233 — the serving bee is a slow-but-ALIVE false reclaim: the
   *  watchdog reads it `dead` (heartbeat-stale, or P-011 reaper-reclaimed) yet it made
   *  a governed model call within {@link ACTIVE_RECLAIM_WINDOW_MS}, so it was
   *  demonstrably alive when it went stale / was reaped. A reclaim of such a bee
   *  re-places the unit but does NOT count toward the curse — only a genuine bee
   *  failure / wedge (no recent activity, or a non-zero exit) does. Default false. */
  servingBeeReclaimedWhileActive?: boolean;
  /** F-FIX-041 — the serving bee made ZERO tool calls (agent_activity kind='tool') across
   *  its whole life: a no-fair-attempt loss — an EI-1758 zombie (booted without MCP tools)
   *  or a bee that died before doing any work. The work-item never got a real attempt, so
   *  the loss is INFRA-induced, not evidence of item-pathology. Counted toward the BOUNDED
   *  infra breaker (not unbounded-exempt): the bound is what makes this per-bee signal safe
   *  — an item that genuinely crashes bees pre-tool-call ALSO shows 0 tool calls, so it must
   *  still eventually curse (at infraBreakerThreshold), never retry forever. Default false. */
  servingBeeMadeNoToolCalls?: boolean;
  /** F-FIX-041 — this sweep is a post-dormancy RECOVERY sweep: the gap since this
   *  hive's previous sweep exceeded the dormancy grace, so the operator/bg-host was
   *  down in between and a "lost" placement is INFRA-induced, not item-pathology.
   *  An ITEM-INDEPENDENT signal (computed from the watchdog's own run cadence, not
   *  per-bee) — an item cannot fake "the operator was dormant". Counted toward the
   *  BOUNDED infra breaker (infraBreakerThreshold), not the 3-strike pathology breaker.
   *  Default false. */
  postDormancySweep?: boolean;
  now: number;
}

export type PlacementDecision =
  | { kind: 'healthy' }
  | { kind: 'completed' }
  | { kind: 'recover'; nextFailCount: number; nextInfraLossCount: number; reason: string }
  | { kind: 'debounced' }
  | { kind: 'breaker'; nextFailCount: number; nextInfraLossCount: number; reason: string }
  | { kind: 'latched' }
  | { kind: 'abandon'; reason: string };

/**
 * The completion-guarantee contract for ONE placement (P-020 + P-021), pure:
 *   unit gone        → abandon
 *   unit terminal    → completed              (the placement succeeded)
 *   live holder      → healthy                (working / re-placement took)
 *   already cursed   → latched                (the breaker has tripped — HALT)
 *   else (failed)    → breaker | debounced | recover
 * `breaker` fires once the count AFTER this failure reaches the threshold, so the
 * unit is escalated rather than re-placed a (threshold+1)-th time.
 *
 * EI-865 — the breaker LATCHES. Once a unit is `cursed`, every later sweep
 * short-circuits to `latched`: NO re-fire, NO re-escalation, NO failCount bump.
 * Before this latch the `cursed` status fell through to the failed-placement path
 * every tick (the debounce only guards `recovering`), so the watchdog re-entered
 * `breaker`, re-escalated, and climbed failCount UNBOUNDED (observed 356→460 in a
 * night) while the Queen kept re-placing a doomed item. The latch is the early-out
 * that turns the breaker from a one-shot-that-re-fires into a true HALT. The unit
 * leaves the latch only when it reaches terminal (→ completed) or is re-placed and
 * worked by a live bee (→ healthy); a human/Queen who fixes + re-places it clears it.
 */
export function evaluatePlacement(obs: PlacementObservation, cfg: PlacementConfig): PlacementDecision {
  if (!obs.unitExists) return { kind: 'abandon', reason: 'unit no longer exists' };
  if (obs.unitTerminal) return { kind: 'completed' };
  if (obs.hasLiveHolder) return { kind: 'healthy' };

  // EI-865 — the cursed latch: a unit already tripped by the breaker is HALTED.
  // No live holder + not terminal + already cursed ⇒ leave it latched. Re-firing /
  // re-escalating here is exactly the unbounded-retry bug (failCount 356→460); the
  // breaker only halts for real if a cursed unit short-circuits before the failed
  // path. (terminal / live-holder above already clear the curse the moment it's
  // genuinely resolved or re-placed-and-working.)
  if (obs.placementStatus === 'cursed') return { kind: 'latched' };

  // Non-terminal unit with no live holder → this placement failed.
  // Debounce repeated wakes only while we are ALREADY mid-recovery for it.
  if (
    obs.placementStatus === 'recovering' &&
    obs.lastRecoveryAtMs != null &&
    obs.now - obs.lastRecoveryAtMs < cfg.recoveryDebounceMs
  ) {
    return { kind: 'debounced' };
  }

  // EI-865 / WI-233 — a reaper-reclaim of a STILL-ALIVE bee does NOT count toward the
  // curse. A slow-but-alive bee (a long opus:xhigh call, or WI-204's per-call PG
  // overhead in a tight capability:bash loop) goes heartbeat-stale and the P-011 reaper
  // reclaims it (spawn → failed), so this placement reads "no live holder + failed" —
  // but it was an INFRASTRUCTURE reclaim, not evidence the work-item is ill-specified or
  // wedges bees. Re-place it (it genuinely has no holder now), but keep fail_count FLAT
  // so a run of false reclaims never trips the breaker. Only a genuine failure — a
  // non-zero exit, or a reclaimed bee with NO recent model-call activity (actually
  // wedged/dead) — climbs toward the curse. Without this the whole papercup owner-focus
  // frontier (WI-214/217/218/219/220/231/232, F-FIX-*) false-cursed out of placement.
  if (obs.servingBeeReclaimedWhileActive) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // FLAT — proof-of-life: a slow-but-alive bee is genuinely working
      nextInfraLossCount: obs.infraLossCount, // and is fully exempt — never even the bounded infra counter
      reason: 'serving bee reaper-reclaimed while still active (slow-but-alive) — re-placing, not counting toward any breaker',
    };
  }

  // F-FIX-041 — an INFRA-induced loss with NO proof of a fair attempt: a post-dormancy
  // recovery sweep (operator/bg-host was down — item-INDEPENDENT) OR a no-fair-attempt
  // zombie (serving bee made 0 tool calls — EI-1758). Count it toward the BOUNDED infra
  // breaker, NOT the 3-strike pathology breaker, so an infra outage doesn't false-curse a
  // tractable item. The bound is the safety property: even if a genuinely-wedging item's
  // losses were all mis-attributed to infra (e.g. it crashes bees pre-tool-call, so it too
  // shows 0 tool calls), it STILL curses at infraBreakerThreshold — never the unbounded
  // retry of EI-865. (Ordered AFTER the cursed latch + debounce so a cursed item stays
  // latched and a mid-recovery wake is still debounced.)
  if (obs.postDormancySweep || obs.servingBeeMadeNoToolCalls) {
    const why = obs.postDormancySweep
      ? 'post-dormancy recovery sweep (operator/bg-host was down)'
      : 'serving bee made 0 tool calls (no-fair-attempt / zombie)';
    const nextInfraLossCount = obs.infraLossCount + 1;
    if (nextInfraLossCount >= cfg.infraBreakerThreshold) {
      return {
        kind: 'breaker',
        nextFailCount: obs.failCount, // the pathology count is untouched
        nextInfraLossCount,
        reason: `${nextInfraLossCount} infra-induced losses (>= infra breaker ${cfg.infraBreakerThreshold}) — ${why}`,
      };
    }
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // pathology count held FLAT — infra losses don't progress it
      nextInfraLossCount,
      reason: `infra-induced loss (${why}) — counted toward the bounded infra breaker, not the pathology breaker`,
    };
  }

  // A genuine item-pathology loss (a fair attempt that failed) → the 3-strike breaker.
  const nextFailCount = obs.failCount + 1;
  if (nextFailCount >= cfg.breakerThreshold) {
    return {
      kind: 'breaker',
      nextFailCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: `${nextFailCount} failed placements (>= breaker threshold ${cfg.breakerThreshold})`,
    };
  }
  return {
    kind: 'recover',
    nextFailCount,
    nextInfraLossCount: obs.infraLossCount,
    reason: 'serving bee dead/stalled and the unit is not terminal',
  };
}

// ── EI-1524/1518 pure decider: stale cursed/stranded escalation GC ────────────

/**
 * EI-1524 / EI-1518 — the backstop GC decider for a `cursed`/`stranded` placement
 * that still carries an OPEN advisory escalation.
 *
 * The candidate sweep ({@link evaluatePlacement}) only resolves a cursed escalation
 * when the item is STILL a placement candidate this tick — i.e. a live bee anchors
 * or holds it (`completed` path → {@link suppressCursedEscalation}). A cursed/stranded
 * item that later reaches terminal (or is retired) with NO live bee re-anchoring it
 * FALLS OUT of the candidate set, so its escalation is never closed — the root of the
 * ~13k stale-escalation residue (a curse-storm leaves one open escalation per failed
 * re-place attempt, and they never GC once the items go terminal). The breaker was
 * correct; the lifecycle had no closing edge for the no-live-holder case.
 *
 *   - escalation present + cursed/stranded + unit GONE      → resolve-abandoned
 *   - escalation present + cursed/stranded + unit TERMINAL  → resolve-completed
 *   - otherwise (still genuinely open, or not our concern)  → keep
 *
 * Pure; exported for the decider unit tests.
 */
export type StaleEscalationDecision = 'resolve-completed' | 'resolve-abandoned' | 'keep';

export interface StalePlacementEscalationObs {
  /** The placement row carries an escalation_msg_id (an open advisory). */
  hasEscalation: boolean;
  /** The placement's current status — only `cursed`/`stranded` are GC candidates. */
  placementStatus: string;
  /** The subject work-item row still exists. */
  unitExists: boolean;
  /** The subject work-item reached a terminal state. */
  unitTerminal: boolean;
}

export function evaluateStalePlacementEscalation(obs: StalePlacementEscalationObs): StaleEscalationDecision {
  if (!obs.hasEscalation) return 'keep';
  if (obs.placementStatus !== 'cursed' && obs.placementStatus !== 'stranded') return 'keep';
  if (!obs.unitExists) return 'resolve-abandoned';
  if (obs.unitTerminal) return 'resolve-completed';
  return 'keep';
}

// ── PG: the sweep ─────────────────────────────────────────────────────────────

export interface PlacementSweepResult {
  workspaceId: string;
  installSlug: string;
  workItemId: string;
  decision: PlacementDecision['kind'] | 'stranded' | 'unblocked';
  detail?: string;
}

interface BeeLite {
  spawnId: string;
  ownerId: string; // coord owner == work-item taken_by
  featureId: string | null;
  liveness: BeeLiveness;
  /** EI-865 / WI-233 — a slow-but-alive false reclaim (see ACTIVE_RECLAIM_WINDOW_MS):
   *  read `dead` (heartbeat-stale / reaper-reclaimed) but made a governed model call
   *  within the activity window, so it was alive when reclaimed. */
  reclaimedWhileActive: boolean;
  /** F-FIX-041 — the bee made ZERO native tool calls (agent_activity kind='tool') across
   *  its life: a no-fair-attempt zombie (EI-1758, or died before any work). When it's the
   *  dead serving bee on a non-terminal unit, the loss is infra (bounded infra breaker),
   *  not item-pathology. */
  madeNoToolCalls: boolean;
}

interface UnitRow {
  feature_id: string;
  harness_slug: string | null;
  status: string;
  taken_by: string | null;
}

interface PlacementRow {
  work_item_id: string;
  status: string;
  fail_count: number;
  /** F-FIX-041 — the bounded infra-loss counter (operator dormancy / zombie bees). */
  infra_loss_count: number;
  last_recovery_ms: number | null;
  escalation_msg_id: string | null;
  /** F-FIX-041 — last sweep time for this row (ms). max() over the hive ≈ the hive's
   *  previous sweep; a large gap to `now` means the operator was dormant in between. */
  last_seen_ms: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the hive's Queen coord-owner from its most-recent hive session — the
 *  recipient of recovery wakes, and the key bee spawns carry as parent_spawn_id. */
export async function resolveQueenOwner(sql: Sql, workspaceId: string, installSlug: string): Promise<string | null> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'hive · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0]?.coord_owner_id ?? null;
}

/** ALL Queen coord-owners that have served this hive (newest first). The Queen is
 *  fresh-per-wake (interactive brain) / adaptive-re-woken, so a single hive accrues
 *  several `hive · <slug>/queen` adv_sessions over its life; bees carry whichever
 *  owner was current at spawn time as `parent_spawn_id`. Attributing bees by ONLY
 *  the newest owner ({@link resolveQueenOwner}) orphans every bee placed by an
 *  earlier Queen-wake (their placements then never reach the ledger). The watchdog
 *  must discover bees across the WHOLE owner set; wakes/attribution still target the
 *  newest (the live Queen). */
export async function resolveQueenOwners(sql: Sql, workspaceId: string, installSlug: string): Promise<string[]> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT DISTINCT coord_owner_id, max(started_at) AS started_at
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'hive · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     GROUP BY coord_owner_id
     ORDER BY started_at DESC`;
  return rows.map((r) => r.coord_owner_id);
}

/** Upsert one placement row (the per-unit completion ledger). */
async function upsertPlacement(
  sql: Sql,
  p: {
    workspaceId: string;
    installSlug: string;
    workItemId: string;
    harnessSlug: string | null;
    queenOwnerId: string | null;
    beeSpawnId: string | null;
    beeOwnerId: string | null;
    status: string;
    failCount: number;
    /** F-FIX-041 — the bounded infra-loss counter. Defaults to 0 when omitted (a fresh
     *  placement); callers that touch the failed path pass decision.nextInfraLossCount. */
    infraLossCount?: number;
    disposition: string;
    escalationMsgId?: string | null;
    bumpRecovery?: boolean;
    now: number;
  },
): Promise<void> {
  // The org PG client (getOrgPg) rejects a raw JS Date bound to timestamptz —
  // it must receive an ISO string (cf. store-pg.ts; org-pg-client-rejects-raw-date).
  const recoveryAt = p.bumpRecovery ? new Date(p.now).toISOString() : null;
  await sql`
    INSERT INTO harness_shared.hive_placements
      (workspace_id, install_slug, work_item_id, harness_slug, queen_owner_id,
       bee_spawn_id, bee_owner_id, status, fail_count, infra_loss_count, last_disposition,
       escalation_msg_id, last_recovery_at, last_seen_at, updated_at)
    VALUES (
      ${p.workspaceId}, ${p.installSlug}, ${p.workItemId}, ${p.harnessSlug}, ${p.queenOwnerId},
      ${p.beeSpawnId}, ${p.beeOwnerId}, ${p.status}, ${p.failCount}, ${p.infraLossCount ?? 0}, ${p.disposition},
      ${p.escalationMsgId ?? null}, ${recoveryAt}, ${new Date(p.now).toISOString()}, ${new Date(p.now).toISOString()}
    )
    ON CONFLICT (workspace_id, install_slug, work_item_id) DO UPDATE SET
      harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.hive_placements.harness_slug),
      queen_owner_id    = COALESCE(EXCLUDED.queen_owner_id, harness_shared.hive_placements.queen_owner_id),
      bee_spawn_id      = COALESCE(EXCLUDED.bee_spawn_id, harness_shared.hive_placements.bee_spawn_id),
      bee_owner_id      = COALESCE(EXCLUDED.bee_owner_id, harness_shared.hive_placements.bee_owner_id),
      status            = EXCLUDED.status,
      fail_count        = EXCLUDED.fail_count,
      infra_loss_count  = EXCLUDED.infra_loss_count,
      last_disposition  = EXCLUDED.last_disposition,
      escalation_msg_id = COALESCE(EXCLUDED.escalation_msg_id, harness_shared.hive_placements.escalation_msg_id),
      last_recovery_at  = COALESCE(EXCLUDED.last_recovery_at, harness_shared.hive_placements.last_recovery_at),
      last_seen_at      = EXCLUDED.last_seen_at,
      updated_at        = EXCLUDED.updated_at`;
}

/**
 * The sweep's external effects, as an injectable seam (defaults to the real
 * impls — the routine caller passes none). Lets the orchestration (flag gate,
 * started-hive iteration, per-hive isolation, aggregation) be unit-tested
 * without PG; reconcileOneHive's own SQL stays integration-tested separately.
 */
export interface ReconcileSweepDeps {
  getFlag: typeof getFlag;
  listStartedHives: typeof listStartedHives;
  getOrgPg: typeof getOrgPg;
  reconcileOneHive: typeof reconcileOneHive;
}

/** Reconcile EVERY started hive's placements. Fail-soft; never throws. */
export async function reconcileHivePlacements(
  opts: { now?: number; deps?: Partial<ReconcileSweepDeps> } = {},
): Promise<PlacementSweepResult[]> {
  const results: PlacementSweepResult[] = [];
  const getFlagFn = opts.deps?.getFlag ?? getFlag;
  const listStartedHivesFn = opts.deps?.listStartedHives ?? listStartedHives;
  const getOrgPgFn = opts.deps?.getOrgPg ?? getOrgPg;
  const reconcileOneHiveFn = opts.deps?.reconcileOneHive ?? reconcileOneHive;
  try {
    if (!(await getFlagFn(FLAGS.HIVE_PLACEMENT_WATCHDOG, 'system'))) return results;
    const started = await listStartedHivesFn();
    if (started.length === 0) return results;
    const { sql } = getOrgPgFn();
    const now = opts.now ?? Date.now();
    const cfg = placementConfig();
    for (const { workspaceId, installSlug } of started) {
      try {
        results.push(...(await reconcileOneHiveFn(sql, workspaceId, installSlug, cfg, now)));
      } catch (e) {
        console.warn(
          `[hive-placement-watchdog] hive ${installSlug} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[hive-placement-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/** Reconcile ONE hive's placements against `sql` (injected so it integration-tests
 *  with a test DB). Resolves the Queen owner, derives each placed unit's holder
 *  liveness, and applies the P-020/P-021/P-022 decisions. Exported for the
 *  integration test + the P-051 invariant test. */
export async function reconcileOneHive(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  cfg: PlacementConfig,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  // ALL Queen-owners that served this hive (a fresh-per-wake / re-woken Queen accrues
  // several); bees are discovered across the whole set, but the NEWEST is the live
  // Queen we attribute to + wake. Without any resolvable owner we can neither attribute
  // bees to this hive nor target a recovery wake — leave it to the next sweep (the hive
  // may not have run yet). The liveness watchdog still keeps the Queen armed.
  const queenOwners = await resolveQueenOwners(sql, workspaceId, installSlug);
  if (queenOwners.length === 0) return out;
  const queenOwner = queenOwners[0]; // newest — wake target + attribution

  // 1. This hive's bees (placement targets carry SOME Queen-owner as parent — match
  //    the full owner set so an earlier-wake's bees aren't orphaned from the ledger).
  const beeRows = await sql<
    {
      spawn_id: string;
      session_owner: string | null;
      feature_id: string | null;
      status: string;
      heartbeat_ms: number | null;
      last_output_ms: number | null;
      run_id: string | null;
      error_message: string | null;
    }[]
  >`
    SELECT spawn_id, session_owner, feature_id, status, run_id, error_message,
           extract(epoch from heartbeat_at) * 1000 AS heartbeat_ms,
           extract(epoch from last_output_at) * 1000 AS last_output_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = 'bee'
       AND parent_spawn_id = ANY(${queenOwners})`;

  // EI-865 / WI-233 — which bees made a governed model call within ACTIVE_RECLAIM_WINDOW_MS
  // (agent_usage_samples, keyed by the spawn's run_id). This is the liveness signal that a
  // heartbeat-stale / reaper-reclaimed bee was actually SLOW-BUT-ALIVE: a long model call
  // emits no stdout (so last_output_at is useless) but DOES write a usage sample. A reclaim
  // of such a bee must not count toward the placement curse. The `ts >= now - window` bound
  // keeps this on the (workspace_id, ts DESC) index — a few minutes of recent samples.
  const beeRunIds = [...new Set(beeRows.map((b) => b.run_id).filter((r): r is string => !!r))];
  const activeRunIds = new Set<string>();
  if (beeRunIds.length > 0) {
    const activeRows = await sql<{ run_id: string }[]>`
      SELECT DISTINCT run_id
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${workspaceId}
         AND run_id = ANY(${beeRunIds})
         AND ts >= ${now - ACTIVE_RECLAIM_WINDOW_MS}`;
    for (const r of activeRows) if (r.run_id) activeRunIds.add(r.run_id);
  }

  // F-FIX-041 — the zombie signal: which bee OWNERS made ≥1 native tool call (agent_activity
  // kind='tool'). A serving bee with ZERO tool calls never got a fair attempt at its item
  // (an EI-1758 zombie booted without MCP tools, or died before any work), so its loss is
  // infra (the BOUNDED infra breaker), not item-pathology. Keyed by owner_id == session_owner.
  const beeActivityOwners = [...new Set(beeRows.map((b) => b.session_owner || b.spawn_id))];
  const ownersWithToolCalls = new Set<string>();
  if (beeActivityOwners.length > 0) {
    const toolRows = await sql<{ owner_id: string }[]>`
      SELECT DISTINCT owner_id
        FROM harness_shared.agent_activity
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ANY(${beeActivityOwners})
         AND kind = 'tool'`;
    for (const r of toolRows) ownersWithToolCalls.add(r.owner_id);
  }

  const beeByOwner = new Map<string, BeeLite>();
  for (const b of beeRows) {
    const ownerId = b.session_owner || b.spawn_id;
    const recentlyActive = b.run_id != null && activeRunIds.has(b.run_id);
    const bee: BeeLite = {
      spawnId: b.spawn_id,
      ownerId,
      featureId: b.feature_id,
      liveness: deriveBeeLiveness({
        status: b.status,
        heartbeatAtMs: num(b.heartbeat_ms),
        lastOutputAtMs: num(b.last_output_ms),
        now,
      }),
      // Slow-but-alive false reclaim: recent model-call activity AND the bee is either
      // only heartbeat-stale (still running/restarting, the reaper has not run yet) or
      // was reaper-reclaimed (not a genuine crash). A genuine non-zero exit (status
      // 'failed' with the bee's OWN error) is excluded, so a bee-wedging item still curses.
      reclaimedWhileActive:
        recentlyActive &&
        (b.status === 'running' || b.status === 'restarting' || isReaperReclaim(b.status, b.error_message)),
      // F-FIX-041 — no native tool call across this bee's life ⇒ no fair attempt (zombie).
      madeNoToolCalls: !ownersWithToolCalls.has(ownerId),
    };
    // Index by both owner and spawn id so a unit's taken_by resolves either way.
    beeByOwner.set(ownerId, bee);
    beeByOwner.set(b.spawn_id, bee);
  }
  const beeOwners = [...new Set(beeRows.map((b) => b.session_owner || b.spawn_id))];

  // 2. Candidate placed units: each bee's spawn-anchored unit ∪ units a bee holds
  //    (warm-inject). One fetch resolves every candidate's current row.
  const candidateIds = new Set<string>();
  for (const b of beeRows) if (b.feature_id) candidateIds.add(b.feature_id);
  if (beeOwners.length > 0) {
    const claimed = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND taken_by = ANY(${beeOwners})`;
    for (const r of claimed) candidateIds.add(r.feature_id);
  }

  // Existing placement ledger rows for this hive (the durable counters).
  const placeRows = await sql<PlacementRow[]>`
    SELECT work_item_id, status, fail_count, infra_loss_count,
           extract(epoch from last_recovery_at) * 1000 AS last_recovery_ms,
           escalation_msg_id,
           extract(epoch from last_seen_at) * 1000 AS last_seen_ms
      FROM harness_shared.hive_placements
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}`;
  const placeById = new Map<string, PlacementRow>(placeRows.map((p) => [p.work_item_id, p]));

  // F-FIX-041 — operator-dormancy detection (item-INDEPENDENT). The watchdog runs on the
  // 30s routinesTick; the most-recent last_seen_at over this hive's placements is its
  // PREVIOUS sweep. If the gap to `now` exceeds the dormancy grace, the operator/bg-host
  // was DORMANT in between (frozen ticker / session wedge / overnight dormancy), so every
  // placement "lost" for an infra reason, not item-pathology — this sweep grants the
  // grace (losses recover FLAT, not toward the curse). One flag per sweep (operator-wide
  // state), not per bee — an item cannot fake it. A hive with no prior placements
  // (maxLastSeenMs 0) is never post-dormancy (nothing to false-count; failCount starts 0).
  const maxLastSeenMs = placeRows.reduce((m, p) => Math.max(m, num(p.last_seen_ms) ?? 0), 0);
  const postDormancySweep = maxLastSeenMs > 0 && now - maxLastSeenMs > cfg.dormancyGraceMs;

  if (candidateIds.size > 0) {
    const ids = [...candidateIds];
    const unitRows = await sql<UnitRow[]>`
      SELECT feature_id, harness_slug, status, taken_by
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
    const unitById = new Map<string, UnitRow>(unitRows.map((u) => [u.feature_id, u]));

    for (const unitId of ids) {
      const unit = unitById.get(unitId);
      const existing = placeById.get(unitId);

      // Serving bee = the unit's current holder, or the bee whose spawn placed it.
      const holder = unit?.taken_by ? beeByOwner.get(unit.taken_by) : undefined;
      const anchor = beeRows.find((b) => b.feature_id === unitId);
      const anchorBee = anchor ? beeByOwner.get(anchor.session_owner || anchor.spawn_id) : undefined;
      const servingBee = holder ?? anchorBee;
      const hasLiveHolder = holder?.liveness === 'live' || anchorBee?.liveness === 'live';
      // WI-233 — only meaningful when there is no live holder (the failed path): was the
      // serving bee a slow-but-alive false reclaim rather than a genuine failure?
      const servingBeeReclaimedWhileActive =
        !hasLiveHolder && (holder?.reclaimedWhileActive === true || anchorBee?.reclaimedWhileActive === true);
      // F-FIX-041 — likewise only on the failed path: did the serving bee make 0 tool calls
      // (a no-fair-attempt zombie)? Feeds the bounded infra breaker, not the pathology one.
      const servingBeeMadeNoToolCalls =
        !hasLiveHolder && (holder?.madeNoToolCalls === true || anchorBee?.madeNoToolCalls === true);

      const obs: PlacementObservation = {
        workItemId: unitId,
        unitExists: Boolean(unit),
        unitTerminal: isUnitTerminal(unit?.status),
        hasLiveHolder,
        failCount: existing?.fail_count ?? 0,
        infraLossCount: existing?.infra_loss_count ?? 0,
        placementStatus: existing?.status ?? null,
        lastRecoveryAtMs: existing?.last_recovery_ms ?? null,
        servingBeeReclaimedWhileActive,
        servingBeeMadeNoToolCalls, // F-FIX-041 — zombie (no-fair-attempt) → bounded infra breaker
        postDormancySweep, // F-FIX-041 — operator-dormancy grace (item-independent, per-sweep)
        now,
      };
      const decision = evaluatePlacement(obs, cfg);

      const base = {
        workspaceId,
        installSlug,
        workItemId: unitId,
        harnessSlug: unit?.harness_slug ?? null,
        queenOwnerId: queenOwner,
        beeSpawnId: servingBee?.spawnId ?? null,
        beeOwnerId: servingBee?.ownerId ?? null,
        now,
      };

      switch (decision.kind) {
        case 'healthy':
          await upsertPlacement(sql, {
            ...base,
            status: 'working',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            disposition: 'working',
          });
          break;
        case 'completed':
          if (existing?.status !== 'completed') {
            // EI-972 — suppress any cursed-placement escalation for this item since
            // it has now reached a terminal state and is no longer cursed.
            if (existing?.escalation_msg_id) {
              await suppressCursedEscalation(existing.escalation_msg_id, unitId);
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'completed',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              disposition: 'completed',
            });
            out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'completed' });
            // P-032 — EDGE RESOLUTION: a completed lane that gated downstream work
            // has just un-gated it (its `blocks` edges resolve). Fire ONE Queen wake
            // so she surveys + places the now-ready next-wave batch — the wave
            // ordering executing through edge resolution, replacing the hand-rolled
            // pair-emit `:done` events (queen-wave-dispatch D-006). The survey applies
            // the precise readiness gate; we only wake when there IS non-terminal
            // downstream this lane blocks. Fires once (guarded by the status transition).
            if (base.harnessSlug) {
              const downstream = await countNonTerminalDownstream(sql, workspaceId, base.harnessSlug, unitId);
              if (downstream > 0) {
                await fireUnblockWake(workspaceId, queenOwner, unitId, base.harnessSlug, downstream);
                out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'unblocked', detail: `${downstream} downstream` });
              }
            }
          }
          break;
        case 'recover':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: decision.nextFailCount,
            infraLossCount: decision.nextInfraLossCount,
            disposition: 'recover',
            bumpRecovery: true,
          });
          await fireRecoveryWake(workspaceId, queenOwner, unitId, base.harnessSlug, decision.nextFailCount);
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'recover',
            detail: `attempt ${decision.nextFailCount}`,
          });
          break;
        case 'breaker': {
          const msgId = await escalateCursedPlacement(unitId, base.harnessSlug, decision.nextFailCount);
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: decision.nextFailCount,
            infraLossCount: decision.nextInfraLossCount,
            disposition: 'breaker',
            escalationMsgId: msgId,
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'breaker',
            detail: decision.reason,
          });
          break;
        }
        case 'latched':
          // EI-865 — the breaker has tripped and the unit is still cursed: HALT.
          // Refresh last_seen_at (the row stays observable in hive:status) but do
          // NOT re-fire, NOT re-escalate (escalation_msg_id is preserved), and do
          // NOT bump fail_count — the latch holds it steady at the breaker count.
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            disposition: 'breaker',
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'latched',
            detail: `cursed, halted (fail_count ${obs.failCount} frozen)`,
          });
          break;
        case 'debounced':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            disposition: 'recover',
          });
          break;
        case 'abandon':
          if (existing && existing.status !== 'abandoned' && existing.status !== 'completed') {
            await upsertPlacement(sql, {
              ...base,
              status: 'abandoned',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              disposition: 'abandoned',
            });
          }
          break;
      }
    }
  }

  // 3. P-022 — stranded-work resolution: stuck blockers gating downstream work.
  out.push(...(await reconcileStrandedWork(sql, workspaceId, installSlug, queenOwner, placeById, now)));

  // 4. EI-1524/1518 — backstop escalation GC: close cursed/stranded advisories
  //    whose subject item went terminal/gone with no live bee re-anchoring it
  //    (the candidate sweep above never revisits those, so they would leak).
  out.push(...(await reconcileStalePlacementEscalations(sql, workspaceId, installSlug, now)));
  return out;
}

/** P-020 — fire ONE targeted recovery wake to the Queen so she re-places the
 *  stalled unit without waiting for the next idle wake. Best-effort: a woken:0
 *  (Queen has no armed wake) degrades to "she sees the recovering row in
 *  hive:status on her next natural turn"; the liveness watchdog keeps her armed. */
async function fireRecoveryWake(
  workspaceId: string,
  queenOwner: string,
  unitId: string,
  harness: string | null,
  attempt: number,
): Promise<void> {
  try {
    await wakeRecipients([queenOwner], {
      summary:
        `Placement watchdog: work-item ${unitId}${harness ? ` (${harness})` : ''} is not terminal but its ` +
        `bee is dead/stalled (placement attempt ${attempt}) — re-place or recover it.`,
      payload: { kind: 'placement-recovery', workItemId: unitId, harness, attempt },
      source: 'hive-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[hive-placement-watchdog] recovery wake failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
  }
}

/** P-032 — count the NON-TERMINAL downstream features that `blockerId` (in `harness`)
 *  gates via a `blocks` edge: the lanes a completion may have just un-gated. Mirrors
 *  reconcileStrandedWork's edge query (the single `coord_links rel='blocks'` source of
 *  truth, D-007), with the blocker as edge SOURCE and live downstream as the target. */
async function countNonTerminalDownstream(
  sql: Sql,
  workspaceId: string,
  harness: string,
  blockerId: string,
): Promise<number> {
  const rows = await sql<{ downstream: number }[]>`
    SELECT count(*)::int AS downstream
      FROM harness_shared.coord_links l
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.dst_ref, '#', 1)
       AND d.feature_id   = split_part(l.dst_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'feature'
       AND l.dst_kind = 'feature'
       AND l.src_ref = ${`${harness}#${blockerId}`}
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})`;
  return rows[0]?.downstream ?? 0;
}

/** P-032 — a completed lane that gated downstream work fires ONE Queen wake so she
 *  surveys + places the now-unblocked next-wave batch. The wave ordering executing
 *  through edge resolution — replacing the hand-rolled pair-emit `:done` events
 *  (queen-wave-dispatch D-006). Best-effort: a woken:0 (no armed wake) degrades to
 *  the Queen seeing the freed lanes in her next natural hive:survey. */
async function fireUnblockWake(
  workspaceId: string,
  queenOwner: string,
  completedId: string,
  harness: string | null,
  downstream: number,
): Promise<void> {
  try {
    await wakeRecipients([queenOwner], {
      summary:
        `Placement watchdog: ${completedId}${harness ? ` (${harness})` : ''} completed and un-gated ` +
        `${downstream} downstream lane(s) — survey + place the next wave batch.`,
      payload: { kind: 'placement-unblocked', workItemId: completedId, harness, downstream },
      source: 'hive-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[hive-placement-watchdog] unblock wake failed for ${completedId}: ${e instanceof Error ? e.message : e}`);
  }
}

/** P-021 — route a cursed unit to the owner escalation queue (the D-011 Queue
 *  precursor). Returns the escalation msg_id (or null on failure). */
async function escalateCursedPlacement(unitId: string, harness: string | null, fails: number): Promise<string | null> {
  try {
    const rec = await openEscalation(watchdogIdentity, {
      // advisory, not blocker: the watchdog has ALREADY stopped auto-re-placing —
      // this is an FYI to investigate, not a decision blocking the system. blocker
      // here (+ surfacing every cursed placement) flooded "waiting on you" with
      // ~7000 option-less ops escalations (queue-pending-accuracy D-005). The
      // reader demotes system escalations to the alert tier regardless; this keeps
      // the stored severity/importance honest too. The derived placements.cursed
      // health metric is the real cursed-state surface.
      severity: 'advisory',
      summary: `Cursed placement: ${unitId} failed ${fails}× — stopped auto-re-placing`,
      body:
        `Work-item ${unitId}${harness ? ` (${harness})` : ''} has been placed and lost ${fails} times without ` +
        `reaching a terminal state. Per the cursed-item circuit breaker (queen-autonomous-execution B-09 / P-021) ` +
        `the Queen has STOPPED auto-re-placing it. Investigate it (ill-specified? wedging bees?) then re-place, ` +
        `deprecate, or split it. Re-placing clears the breaker when it next completes.`,
    });
    return rec.msg_id;
  } catch (e) {
    console.warn(`[hive-placement-watchdog] cursed escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Resolve a watchdog-owned placement escalation (cursed / stranded advisory).
 *  The ONE close path — shared by the per-candidate suppression (EI-972) and the
 *  backstop GC (EI-1524). Best-effort; never throws. */
async function resolvePlacementEscalation(escalationMsgId: string, unitId: string, note: string): Promise<void> {
  if (!escalationMsgId) return;
  try {
    await resolveEscalation({
      msg_id: escalationMsgId,
      choice: 'item-now-terminal',
      resolver: WATCHDOG_OWNER,
      note,
    });
  } catch (e) {
    console.warn(
      `[hive-placement-watchdog] resolving placement escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** EI-972 — suppress/auto-resolve a cursed-placement escalation when the work
 *  item reaches a terminal state (passed, resolved, etc.). Best-effort; never throws. */
async function suppressCursedEscalation(escalationMsgId: string, unitId: string): Promise<void> {
  await resolvePlacementEscalation(
    escalationMsgId,
    unitId,
    `auto-resolved: work-item ${unitId} reached terminal state, cursed advisory is no longer relevant`,
  );
}

/**
 * EI-1524 / EI-1518 — the backstop escalation GC sweep. The per-candidate
 * suppression only fires while a live bee anchors the item; a cursed/stranded
 * item that later reaches terminal (or is retired) with NO live holder falls out
 * of the candidate set and keeps its advisory escalation OPEN forever — the root
 * of the ~13k stale-escalation residue. This sweep runs every tick over the
 * hive's `cursed`/`stranded` placements that still carry an escalation, and for
 * any whose subject work-item is now terminal (→ completed) or gone (→ abandoned),
 * resolves the escalation and flips the placement out of the open set. Bounded:
 * only escalation-carrying cursed/stranded rows are read (few — the breaker only
 * trips on genuinely stuck items), and a still-open item is left untouched.
 * Fail-soft; one row's failure never aborts the sweep.
 */
async function reconcileStalePlacementEscalations(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const staleRows = await sql<
    { work_item_id: string; status: string; escalation_msg_id: string | null; harness_slug: string | null; fail_count: number }[]
  >`
    SELECT work_item_id, status, escalation_msg_id, harness_slug, fail_count
      FROM harness_shared.hive_placements
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND status IN ('cursed', 'stranded')
       AND escalation_msg_id IS NOT NULL`;
  if (staleRows.length === 0) return out;

  // Current unit status for each, keyed by feature_id within the workspace (the
  // same key the candidate sweep uses — see the unitById map above).
  const ids = [...new Set(staleRows.map((r) => r.work_item_id))];
  const unitRows = await sql<{ feature_id: string; status: string }[]>`
    SELECT feature_id, status
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
  const unitStatusById = new Map<string, string>(unitRows.map((u) => [u.feature_id, u.status]));

  for (const r of staleRows) {
    const unitStatus = unitStatusById.get(r.work_item_id);
    const decision = evaluateStalePlacementEscalation({
      hasEscalation: Boolean(r.escalation_msg_id),
      placementStatus: r.status,
      unitExists: unitStatus != null,
      unitTerminal: isUnitTerminal(unitStatus),
    });
    if (decision === 'keep') continue;

    const terminal = decision === 'resolve-completed';
    await resolvePlacementEscalation(
      r.escalation_msg_id!,
      r.work_item_id,
      terminal
        ? `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} reached terminal state (${unitStatus}); the ${r.status} advisory is no longer relevant`
        : `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} no longer exists; the ${r.status} advisory is no longer relevant`,
    );
    // Flip the placement out of the open (cursed/stranded) set so hive:status +
    // summarizeOpenPlacements stop counting it. queen/bee fields are preserved
    // (COALESCE keeps the existing values on null).
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: r.work_item_id,
      harnessSlug: r.harness_slug,
      queenOwnerId: null,
      beeSpawnId: null,
      beeOwnerId: null,
      status: terminal ? 'completed' : 'abandoned',
      failCount: r.fail_count,
      disposition: terminal ? 'completed' : 'abandoned',
      now,
    });
    out.push({
      workspaceId,
      installSlug,
      workItemId: r.work_item_id,
      decision: terminal ? 'completed' : 'abandon',
      detail: `gc: stale ${r.status} escalation auto-resolved (unit ${terminal ? unitStatus : 'gone'})`,
    });
  }
  return out;
}

/**
 * P-022 — a `failing`/`failed` feature blocker that gates ≥1 non-terminal
 * downstream feature is escalated ONCE so the owner can resolve/deprecate it and
 * un-gate the downstream. Dedupe: a hive_placements row for the blocker in
 * `stranded`/`cursed` with an escalation already recorded suppresses re-escalation
 * (the breaker escalation also covers a stuck blocker that is itself cursed).
 * v1 covers feature→feature block edges (the primary case); issue-blocker
 * stranding is a follow-on.
 */
async function reconcileStrandedWork(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  queenOwner: string,
  placeById: Map<string, PlacementRow>,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const blockers = await sql<
    { blocker_id: string; blocker_harness: string; blocker_status: string; downstream: number }[]
  >`
    SELECT b.feature_id AS blocker_id, b.harness_slug AS blocker_harness, b.status AS blocker_status,
           count(*)::int AS downstream
      FROM harness_shared.coord_links l
      JOIN harness_shared.harness_features_consolidated b
        ON b.workspace_id = ${workspaceId}
       AND b.harness_slug = split_part(l.src_ref, '#', 1)
       AND b.feature_id   = split_part(l.src_ref, '#', 2)
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.dst_ref, '#', 1)
       AND d.feature_id   = split_part(l.dst_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'feature'
       AND l.dst_kind = 'feature'
       AND b.status = ANY(${[...STUCK_BLOCKER_STATES]})
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})
     GROUP BY b.feature_id, b.harness_slug, b.status`;

  for (const blk of blockers) {
    const existing = placeById.get(blk.blocker_id);
    // Already escalated (stranded earlier, or cursed by the breaker) → skip.
    if (existing && existing.escalation_msg_id && (existing.status === 'stranded' || existing.status === 'cursed')) {
      continue;
    }
    let msgId: string | null = null;
    try {
      const rec = await openEscalation(watchdogIdentity, {
        severity: 'blocker',
        summary: `Stuck blocker ${blk.blocker_id} is stranding ${blk.downstream} downstream work-item(s)`,
        body:
          `Blocker ${blk.blocker_id} (${blk.blocker_harness}) is ${blk.blocker_status} and gating ` +
          `${blk.downstream} non-terminal downstream work-item(s) — they cannot proceed until it resolves. ` +
          `Resolve, deprecate, or re-place the blocker to un-gate the downstream work. ` +
          `(queen-autonomous-execution B-09 / P-022)`,
      });
      msgId = rec.msg_id;
    } catch (e) {
      console.warn(`[hive-placement-watchdog] stranded escalation failed for ${blk.blocker_id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: blk.blocker_id,
      harnessSlug: blk.blocker_harness,
      queenOwnerId: queenOwner,
      beeSpawnId: null,
      beeOwnerId: null,
      status: 'stranded',
      failCount: existing?.fail_count ?? 0,
      infraLossCount: existing?.infra_loss_count ?? 0, // preserve — stranded is a different concern
      disposition: 'stranded',
      escalationMsgId: msgId,
      now,
    });
    out.push({ workspaceId, installSlug, workItemId: blk.blocker_id, decision: 'stranded', detail: `${blk.downstream} downstream` });
  }
  return out;
}

/** Open placements needing the Queen's attention — surfaced in hive:status so she
 *  acts on recoveries/cursed/stranded each wake (P-020/P-023: completion). */
export interface OpenPlacementSummary {
  recovering: number;
  cursed: number;
  stranded: number;
  workingTracked: number;
  items: Array<{ workItemId: string; status: string; failCount: number; harness: string | null }>;
}

export async function summarizeOpenPlacements(
  workspaceId: string,
  installSlug: string,
  limit = 20,
): Promise<OpenPlacementSummary> {
  const empty: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ work_item_id: string; status: string; fail_count: number; harness_slug: string | null }[]>`
      SELECT work_item_id, status, fail_count, harness_slug
        FROM harness_shared.hive_placements
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
         AND status IN ('recovering', 'cursed', 'stranded', 'working')
       ORDER BY (status = 'cursed') DESC, (status = 'stranded') DESC, (status = 'recovering') DESC, updated_at DESC
       LIMIT ${limit}`;
    const summary = { ...empty, items: [] as OpenPlacementSummary['items'] };
    for (const r of rows) {
      if (r.status === 'recovering') summary.recovering++;
      else if (r.status === 'cursed') summary.cursed++;
      else if (r.status === 'stranded') summary.stranded++;
      else if (r.status === 'working') summary.workingTracked++;
      if (r.status !== 'working') {
        summary.items.push({ workItemId: r.work_item_id, status: r.status, failCount: r.fail_count, harness: r.harness_slug });
      }
    }
    return summary;
  } catch {
    return empty;
  }
}

/** The Queen's MOST-RECENT real wake for a hive — the max `started_at` of her
 *  `spawned_agents` queen rows (child_role='queen', harness = the hive slug). The
 *  `hive.controlState` heartbeat reads this so the wake-brain Queen (which never
 *  calls `recordHiveWake`) still shows "Running" when she actually wakes, instead of
 *  a permanent "Paused/Stalled" off the stale recordHiveWake ledger (the owner's
 *  "I relaunched the app but still can't see her running" regression). ISO or null;
 *  best-effort (never throws). */
export async function latestQueenWakeAt(workspaceId: string, hiveSlug: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ t: string | Date | null }[]>`
      SELECT max(started_at) AS t
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId}
         AND child_role = 'queen'
         AND harness_slug = ${hiveSlug}`;
    const t = rows[0]?.t;
    return t ? new Date(t).toISOString() : null;
  } catch {
    return null;
  }
}
