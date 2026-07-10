/**
 * placement-watchdog.ts — the COMPLETION GUARANTEE for the Mug pot loop
 * (queen-autonomous-execution-2026-06-13 B-09: P-020 / P-021 / P-022 / P-023).
 *
 * The liveness watchdog (./watchdog.ts) guarantees the MUG stays awake; THIS
 * module guarantees every unit she PLACES reaches a terminal state — it closes
 * the G3 gap ("steer, don't dispatch" + reactive: a dead/stalled cup was only
 * rediscovered on the next idle wake). It rides the same 30s routinesTick and is
 * a BACKSTOP, not a cadence: every check is a deterministic SQL read; the wake /
 * escalation it MAY fire is the exception path.
 *
 * The reconciliation, per started pot:
 *   - P-020 — for each Mug-placed unit, derive its serving cup's liveness from
 *     `spawned_agents` (status / heartbeat / last_output) and the unit's own
 *     status + `taken_by`. A NON-terminal unit whose serving cup is dead/stalled
 *     and is NOT re-claimed by a live cup fires ONE targeted recovery wake to the
 *     Mug (debounced) so she re-places it WITHOUT waiting for the next idle
 *     wake. The Mug still DISPOSES (re-place / drain / drop) — the watchdog only
 *     surfaces (P-023: completion, not micromanagement).
 *   - P-021 — the cursed-item circuit breaker: after N failed placements (mirrors
 *     the orchestrator worker-chunk-loop `replanStrikes` exhaustion-flip, default
 *     3) the unit flips `cursed` and is escalated to the owner (the D-011 Queue
 *     precursor) instead of re-placed forever.
 *   - P-022 — stranded-work resolution: a `failing`/`failed` blocker that gates
 *     ≥1 non-terminal downstream unit is escalated ONCE so the owner can resolve /
 *     deprecate it and un-gate the downstream.
 *
 * Durable state is `harness_shared.pot_placements` (mig 263) — the per-(pot,
 * work-item) completion ledger holding ONLY the failed-placement counter, the
 * disposition, and the debounce timers. Liveness itself is never mirrored (it is
 * re-derived every sweep — storage policy).
 *
 * Pure deciders (`deriveCupLiveness`, `evaluatePlacement`) are split from the PG
 * sweep (`reconcilePotPlacements`) so the behavioral contract unit-tests with no
 * database — the same split as wake-frontier-guard.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';
import { placementOverride } from '../pot-control-policy';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { openEscalation, resolveEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { liveHolderFragment, STALE_CLAIM_GRACE_MS } from '../work-items-stale-claims';
import { listStartedPots } from './started';

// ── vocabulary (the canonical work-item terminal + stuck states) ──────────────

/** A placed unit is DONE when its status is one of these (work-items.ts: the set
 *  that fires `work-item:done:<id>`). Both kind-family dialects included. */
const TERMINAL_UNIT_STATES = new Set(['passed', 'deprecated', 'resolved', 'closed']);
/** A blocker is STUCK (P-022) when stalled in the feature-family failure band. */
const STUCK_BLOCKER_STATES = new Set(['failing', 'failed']);
/** A cup spawn row in one of these is GONE (its claim/work is no longer live). */
const TERMINAL_SPAWN_STATES = new Set(['done', 'failed', 'cancelled', 'reaped']);
/** A placed unit's OWN status is a deliberate park (work-item-dispatch-states.ts:
 *  FEATURE_NON_REQUEUE_STATES treats `blocked` AND `needs-human` the same way — "a
 *  deliberate [owner] park … never auto-requeued". `needs-human` was added to that
 *  sibling reaper set on 2026-07-03 (fleet-scheduler-hardening-2026-07-03 P-004,
 *  WI-1774/WI-1775) but was never mirrored here (EI-6563) — so a unit an owner
 *  parked `needs-human` kept getting treated as a failed placement: the Mug fired
 *  a recovery wake + a fresh cup every debounce window forever (observed live on
 *  WI-369, the same churn class WI-1439's `blocked` fix above targets). Distinct
 *  from STUCK_BLOCKER_STATES above, which is about a unit BLOCKING downstream
 *  work, not a unit that IS itself parked. */
const UNIT_PARKED_STATES = new Set(['blocked', 'needs-human']);
/** EI-6650 — the brief-facing "open placements" summary independently re-derives
 *  "is this unit still active" from `harness_features_consolidated.status`, rather
 *  than trusting `pot_placements.status` (which the reconcile-side isUnitParked fix
 *  above already stops re-flagging as `recovering`). Existing rows placed BEFORE that
 *  fix — or ones reconcileOnePot simply hasn't revisited since (it only reconciles
 *  units with a recent cup-spawn event, not a periodic full sweep) — sit frozen at
 *  `recovering` in the DB (observed live: WI-329/341/356/357/359/360/369/371/372/1439,
 *  stuck `recovering` since 2026-07-03 with zero reconcile activity since). Excluding
 *  UNIT_PARKED_STATES here too (in addition to TERMINAL_UNIT_STATES) means the Mug
 *  brief's "Placements — drive to terminal / re-place NOW" list stops telling her to
 *  re-place a unit a human/owner has deliberately parked, regardless of whether the
 *  underlying placement row has caught up yet. */
// EI-7641: also consumed by wake-frontier-guard.ts's listNonTerminalPlacements,
// which hit the exact same staleness this comment describes — the P-030
// "non-terminal placements" guard trusted pot_placements.status alone (never
// joining the live unit), so a wake-frontier refusal listed ids whose WORK ITEM
// had long since gone terminal/deprecated or been parked blocked/needs-human,
// forcing every no-time Mug wake to force:true past a stale placement list.
export const SUMMARY_INACTIVE_UNIT_STATES = [...TERMINAL_UNIT_STATES, ...UNIT_PARKED_STATES];

export function isUnitTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_UNIT_STATES.has(status);
}
export function isStuckBlockerState(status: string | null | undefined): boolean {
  return status != null && STUCK_BLOCKER_STATES.has(status);
}
/** WI-1439 recovery-churn fix — is the placed unit itself deliberately parked
 *  (`blocked` or `needs-human` — owner/human-gated), so a dead/absent cup is
 *  EXPECTED, not a failure? */
export function isUnitParked(status: string | null | undefined): boolean {
  return status != null && UNIT_PARKED_STATES.has(status);
}

/** The system actor that owns watchdog-fired escalations. */
const WATCHDOG_OWNER = 'system:pot-placement-watchdog';
const watchdogIdentity = { ownerId: WATCHDOG_OWNER } as unknown as AgentIdentity;

// ── tunables (env-overridable, like the liveness watchdog floor) ──────────────

export interface PlacementConfig {
  /** Failed placements before the cursed-item breaker trips (P-021). Mirrors the
   *  orchestrator `replanStrikes` default (3): two recovery wakes, then escalate. */
  breakerThreshold: number;
  /** Minimum gap between recovery wakes for the same stalled unit (debounce) — so
   *  a unit that stays stalled across many 30s ticks wakes the Mug at most once
   *  per window, not every tick. */
  recoveryDebounceMs: number;
  /** F-FIX-041 — the operator-dormancy grace window. The watchdog runs on the 30s
   *  routinesTick; if the gap since this pot's LAST sweep (max last_seen_at over its
   *  placements) exceeds this, the operator/bg-host was DORMANT in between (a frozen
   *  ticker, the EI-1873 session wedge, an overnight dormancy window) — so this is a
   *  post-dormancy RECOVERY sweep and every placement looks "lost" for an INFRA reason,
   *  not item-pathology. On such a sweep a loss is re-placed but counted toward the
   *  BOUNDED infra breaker (infraBreakerThreshold), not the pathology breaker. Far above
   *  the 30s cadence so a merely-slow tick never trips it. */
  dormancyGraceMs: number;
  /** F-FIX-041 — the BOUNDED infra-loss breaker threshold. Infra-attributed losses
   *  (operator dormancy + EI-1758 zombie cups that made 0 tool calls — a no-fair-attempt
   *  loss, NOT item-pathology) accrue in `infra_loss_count` and curse only here, far above
   *  the 3-strike pathology `breakerThreshold`. The BOUND is the safety property: even if a
   *  genuinely-wedging item's losses were all mis-attributed to infra, it still curses at
   *  this count (never the unbounded-retry of EI-865); a real infra outage gets this many
   *  graced re-places to heal. (A reaper-reclaim-WHILE-ACTIVE loss is exempt entirely —
   *  it has positive proof-of-life, see servingCupReclaimedWhileActive — and never reaches
   *  this counter.) */
  infraBreakerThreshold: number;
}

export function placementConfig(): PlacementConfig {
  const threshold = Number(process.env.PAPERCUSP_POT_PLACEMENT_BREAKER ?? process.env.PAPERCUSP_POT_PLACEMENT_BREAKER ?? 3);
  const debounce = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_DEBOUNCE_MS ?? process.env.PAPERCUSP_POT_PLACEMENT_DEBOUNCE_MS ?? 5 * 60_000,
  );
  const dormancy = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_DORMANCY_MS ?? process.env.PAPERCUSP_POT_PLACEMENT_DORMANCY_MS ?? 10 * 60_000,
  );
  const infra = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_INFRA_BREAKER ?? process.env.PAPERCUSP_POT_PLACEMENT_INFRA_BREAKER ?? 12,
  );
  return {
    breakerThreshold: Number.isFinite(threshold) && threshold >= 1 ? threshold : 3,
    recoveryDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5 * 60_000,
    dormancyGraceMs: Number.isFinite(dormancy) && dormancy >= 0 ? dormancy : 10 * 60_000,
    infraBreakerThreshold: Number.isFinite(infra) && infra >= 1 ? infra : 12,
    // live-configurability-audit P-015: overlay the runtime pot:control_policy override (empty ⇒ env defaults).
    ...placementOverride(),
  };
}

/**
 * EI-865 / WI-233 — a heartbeat-stale / reaper-reclaimed cup that made a governed
 * model call within this window of `now` was demonstrably ALIVE when it went stale
 * or was reclaimed: a SLOW-BUT-ALIVE false reclaim. Generously larger than the
 * reaper's RECLAIM_STALE_MS (5m) so a single long opus:xhigh call (or the WI-204
 * per-call PG overhead in a tight capability:bash loop) that starved the heartbeat
 * past the stale threshold still reads as active. A long model call emits NO stdout,
 * so `last_output_at` is no signal here — `agent_usage_samples` (one row per governed
 * model call) is. The reclaim of such a cup re-places the unit but does NOT count
 * toward the placement curse. Env-overridable like the other watchdog tunables. */
export const ACTIVE_RECLAIM_WINDOW_MS = (() => {
  const v = Number(
    process.env.PAPERCUSP_POT_ACTIVE_RECLAIM_WINDOW_MS ?? process.env.PAPERCUSP_POT_ACTIVE_RECLAIM_WINDOW_MS ?? 15 * 60_000,
  );
  return Number.isFinite(v) && v >= 0 ? v : 15 * 60_000;
})();

/**
 * Did this spawn land in a terminal state via a REAPER RECLAIM (the P-011
 * orphan-reclaim sweep, or a wedge-reap) rather than a genuine non-zero EXIT? The
 * P-011 reaper stamps an `error_message` of `reclaimed: …` with status 'failed'; a
 * wedge-reap sets status 'reaped'. A genuine cup crash is status 'failed' carrying
 * the cup's OWN error (never a `reclaimed:` prefix); a clean finish is 'done'. Only
 * a reaper reclaim of a still-ALIVE cup is exempt from the placement curse (WI-233)
 * — a genuine crash still counts, so a truly cup-WEDGING item still trips the
 * breaker. Pure; exported for the decider unit tests. */
export function isReaperReclaim(status: string, errorMessage: string | null): boolean {
  if (status === 'reaped') return true;
  return status === 'failed' && errorMessage != null && errorMessage.startsWith('reclaimed:');
}

// ── P-020 pure decider 1: cup liveness from the durable spawn row ─────────────

export type CupLiveness = 'live' | 'wedged' | 'dead';

export interface CupLivenessInput {
  status: string;
  heartbeatAtMs: number | null;
  lastOutputAtMs: number | null;
  now: number;
}

/**
 * Derive a cup's liveness from its spawn row, reusing the fleet-reclaim
 * thresholds so the watchdog agrees with orphan-reclaim / wedge-reap:
 *   - terminal spawn status (done/failed/cancelled/reaped) → `dead`;
 *   - running but heartbeat stale beyond RECLAIM_STALE_MS → `dead` (orphaned host);
 *   - running, heartbeat fresh, but output silent beyond WEDGE_SILENT_MS → `wedged`;
 *   - otherwise → `live`.
 * A null heartbeat on a running cup is treated as `live` (freshly spawned, no
 * heartbeat tick yet — reclaim owns the true-orphan case).
 */
export function deriveCupLiveness(input: CupLivenessInput): CupLiveness {
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
  /** A LIVE cup currently holds/serves this non-terminal unit (re-placement took,
   *  or the original is still working). */
  hasLiveHolder: boolean;
  /** Failed (item-pathology) placements already recorded for this unit (0 if never
   *  placed) — the 3-strike `breakerThreshold` counter. */
  failCount: number;
  /** F-FIX-041 — INFRA-attributed losses already recorded (operator dormancy / zombie
   *  cups) — the BOUNDED `infraBreakerThreshold` counter, kept separate from failCount so
   *  an infra outage doesn't trip the pathology breaker (0 if never placed). */
  infraLossCount: number;
  /** The existing placement row's status, or null if this is a new placement. */
  placementStatus: string | null;
  /** When the last recovery wake fired (debounce), ms epoch, or null. */
  lastRecoveryAtMs: number | null;
  /** WI-677 round 2 — is there a SERVING CUP at all (a holder or an anchor spawn in the
   *  cup window)? A recovering item the Mug has not re-placed yet has NONE — that is
   *  not a failed attempt, so the sweep must re-place-wake WITHOUT counting. Before
   *  this, every debounce expiry charged fail_count on a cup-less recovering item and
   *  an un-cursed frontier re-cursed at 3 strikes in ~12 minutes with zero new cups
   *  (observed live 2026-07-02 00:27). */
  hasServingCup?: boolean;
  /** The serving cup's spawn id (when present) — compared against lastLossSpawnId. */
  servingCupSpawnId?: string | null;
  /** The spawn id whose loss was last COUNTED for this placement (mig 440), or null.
   *  Same id again ⇒ the corpse was already counted: re-place only, counters flat. */
  lastLossSpawnId?: string | null;
  /** EI-865 / WI-233 — the serving cup is a slow-but-ALIVE false reclaim: the
   *  watchdog reads it `dead` (heartbeat-stale, or P-011 reaper-reclaimed) yet it made
   *  a governed model call within {@link ACTIVE_RECLAIM_WINDOW_MS}, so it was
   *  demonstrably alive when it went stale / was reaped. A reclaim of such a cup
   *  re-places the unit but does NOT count toward the curse — only a genuine cup
   *  failure / wedge (no recent activity, or a non-zero exit) does. Default false. */
  servingCupReclaimedWhileActive?: boolean;
  /** F-FIX-041 — the serving cup made ZERO tool calls (agent_activity kind='tool') across
   *  its whole life: a no-fair-attempt loss — an EI-1758 zombie (booted without MCP tools)
   *  or a cup that died before doing any work. The work-item never got a real attempt, so
   *  the loss is INFRA-induced, not evidence of item-pathology. Counted toward the BOUNDED
   *  infra breaker (not unbounded-exempt): the bound is what makes this per-cup signal safe
   *  — an item that genuinely crashes cups pre-tool-call ALSO shows 0 tool calls, so it must
   *  still eventually curse (at infraBreakerThreshold), never retry forever. Default false. */
  servingCupMadeNoToolCalls?: boolean;
  /** F-FIX-041 / WI-677 — this sweep is a post-dormancy RECOVERY sweep: the gap since
   *  this pot's previous sweep exceeded the dormancy grace, so the operator/bg-host was
   *  down in between and a "lost" placement is INFRA-induced, not item-pathology. An
   *  ITEM-INDEPENDENT signal (computed from the watchdog's own run cadence, not per-cup)
   *  — an item cannot fake "the operator was dormant", and an operator-wide outage can
   *  never BE item-pathology. So it is FULLY EXEMPT: keeps BOTH counters flat and never
   *  curses (WI-677 — F-FIX-041 wrongly counted it toward the bounded infra breaker, so a
   *  host restart cursed the whole frontier in lockstep at infraBreakerThreshold). Only
   *  the per-item zombie signal below keeps the bounded breaker. Default false. */
  postDormancySweep?: boolean;
  /** WI-1439 recovery-churn fix — the unit's OWN status is a deliberate park
   *  (`isUnitParked`, e.g. `blocked` or `needs-human` for an owner/human-gated
   *  step — EI-6563). A parked unit is EXPECTED to have no live holder — that is
   *  not a failed placement, so it must never enter the recover/breaker path
   *  (which fired a Mug recovery wake
   *  + re-placed a fresh cup every debounce window FOREVER on a unit no cup can
   *  ever close, observed live on WI-1439: a new cup roughly every 5-40min for
   *  days, each one independently re-confirming the same owner-gate and dying).
   *  Default false. */
  unitParked?: boolean;
  now: number;
}

export type PlacementDecision =
  | { kind: 'healthy' }
  | { kind: 'completed' }
  | { kind: 'parked'; reason: string }
  | { kind: 'recover'; nextFailCount: number; nextInfraLossCount: number; reason: string; infraAttributed?: boolean }
  | { kind: 'debounced' }
  | { kind: 'breaker'; nextFailCount: number; nextInfraLossCount: number; reason: string; infraAttributed?: boolean }
  | { kind: 'latched' }
  | { kind: 'abandon'; reason: string };

/**
 * EI-3216 — `infraAttributed` marks a recover/breaker whose loss is an
 * ITEM-INDEPENDENT INFRA condition (an operator-dormancy sweep, or a no-fair-attempt
 * zombie cup that made 0 tool calls — typically the whole fleet booting cups without
 * MCP, or no cups spawning at all), NOT item-pathology. The Mug/owner cannot fix
 * such a loss by re-placing or investigating THIS item (a re-place just makes another
 * zombie), so:
 *   - an infra `recover` does NOT fire a per-item Mug recovery wake, and
 *   - an infra `breaker` curse does NOT open a per-item owner escalation.
 * The placement is still re-placed / recorded `cursed` (the `placements.cursed` health
 * metric + pot:status are the real cursed-state surface); only the per-item NOISE is
 * suppressed. Without this, a fleet-wide no-cups window cursed the whole frontier at
 * `fail_count=0, infra_loss_count=12`, flooding the queue with "failed 0×" advisories
 * and waking the Mug every ~5min to do nothing actionable. A genuine item-pathology
 * curse (a cup that RAN and failed `breakerThreshold` times) is NOT infra-attributed —
 * it still wakes + escalates with its real (non-zero) count.
 */

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
 * night) while the Mug kept re-placing a doomed item. The latch is the early-out
 * that turns the breaker from a one-shot-that-re-fires into a true HALT. The unit
 * leaves the latch only when it reaches terminal (→ completed) or is re-placed and
 * worked by a live cup (→ healthy); a human/Mug who fixes + re-places it clears it.
 */
export function evaluatePlacement(obs: PlacementObservation, cfg: PlacementConfig): PlacementDecision {
  if (!obs.unitExists) return { kind: 'abandon', reason: 'unit no longer exists' };
  if (obs.unitTerminal) return { kind: 'completed' };
  if (obs.hasLiveHolder) return { kind: 'healthy' };

  // WI-1439 recovery-churn fix — a deliberately PARKED unit (isUnitParked, e.g.
  // `blocked` for an owner/human-gated step) is EXPECTED to have no live holder.
  // Checked BEFORE the cursed latch / debounce / breaker paths so a parked unit
  // never enters ANY of them: no recovery wake, no counter bump, no escalation —
  // it has its own delegator-notify signal path (mirrors FEATURE_NON_REQUEUE_STATES
  // treating `blocked` as non-requeueable). Without this, the watchdog fired a
  // Mug recovery wake for a parked unit every debounce window forever, each wake
  // re-placing a fresh cup that could only re-confirm the same gate and die —
  // observed live on WI-1439 (a new cup every ~5-40min for days).
  if (obs.unitParked) return { kind: 'parked', reason: 'unit status is a deliberate park (e.g. blocked) — no holder expected' };

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

  // EI-865 / WI-233 — a reaper-reclaim of a STILL-ALIVE cup does NOT count toward the
  // curse. A slow-but-alive cup (a long opus:xhigh call, or WI-204's per-call PG
  // overhead in a tight capability:bash loop) goes heartbeat-stale and the P-011 reaper
  // reclaims it (spawn → failed), so this placement reads "no live holder + failed" —
  // but it was an INFRASTRUCTURE reclaim, not evidence the work-item is ill-specified or
  // wedges cups. Re-place it (it genuinely has no holder now), but keep fail_count FLAT
  // so a run of false reclaims never trips the breaker. Only a genuine failure — a
  // non-zero exit, or a reclaimed cup with NO recent model-call activity (actually
  // wedged/dead) — climbs toward the curse. Without this the whole papercup owner-focus
  // frontier (WI-214/217/218/219/220/231/232, F-FIX-*) false-cursed out of placement.
  if (obs.servingCupReclaimedWhileActive) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // FLAT — proof-of-life: a slow-but-alive cup is genuinely working
      nextInfraLossCount: obs.infraLossCount, // and is fully exempt — never even the bounded infra counter
      reason: 'serving cup reaper-reclaimed while still active (slow-but-alive) — re-placing, not counting toward any breaker',
    };
  }

  // WI-677 — a post-dormancy recovery sweep (operator/bg-host was DOWN) is an
  // ITEM-INDEPENDENT infra loss: it is computed from the watchdog's OWN run cadence,
  // not from anything about this item, so an item can never fake it AND it can never be
  // mis-attributed pathology. FULLY EXEMPT — keep BOTH counters flat, never curse (same
  // class as servingCupReclaimedWhileActive's proof-of-life). The F-FIX-041 bug was
  // counting THIS signal toward the bounded infra breaker: a host restart fires it for
  // EVERY placement in LOCKSTEP, so a string of restarts/dormancy windows climbs all of
  // them to infraBreakerThreshold together and curses the whole frontier at once (the
  // 31-item place_batch deadlock this fixes — all rows were fail_count=0, infra=12). The
  // bound's safety rationale ("eventually curses even if mis-attributed") only holds for a
  // PER-ITEM signal that COULD be pathology; an operator-wide outage is not that, so
  // counting it is a pure false-positive generator. A genuinely-doomed item still curses
  // via the 3-strike pathology breaker (cups that RUN and fail) or the bounded zombie
  // breaker below (cups that crash pre-tool-call) — neither of which a dormant operator
  // masks. (Ordered AFTER the cursed latch + debounce, BEFORE the zombie path so a sweep
  // that is both dormant AND zombie attributes to the item-independent cause.)
  if (obs.postDormancySweep) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // FLAT — the operator being down says nothing about the item
      nextInfraLossCount: obs.infraLossCount, // FLAT — fully exempt, never accrues toward any breaker
      // EI-3216 — item-independent infra: re-place silently, do NOT wake the Mug per item
      // (a host restart fires this for EVERY placement in lockstep — that's a 32-wake storm).
      infraAttributed: true,
      reason:
        'post-dormancy recovery sweep (operator/bg-host was down) — item-independent infra loss, ' +
        'fully exempt from both breakers (re-placing, not counting)',
    };
  }

  // F-FIX-041 — a no-fair-attempt zombie (serving cup made 0 tool calls across its life —
  // an EI-1758 zombie booted without MCP tools, or a cup that died before any work). UNLIKE
  // post-dormancy this IS a per-item signal that COULD be item-pathology (an item that
  // crashes cups pre-tool-call ALSO shows 0 tool calls), so it CANNOT be fully exempted
  // without risking the EI-865 unbounded-retry bug. Count it toward the BOUNDED infra
  // breaker, NOT the 3-strike pathology breaker: a tractable item lost to a string of
  // zombies gets infraBreakerThreshold graced re-places, but the BOUND guarantees even an
  // all-zombie-attributed wedging item STILL curses (never unbounded). (place_batch then
  // still RE-PLACES a fail_count-0 zombie-curse on the Mug's deliberate path — see
  // loadCursedWorkItemIds — so a fixed-infra item is never permanently deadlocked; the
  // bound here only halts the watchdog's autonomous recovery-wake storm.)
  // WI-677 round 2 — count losses per ATTEMPT, never per sweep. (a) No serving cup at
  // all: the Mug simply has not re-placed yet (or the corpse aged out of the spawn
  // window) — there is no attempt to judge, so re-place-wake with BOTH counters flat.
  // (b) The serving cup's spawn id equals the last COUNTED loss (mig 440): this corpse
  // was already charged — recounting it every recoveryDebounce expiry is exactly how an
  // un-cursed frontier re-cursed at fail_count=3 in ~12 minutes with ZERO new cups
  // (observed live 2026-07-02 00:27; EI-865's latch fixed this recount for `cursed`
  // but not `recovering`).
  if (obs.hasServingCup === false) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: 'no serving-cup attempt since the last loss — re-place only, nothing to count',
    };
  }
  if (
    obs.servingCupSpawnId != null &&
    obs.lastLossSpawnId != null &&
    obs.servingCupSpawnId === obs.lastLossSpawnId
  ) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: `dead attempt ${obs.servingCupSpawnId} already counted — re-place only`,
    };
  }

  if (obs.servingCupMadeNoToolCalls) {
    const nextInfraLossCount = obs.infraLossCount + 1;
    if (nextInfraLossCount >= cfg.infraBreakerThreshold) {
      return {
        kind: 'breaker',
        nextFailCount: obs.failCount, // the pathology count is untouched
        nextInfraLossCount,
        // EI-3216 — an infra/zombie curse (fail_count=0) records `cursed` but does NOT open a
        // per-item owner escalation: the breaker tripped on cup-boot infra, not item-pathology,
        // so a "failed 0× — stopped auto-re-placing" advisory is pure queue noise the owner
        // can't act on per item. The placements.cursed health metric is the real surface.
        infraAttributed: true,
        reason: `${nextInfraLossCount} no-fair-attempt (zombie) losses (>= infra breaker ${cfg.infraBreakerThreshold}) — serving cup made 0 tool calls`,
      };
    }
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // pathology count held FLAT — a zombie loss doesn't progress it
      nextInfraLossCount,
      // EI-3216 — re-place silently: a no-fair-attempt zombie loss is infra, not item-pathology,
      // so it does NOT fire a per-item Mug recovery wake (re-placing makes another zombie).
      infraAttributed: true,
      reason: 'serving cup made 0 tool calls (no-fair-attempt / zombie) — counted toward the bounded infra breaker, not the pathology breaker',
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
    reason: 'serving cup dead/stalled and the unit is not terminal',
  };
}

// ── EI-1524/1518 pure decider: stale cursed/stranded escalation GC ────────────

/**
 * EI-1524 / EI-1518 — the backstop GC decider for a `cursed`/`stranded` placement
 * that still carries an OPEN advisory escalation.
 *
 * The candidate sweep ({@link evaluatePlacement}) only resolves a cursed escalation
 * when the item is STILL a placement candidate this tick — i.e. a live cup anchors
 * or holds it (`completed` path → {@link suppressCursedEscalation}). A cursed/stranded
 * item that later reaches terminal (or is retired) with NO live cup re-anchoring it
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
  // The terminal/gone verdict is the same for every open status — reuse the general
  // decider so the escalation GC and the completion GC can never diverge (EI-6109).
  return evaluateTerminalPlacementReconcile({
    placementStatus: obs.placementStatus,
    unitExists: obs.unitExists,
    unitTerminal: obs.unitTerminal,
  });
}

// ── EI-6109 pure decider: completion-reconcile GC over ALL open placements ─────

/** The non-terminal (OPEN) placement statuses the completion GC reconciles. A
 *  placement in one of these is still tracked as in-flight; once its subject unit
 *  reaches terminal / is retired, the durable row must converge to completed /
 *  abandoned so pot:status, summarizeOpenPlacements, and loadCursedWorkItemIds
 *  stop counting a lane whose work has actually finished. */
export const OPEN_PLACEMENT_STATES = new Set(['working', 'recovering', 'cursed', 'stranded']);

export interface TerminalPlacementObs {
  /** The placement's current status — only OPEN statuses are reconcile candidates. */
  placementStatus: string;
  /** The subject work-item row still exists. */
  unitExists: boolean;
  /** The subject work-item reached a terminal state. */
  unitTerminal: boolean;
}

/**
 * EI-6109 — the completion-reconcile decider, generalizing the EI-1524 escalation GC
 * beyond `cursed`/`stranded`-with-escalation. A placement in ANY open status
 * (working / recovering / cursed / stranded) whose subject unit has reached terminal —
 * or been retired — must converge to completed / abandoned. This is the closing edge
 * the per-candidate sweep and the escalation-only GC together left uncovered:
 *   • a `working`/`recovering` row is never revisited once its serving cup dies /
 *     ages out of the candidate set (nothing re-anchors it), and
 *   • an infra-attributed `cursed`/`stranded` row carries NO escalation_msg_id, so the
 *     escalation-only GC (which required escalation_msg_id IS NOT NULL) skipped it.
 * Both left the durable pot_placements accounting DRIFTING after the work completed
 * or the cup died — pot:status reporting cursed/working lanes long since done.
 *
 *   OPEN + unit GONE      → resolve-abandoned
 *   OPEN + unit TERMINAL  → resolve-completed
 *   otherwise (still open, or not an open status) → keep
 * Only ever fires for a terminal/gone unit, so it NEVER robs a genuinely in-flight
 * lane (a non-terminal unit is always kept for the candidate sweep). Pure; exported
 * for the decider unit tests.
 */
export function evaluateTerminalPlacementReconcile(obs: TerminalPlacementObs): StaleEscalationDecision {
  if (!OPEN_PLACEMENT_STATES.has(obs.placementStatus)) return 'keep';
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

interface CupLite {
  spawnId: string;
  ownerId: string; // coord owner == work-item taken_by
  featureId: string | null;
  liveness: CupLiveness;
  /** EI-865 / WI-233 — a slow-but-alive false reclaim (see ACTIVE_RECLAIM_WINDOW_MS):
   *  read `dead` (heartbeat-stale / reaper-reclaimed) but made a governed model call
   *  within the activity window, so it was alive when reclaimed. */
  reclaimedWhileActive: boolean;
  /** F-FIX-041 — the cup made ZERO native tool calls (agent_activity kind='tool') across
   *  its life: a no-fair-attempt zombie (EI-1758, or died before any work). When it's the
   *  dead serving cup on a non-terminal unit, the loss is infra (bounded infra breaker),
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
  /** F-FIX-041 — the bounded infra-loss counter (operator dormancy / zombie cups). */
  infra_loss_count: number;
  last_recovery_ms: number | null;
  /** WI-677 round 2 (mig 440) — the dead attempt (cup spawn id) whose loss was last
   *  COUNTED, so a sweep never recounts the same corpse (fail_count = attempts, not
   *  sweeps). */
  last_loss_spawn_id: string | null;
  escalation_msg_id: string | null;
  /** F-FIX-041 — last sweep time for this row (ms). max() over the pot ≈ the pot's
   *  previous sweep; a large gap to `now` means the operator was dormant in between. */
  last_seen_ms: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the pot's Mug coord-owner from its most-recent pot session — the
 *  recipient of recovery wakes, and the key cup spawns carry as parent_spawn_id. */
export async function resolveMugOwner(sql: Sql, workspaceId: string, installSlug: string): Promise<string | null> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'pot · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0]?.coord_owner_id ?? null;
}

/** ALL Mug coord-owners that have served this pot (newest first). The Mug is
 *  fresh-per-wake (interactive brain) / adaptive-re-woken, so a single pot accrues
 *  several `pot · <slug>/mug` adv_sessions over its life; cups carry whichever
 *  owner was current at spawn time as `parent_spawn_id`. Attributing cups by ONLY
 *  the newest owner ({@link resolveMugOwner}) orphans every cup placed by an
 *  earlier Mug-wake (their placements then never reach the ledger). The watchdog
 *  must discover cups across the WHOLE owner set; wakes/attribution still target the
 *  newest (the live Mug). */
export async function resolveMugOwners(sql: Sql, workspaceId: string, installSlug: string): Promise<string[]> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT DISTINCT coord_owner_id, max(started_at) AS started_at
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'pot · ' + installSlug + '/%'}
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
    mugOwnerId: string | null;
    cupSpawnId: string | null;
    cupOwnerId: string | null;
    status: string;
    failCount: number;
    /** F-FIX-041 — the bounded infra-loss counter. Defaults to 0 when omitted (a fresh
     *  placement); callers that touch the failed path pass decision.nextInfraLossCount. */
    infraLossCount?: number;
    disposition: string;
    /** WI-677 r2 (mig 440) — the value to persist for last_loss_spawn_id: the counted
     *  attempt's spawn id, the preserved prior value, or null (fresh lineage). Always
     *  written explicitly (no COALESCE) so healthy/completed can CLEAR it. */
    lastLossSpawnId: string | null;
    escalationMsgId?: string | null;
    bumpRecovery?: boolean;
    now: number;
  },
): Promise<void> {
  // The org PG client (getOrgPg) rejects a raw JS Date bound to timestamptz —
  // it must receive an ISO string (cf. store-pg.ts; org-pg-client-rejects-raw-date).
  const recoveryAt = p.bumpRecovery ? new Date(p.now).toISOString() : null;
  await sql`
    INSERT INTO harness_shared.pot_placements
      (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
       cup_spawn_id, cup_owner_id, status, fail_count, infra_loss_count, last_loss_spawn_id, last_disposition,
       escalation_msg_id, last_recovery_at, last_seen_at, updated_at)
    VALUES (
      ${p.workspaceId}, ${p.installSlug}, ${p.workItemId}, ${p.harnessSlug}, ${p.mugOwnerId},
      ${p.cupSpawnId}, ${p.cupOwnerId}, ${p.status}, ${p.failCount}, ${p.infraLossCount ?? 0}, ${p.lastLossSpawnId}, ${p.disposition},
      ${p.escalationMsgId ?? null}, ${recoveryAt}, ${new Date(p.now).toISOString()}, ${new Date(p.now).toISOString()}
    )
    ON CONFLICT (workspace_id, install_slug, work_item_id) DO UPDATE SET
      harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.pot_placements.harness_slug),
      mug_owner_id    = COALESCE(EXCLUDED.mug_owner_id, harness_shared.pot_placements.mug_owner_id),
      cup_spawn_id      = COALESCE(EXCLUDED.cup_spawn_id, harness_shared.pot_placements.cup_spawn_id),
      cup_owner_id      = COALESCE(EXCLUDED.cup_owner_id, harness_shared.pot_placements.cup_owner_id),
      status            = EXCLUDED.status,
      fail_count        = EXCLUDED.fail_count,
      infra_loss_count  = EXCLUDED.infra_loss_count,
      last_loss_spawn_id = EXCLUDED.last_loss_spawn_id,
      last_disposition  = EXCLUDED.last_disposition,
      escalation_msg_id = COALESCE(EXCLUDED.escalation_msg_id, harness_shared.pot_placements.escalation_msg_id),
      last_recovery_at  = COALESCE(EXCLUDED.last_recovery_at, harness_shared.pot_placements.last_recovery_at),
      last_seen_at      = EXCLUDED.last_seen_at,
      updated_at        = EXCLUDED.updated_at`;
}

/**
 * The sweep's external effects, as an injectable seam (defaults to the real
 * impls — the routine caller passes none). Lets the orchestration (flag gate,
 * started-pot iteration, per-pot isolation, aggregation) be unit-tested
 * without PG; reconcileOnePot's own SQL stays integration-tested separately.
 */
export interface ReconcileSweepDeps {
  getFlag: typeof getFlag;
  listStartedPots: typeof listStartedPots;
  getOrgPg: typeof getOrgPg;
  reconcileOnePot: typeof reconcileOnePot;
}

/** Reconcile EVERY started pot's placements. Fail-soft; never throws. */
export async function reconcilePotPlacements(
  opts: { now?: number; deps?: Partial<ReconcileSweepDeps> } = {},
): Promise<PlacementSweepResult[]> {
  const results: PlacementSweepResult[] = [];
  const getFlagFn = opts.deps?.getFlag ?? getFlag;
  const listStartedPotsFn = opts.deps?.listStartedPots ?? listStartedPots;
  const getOrgPgFn = opts.deps?.getOrgPg ?? getOrgPg;
  const reconcileOnePotFn = opts.deps?.reconcileOnePot ?? reconcileOnePot;
  try {
    if (!(await getFlagFn(FLAGS.POT_PLACEMENT_WATCHDOG, 'system'))) return results;
    const started = await listStartedPotsFn();
    if (started.length === 0) return results;
    const { sql } = getOrgPgFn();
    const now = opts.now ?? Date.now();
    const cfg = placementConfig();
    for (const { workspaceId, installSlug } of started) {
      try {
        results.push(...(await reconcileOnePotFn(sql, workspaceId, installSlug, cfg, now)));
      } catch (e) {
        console.warn(
          `[pot-placement-watchdog] pot ${installSlug} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[pot-placement-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/** Reconcile ONE pot's placements against `sql` (injected so it integration-tests
 *  with a test DB). Resolves the Mug owner, derives each placed unit's holder
 *  liveness, and applies the P-020/P-021/P-022 decisions. Exported for the
 *  integration test + the P-051 invariant test. */
export async function reconcileOnePot(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  cfg: PlacementConfig,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  // ALL Mug-owners that served this pot (a fresh-per-wake / re-woken Mug accrues
  // several); cups are discovered across the whole set, but the NEWEST is the live
  // Mug we attribute to + wake. Without any resolvable owner we can neither attribute
  // cups to this pot nor target a recovery wake — leave it to the next sweep (the pot
  // may not have run yet). The liveness watchdog still keeps the Mug armed.
  const mugOwners = await resolveMugOwners(sql, workspaceId, installSlug);
  if (mugOwners.length === 0) return out;
  const mugOwner = mugOwners[0]; // newest — wake target + attribution

  // 1. This pot's cups (placement targets carry SOME Mug-owner as parent — match
  //    the full owner set so an earlier-wake's cups aren't orphaned from the ledger).
  const cupRows = await sql<
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
       AND child_role = 'cup'
       AND parent_spawn_id = ANY(${mugOwners})`;

  // EI-865 / WI-233 — which cups made a governed model call within ACTIVE_RECLAIM_WINDOW_MS
  // (agent_usage_samples, keyed by the spawn's run_id). This is the liveness signal that a
  // heartbeat-stale / reaper-reclaimed cup was actually SLOW-BUT-ALIVE: a long model call
  // emits no stdout (so last_output_at is useless) but DOES write a usage sample. A reclaim
  // of such a cup must not count toward the placement curse. The `ts >= now - window` bound
  // keeps this on the (workspace_id, ts DESC) index — a few minutes of recent samples.
  const cupRunIds = [...new Set(cupRows.map((b) => b.run_id).filter((r): r is string => !!r))];
  const activeRunIds = new Set<string>();
  if (cupRunIds.length > 0) {
    const activeRows = await sql<{ run_id: string }[]>`
      SELECT DISTINCT run_id
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${workspaceId}
         AND run_id = ANY(${cupRunIds})
         AND ts >= ${now - ACTIVE_RECLAIM_WINDOW_MS}`;
    for (const r of activeRows) if (r.run_id) activeRunIds.add(r.run_id);
  }

  // F-FIX-041 — the zombie signal: which cup OWNERS made ≥1 native tool call (agent_activity
  // kind='tool'). A serving cup with ZERO tool calls never got a fair attempt at its item
  // (an EI-1758 zombie booted without MCP tools, or died before any work), so its loss is
  // infra (the BOUNDED infra breaker), not item-pathology. Keyed by owner_id == session_owner.
  const cupActivityOwners = [...new Set(cupRows.map((b) => b.session_owner || b.spawn_id))];
  const ownersWithToolCalls = new Set<string>();
  if (cupActivityOwners.length > 0) {
    const toolRows = await sql<{ owner_id: string }[]>`
      SELECT DISTINCT owner_id
        FROM harness_shared.agent_activity
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ANY(${cupActivityOwners})
         AND kind = 'tool'`;
    for (const r of toolRows) ownersWithToolCalls.add(r.owner_id);
  }
  // 2026-07-02 (gpt-5.4 switch fallout): CODEX cups never land in agent_activity —
  // the recorder is a claude-session seam — so on the agent_activity signal alone
  // EVERY codex cup read as a zombie, every restart-reclaim accrued the bounded
  // infra breaker, and the whole frontier cursed in lockstep at fail_count=0 /
  // infra_loss_count=12-15 (observed live 07-02 00:10, 17 items). The
  // tool_invocations ledger is backend-AGNOSTIC (mug/cup/overwatch codex rows
  // land there — 850+ cup invocations in the same window agent_activity had zero),
  // so ALSO count a cup as having made a fair attempt when its spawn_id has ≥1
  // invocation there. Union, not replacement: agent_activity still covers legacy
  // owners whose spawn ids predate invocation stamping.
  const cupSpawnIds = cupRows.map((b) => b.spawn_id);
  const spawnsWithToolCalls = new Set<string>();
  if (cupSpawnIds.length > 0) {
    const invRows = await sql<{ spawn_id: string }[]>`
      SELECT DISTINCT spawn_id
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId}
         AND spawn_id = ANY(${cupSpawnIds})`;
    for (const r of invRows) spawnsWithToolCalls.add(r.spawn_id);
  }

  const cupByOwner = new Map<string, CupLite>();
  for (const b of cupRows) {
    const ownerId = b.session_owner || b.spawn_id;
    const recentlyActive = b.run_id != null && activeRunIds.has(b.run_id);
    const cup: CupLite = {
      spawnId: b.spawn_id,
      ownerId,
      featureId: b.feature_id,
      liveness: deriveCupLiveness({
        status: b.status,
        heartbeatAtMs: num(b.heartbeat_ms),
        lastOutputAtMs: num(b.last_output_ms),
        now,
      }),
      // Slow-but-alive false reclaim: recent model-call activity AND the cup is either
      // only heartbeat-stale (still running/restarting, the reaper has not run yet) or
      // was reaper-reclaimed (not a genuine crash). A genuine non-zero exit (status
      // 'failed' with the cup's OWN error) is excluded, so a cup-wedging item still curses.
      reclaimedWhileActive:
        recentlyActive &&
        (b.status === 'running' || b.status === 'restarting' || isReaperReclaim(b.status, b.error_message)),
      // F-FIX-041 — no native tool call across this cup's life ⇒ no fair attempt
      // (zombie). Checked against BOTH ledgers (see the union note above): a hit in
      // either means the cup demonstrably worked.
      madeNoToolCalls: !ownersWithToolCalls.has(ownerId) && !spawnsWithToolCalls.has(b.spawn_id),
    };
    // Index by both owner and spawn id so a unit's taken_by resolves either way.
    cupByOwner.set(ownerId, cup);
    cupByOwner.set(b.spawn_id, cup);
  }
  const cupOwners = [...new Set(cupRows.map((b) => b.session_owner || b.spawn_id))];

  // 2. Candidate placed units: each cup's spawn-anchored unit ∪ units a cup holds
  //    (warm-inject). One fetch resolves every candidate's current row.
  const candidateIds = new Set<string>();
  for (const b of cupRows) if (b.feature_id) candidateIds.add(b.feature_id);
  if (cupOwners.length > 0) {
    const claimed = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND taken_by = ANY(${cupOwners})`;
    for (const r of claimed) candidateIds.add(r.feature_id);
  }

  // Existing placement ledger rows for this pot (the durable counters).
  const placeRows = await sql<PlacementRow[]>`
    SELECT work_item_id, status, fail_count, infra_loss_count,
           extract(epoch from last_recovery_at) * 1000 AS last_recovery_ms,
           last_loss_spawn_id,
           escalation_msg_id,
           extract(epoch from last_seen_at) * 1000 AS last_seen_ms
      FROM harness_shared.pot_placements
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}`;
  const placeById = new Map<string, PlacementRow>(placeRows.map((p) => [p.work_item_id, p]));

  // F-FIX-041 — operator-dormancy detection (item-INDEPENDENT). The watchdog runs on the
  // 30s routinesTick; the most-recent last_seen_at over this pot's placements is its
  // PREVIOUS sweep. If the gap to `now` exceeds the dormancy grace, the operator/bg-host
  // was DORMANT in between (frozen ticker / session wedge / overnight dormancy), so every
  // placement "lost" for an infra reason, not item-pathology — this sweep grants the
  // grace (losses recover FLAT, not toward the curse). One flag per sweep (operator-wide
  // state), not per cup — an item cannot fake it. A pot with no prior placements
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

      // Serving cup = the unit's current holder, or the cup whose spawn placed it.
      const holder = unit?.taken_by ? cupByOwner.get(unit.taken_by) : undefined;
      const anchor = cupRows.find((b) => b.feature_id === unitId);
      const anchorCup = anchor ? cupByOwner.get(anchor.session_owner || anchor.spawn_id) : undefined;
      const servingCup = holder ?? anchorCup;
      const hasLiveHolder = holder?.liveness === 'live' || anchorCup?.liveness === 'live';
      // WI-233 — only meaningful when there is no live holder (the failed path): was the
      // serving cup a slow-but-alive false reclaim rather than a genuine failure?
      const servingCupReclaimedWhileActive =
        !hasLiveHolder && (holder?.reclaimedWhileActive === true || anchorCup?.reclaimedWhileActive === true);
      // F-FIX-041 — likewise only on the failed path: did the serving cup make 0 tool calls
      // (a no-fair-attempt zombie)? Feeds the bounded infra breaker, not the pathology one.
      const servingCupMadeNoToolCalls =
        !hasLiveHolder && (holder?.madeNoToolCalls === true || anchorCup?.madeNoToolCalls === true);

      const obs: PlacementObservation = {
        workItemId: unitId,
        unitExists: Boolean(unit),
        unitTerminal: isUnitTerminal(unit?.status),
        hasLiveHolder,
        failCount: existing?.fail_count ?? 0,
        infraLossCount: existing?.infra_loss_count ?? 0,
        placementStatus: existing?.status ?? null,
        lastRecoveryAtMs: existing?.last_recovery_ms ?? null,
        hasServingCup: servingCup != null, // WI-677 r2 — no cup ⇒ nothing to count
        servingCupSpawnId: servingCup?.spawnId ?? null,
        lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
        servingCupReclaimedWhileActive,
        servingCupMadeNoToolCalls, // F-FIX-041 — zombie (no-fair-attempt) → bounded infra breaker
        postDormancySweep, // F-FIX-041 — operator-dormancy grace (item-independent, per-sweep)
        unitParked: isUnitParked(unit?.status), // WI-1439 — deliberate park (e.g. blocked) → never recovered
        now,
      };
      const decision = evaluatePlacement(obs, cfg);

      const base = {
        workspaceId,
        installSlug,
        workItemId: unitId,
        harnessSlug: unit?.harness_slug ?? null,
        mugOwnerId: mugOwner,
        cupSpawnId: servingCup?.spawnId ?? null,
        cupOwnerId: servingCup?.ownerId ?? null,
        now,
      };

      switch (decision.kind) {
        case 'healthy':
          await upsertPlacement(sql, {
            ...base,
            status: 'working',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            lastLossSpawnId: null, // live attempt → fresh loss lineage (WI-677 r2)
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
              lastLossSpawnId: null,
              disposition: 'completed',
            });
            out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'completed' });
            // P-032 — EDGE RESOLUTION: a completed lane that gated downstream work
            // has just un-gated it (its `blocks` edges resolve). Fire ONE Mug wake
            // so she surveys + places the now-ready next-wave batch — the wave
            // ordering executing through edge resolution, replacing the hand-rolled
            // pair-emit `:done` events (mug-wave-dispatch D-006). The survey applies
            // the precise readiness gate; we only wake when there IS non-terminal
            // downstream this lane blocks. Fires once (guarded by the status transition).
            if (base.harnessSlug) {
              const downstream = await countNonTerminalDownstream(sql, workspaceId, base.harnessSlug, unitId);
              if (downstream > 0) {
                await fireUnblockWake(workspaceId, mugOwner, unitId, base.harnessSlug, downstream);
                out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'unblocked', detail: `${downstream} downstream` });
              }
            }
          }
          break;
        case 'parked':
          // WI-1439 recovery-churn fix — the unit's OWN status is a deliberate park
          // (isUnitParked, e.g. `blocked` or `needs-human` for an owner/human-gated
          // step — EI-6563). No live
          // holder is EXPECTED here, so this is NOT pathology: never bump fail/infra
          // counters, never stamp a loss lineage, and suppress any pre-existing cursed
          // escalation (mirrors the 'completed' case) since a park supersedes any prior
          // curse — the item has its own delegator-notify signal path, not the watchdog's.
          if (existing?.status !== 'blocked') {
            if (existing?.escalation_msg_id) {
              await suppressCursedEscalation(existing.escalation_msg_id, unitId);
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'blocked',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: null,
              disposition: 'parked',
            });
          }
          break;
        case 'recover':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: decision.nextFailCount,
            infraLossCount: decision.nextInfraLossCount,
            // Counted a loss ⇒ stamp WHICH corpse, so the next sweep can't recount it;
            // flat re-place ⇒ preserve the prior stamp (WI-677 r2, mig 440).
            lastLossSpawnId:
              decision.nextFailCount > obs.failCount || decision.nextInfraLossCount > obs.infraLossCount
                ? (servingCup?.spawnId ?? existing?.last_loss_spawn_id ?? null)
                : (existing?.last_loss_spawn_id ?? null),
            disposition: 'recover',
            bumpRecovery: true,
          });
          // EI-3216 — an ITEM-INDEPENDENT infra loss (operator dormancy / no-fair-attempt
          // zombie) re-places silently: it does NOT fire a per-item Mug recovery wake (the
          // Mug can't fix cup-boot infra by re-placing THIS item, and a fleet-wide no-cups
          // window would fire one wake PER placement — the ~5min wake storm). The recovering
          // row is still surfaced in pot:status, so she drives it on her next natural survey.
          if (!decision.infraAttributed) {
            await fireRecoveryWake(workspaceId, mugOwner, unitId, base.harnessSlug, decision.nextFailCount);
          }
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'recover',
            detail: `attempt ${decision.nextFailCount}`,
          });
          break;
        case 'breaker': {
          // EI-3216 — only a genuine item-PATHOLOGY curse (a cup that RAN and failed
          // `breakerThreshold` times) opens a per-item owner escalation. An infra-attributed
          // curse (the bounded no-fair-attempt zombie breaker, fail_count=0) records `cursed`
          // for the health metric but skips the escalation: a "failed 0×" advisory is queue
          // noise the owner can't act on per item (the fleet-wide cup-boot infra is the real
          // problem, surfaced in aggregate). This is the source of the 32-row "failed 0×" flood.
          const msgId = decision.infraAttributed
            ? null
            : await escalateCursedPlacement(unitId, base.harnessSlug, decision.nextFailCount);
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: decision.nextFailCount,
            lastLossSpawnId: servingCup?.spawnId ?? existing?.last_loss_spawn_id ?? null,
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
          // Refresh last_seen_at (the row stays observable in pot:status) but do
          // NOT re-fire, NOT re-escalate (escalation_msg_id is preserved), and do
          // NOT bump fail_count — the latch holds it steady at the breaker count.
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: obs.failCount,
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
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
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
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
              lastLossSpawnId: null,
              disposition: 'abandoned',
            });
          }
          break;
      }
    }
  }

  // 3. P-022 — stranded-work resolution: stuck blockers gating downstream work.
  out.push(...(await reconcileStrandedWork(sql, workspaceId, installSlug, mugOwner, placeById, now)));

  // 4. EI-6109/1524/1518 — completion-reconcile GC: converge EVERY open placement
  //    (working/recovering/cursed/stranded) whose subject item went terminal/gone with
  //    no live cup re-anchoring it (the candidate sweep above never revisits those, so
  //    the durable accounting would drift), resolving any advisory it still carries.
  out.push(...(await reconcileTerminalPlacements(sql, workspaceId, installSlug, now)));
  return out;
}

/** P-020 — fire ONE targeted recovery wake to the Mug so she re-places the
 *  stalled unit without waiting for the next idle wake. Best-effort: a woken:0
 *  (Mug has no armed wake) degrades to "she sees the recovering row in
 *  pot:status on her next natural turn"; the liveness watchdog keeps her armed. */
async function fireRecoveryWake(
  workspaceId: string,
  mugOwner: string,
  unitId: string,
  harness: string | null,
  attempt: number,
): Promise<void> {
  try {
    await wakeRecipients([mugOwner], {
      summary:
        `Placement watchdog: work-item ${unitId}${harness ? ` (${harness})` : ''} is not terminal but its ` +
        `cup is dead/stalled (placement attempt ${attempt}) — re-place or recover it.`,
      payload: { kind: 'placement-recovery', workItemId: unitId, harness, attempt },
      source: 'pot-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[pot-placement-watchdog] recovery wake failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
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

/** P-032 — a completed lane that gated downstream work fires ONE Mug wake so she
 *  surveys + places the now-unblocked next-wave batch. The wave ordering executing
 *  through edge resolution — replacing the hand-rolled pair-emit `:done` events
 *  (mug-wave-dispatch D-006). Best-effort: a woken:0 (no armed wake) degrades to
 *  the Mug seeing the freed lanes in her next natural pot:survey. */
async function fireUnblockWake(
  workspaceId: string,
  mugOwner: string,
  completedId: string,
  harness: string | null,
  downstream: number,
): Promise<void> {
  try {
    await wakeRecipients([mugOwner], {
      summary:
        `Placement watchdog: ${completedId}${harness ? ` (${harness})` : ''} completed and un-gated ` +
        `${downstream} downstream lane(s) — survey + place the next wave batch.`,
      payload: { kind: 'placement-unblocked', workItemId: completedId, harness, downstream },
      source: 'pot-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[pot-placement-watchdog] unblock wake failed for ${completedId}: ${e instanceof Error ? e.message : e}`);
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
        `reaching a terminal state. Per the cursed-item circuit breaker (mug-autonomous-execution B-09 / P-021) ` +
        `the Mug has STOPPED auto-re-placing it. Investigate it (ill-specified? wedging cups?) then re-place, ` +
        `deprecate, or split it. Re-placing clears the breaker when it next completes.`,
    });
    return rec.msg_id;
  } catch (e) {
    console.warn(`[pot-placement-watchdog] cursed escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
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
      `[pot-placement-watchdog] resolving placement escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`,
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
 * EI-6109 / EI-1524 / EI-1518 — the completion-reconcile GC sweep. The per-candidate
 * sweep only settles a placement to completed/abandoned while a live cup anchors or
 * holds the unit (it is a candidate THIS tick). A placement whose subject unit reaches
 * terminal — or is retired — AFTER its serving cup has died / aged out of the candidate
 * set is therefore never revisited, and keeps its OPEN status forever:
 *   • a `working`/`recovering` row has no live holder to re-anchor it, and
 *   • an infra-attributed `cursed`/`stranded` row carries NO escalation_msg_id, so the
 *     ORIGINAL escalation-only GC (which required escalation_msg_id IS NOT NULL) skipped
 *     it as well.
 * The result is the placement-accounting DRIFT (EI-6109): pot_placements reports
 * cursed/working lanes whose work-items have long since completed, and
 * loadCursedWorkItemIds (raw status='cursed') holds their ids out of the frontier.
 *
 * This sweep closes the class: every tick, over ALL of the pot's OPEN placements
 * (working / recovering / cursed / stranded), any whose subject work-item is now
 * terminal (→ completed) or gone (→ abandoned) is converged to a terminal placement
 * status. A row that still carries an advisory escalation (a genuine cursed/stranded
 * curse) also has that escalation resolved — subsuming the EI-1524 behavior. Bounded
 * (the open set is small — the frontier plus a handful of stuck rows) and fail-soft;
 * one row's failure never aborts the sweep, and a non-terminal unit is always left for
 * the candidate sweep (never robbed).
 */
async function reconcileTerminalPlacements(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const openRows = await sql<
    { work_item_id: string; status: string; escalation_msg_id: string | null; harness_slug: string | null; fail_count: number }[]
  >`
    SELECT work_item_id, status, escalation_msg_id, harness_slug, fail_count
      FROM harness_shared.pot_placements
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND status IN ('working', 'recovering', 'cursed', 'stranded')`;
  if (openRows.length === 0) return out;

  // Current unit status for each, keyed by feature_id within the workspace (the
  // same key the candidate sweep uses — see the unitById map above).
  const ids = [...new Set(openRows.map((r) => r.work_item_id))];
  const unitRows = await sql<{ feature_id: string; status: string }[]>`
    SELECT feature_id, status
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
  const unitStatusById = new Map<string, string>(unitRows.map((u) => [u.feature_id, u.status]));

  for (const r of openRows) {
    const unitStatus = unitStatusById.get(r.work_item_id);
    const decision = evaluateTerminalPlacementReconcile({
      placementStatus: r.status,
      unitExists: unitStatus != null,
      unitTerminal: isUnitTerminal(unitStatus),
    });
    if (decision === 'keep') continue;

    const terminal = decision === 'resolve-completed';
    // Resolve any open advisory the row still carries (cursed/stranded curses do; a
    // working/recovering row, and an infra-attributed curse, carry none — those simply
    // skip the resolve and converge the status).
    if (r.escalation_msg_id) {
      await resolvePlacementEscalation(
        r.escalation_msg_id,
        r.work_item_id,
        terminal
          ? `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} reached terminal state (${unitStatus}); the ${r.status} advisory is no longer relevant`
          : `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} no longer exists; the ${r.status} advisory is no longer relevant`,
      );
    }
    // Converge the placement out of the OPEN set so pot:status +
    // summarizeOpenPlacements + loadCursedWorkItemIds stop counting a lane whose work
    // has finished. mug/cup fields are preserved (COALESCE keeps existing on null).
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: r.work_item_id,
      harnessSlug: r.harness_slug,
      mugOwnerId: null,
      lastLossSpawnId: null, // converged out of the open set → lineage over
      cupSpawnId: null,
      cupOwnerId: null,
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
      detail: `gc: stale ${r.status} placement reconciled (unit ${terminal ? unitStatus : 'gone'})`,
    });
  }
  return out;
}

/**
 * P-022 — a `failing`/`failed` feature blocker that gates ≥1 non-terminal
 * downstream feature is escalated ONCE so the owner can resolve/deprecate it and
 * un-gate the downstream. Dedupe: a pot_placements row for the blocker in
 * `stranded`/`cursed` with an escalation already recorded suppresses re-escalation
 * (the breaker escalation also covers a stuck blocker that is itself cursed).
 * v1 covers feature→feature block edges (the primary case); issue-blocker
 * stranding is a follow-on.
 */
async function reconcileStrandedWork(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  mugOwner: string,
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
          `(mug-autonomous-execution B-09 / P-022)`,
      });
      msgId = rec.msg_id;
    } catch (e) {
      console.warn(`[pot-placement-watchdog] stranded escalation failed for ${blk.blocker_id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: blk.blocker_id,
      harnessSlug: blk.blocker_harness,
      mugOwnerId: mugOwner,
      lastLossSpawnId: null, // stranded-escalation marker row, not a loss event
      cupSpawnId: null,
      cupOwnerId: null,
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

/** EI-8437 — how long a `recovering` placement can sit untouched (no reconcile
 *  activity — {@link summarizeOpenPlacements}'s `p.updated_at`, which only moves
 *  on an actual reconcile touch, not every 30s tick) before the brief stops just
 *  re-noting it as stale and starts telling the reader to VERIFY-and-close.
 *  Observed live: WI-329 sat `recovering` from 2026-07-03 through 2026-07-07
 *  (5+ days) across 3 separate Mug triage sessions that each independently
 *  concluded "needs reconciliation" but never actually verified the underlying
 *  work had already landed — so the brief now surfaces that verification is
 *  overdue instead of making every reader re-derive the staleness by hand.
 *  Env-overridable like the other watchdog tunables. */
export const DEFAULT_STALE_RECOVERING_MS = (() => {
  const v = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_STALE_MS ?? process.env.PAPERCUSP_POT_PLACEMENT_STALE_MS ?? 24 * 60 * 60_000,
  );
  return Number.isFinite(v) && v >= 0 ? v : 24 * 60 * 60_000;
})();

/** Open placements needing the Mug's attention — surfaced in pot:status so she
 *  acts on recoveries/cursed/stranded each wake (P-020/P-023: completion). */
export interface OpenPlacementSummary {
  recovering: number;
  cursed: number;
  stranded: number;
  workingTracked: number;
  items: Array<{
    workItemId: string;
    status: string;
    failCount: number;
    harness: string | null;
    /** EI-8437 — hours since this placement row last saw reconcile activity, when
     *  known (undefined if the caller didn't supply `updated_at`, e.g. older test
     *  fixtures / callers). */
    ageHours?: number;
    /** EI-8437 — `status === 'recovering'` AND `ageHours` exceeds
     *  {@link DEFAULT_STALE_RECOVERING_MS} — a nudge that re-placing alone hasn't
     *  worked and the underlying work should be VERIFIED (it may have already
     *  landed) before re-placing again. */
    stale?: boolean;
    /** EI-8437 — `<planSlug>#<itemId>` (joined) when the work-item traces to a
     *  plan item, so a triaging agent can jump straight to `plans:get` instead of
     *  re-deriving the link from scratch. Null when the item carries no plan link. */
    planItem?: string | null;
  }>;
}

type OpenPlacementCountRow = { status: string; count: number | string };
type OpenPlacementItemRow = {
  work_item_id: string;
  status: string;
  fail_count: number;
  harness_slug: string | null;
  /** Placement row's own `updated_at` (only moves on a reconcile touch) — optional
   *  so pre-EI-8437 callers/fixtures that don't select it still type-check. */
  updated_at?: string | Date | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;
};

export function buildOpenPlacementSummary(
  countRows: OpenPlacementCountRow[],
  itemRows: OpenPlacementItemRow[],
  nowMs: number = Date.now(),
): OpenPlacementSummary {
  const summary: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  for (const r of countRows) {
    const count = Number(r.count) || 0;
    if (r.status === 'recovering') summary.recovering = count;
    else if (r.status === 'cursed') summary.cursed = count;
    else if (r.status === 'stranded') summary.stranded = count;
    else if (r.status === 'working') summary.workingTracked = count;
  }
  for (const r of itemRows) {
    if (r.status !== 'working') {
      const updatedAtMs = r.updated_at != null ? new Date(r.updated_at).getTime() : NaN;
      const ageHours = Number.isFinite(updatedAtMs) ? Math.max(0, (nowMs - updatedAtMs) / 3_600_000) : undefined;
      const stale = r.status === 'recovering' && ageHours != null && ageHours * 3_600_000 >= DEFAULT_STALE_RECOVERING_MS;
      const planItemId = r.source_plan_item_ids?.[0];
      const planItem = r.source_plan_slug && planItemId ? `${r.source_plan_slug}#${planItemId}` : null;
      summary.items.push({
        workItemId: r.work_item_id,
        status: r.status,
        failCount: r.fail_count,
        harness: r.harness_slug,
        ...(ageHours != null ? { ageHours } : {}),
        ...(stale ? { stale: true } : {}),
        ...(planItem ? { planItem } : {}),
      });
    }
  }
  // EI-6005: the wake-brief renders only `caps.placements`-many items (a bounded
  // sample) — with cursed items commonly outnumbering the rare 'recovering' one,
  // an itemRows-order truncation could silently drop the ONE item that actually
  // needs action ("re-place NOW") while still showing every merely-cursed id
  // ("STOP re-placing"). Sort recovering FIRST (then stranded, then cursed) so the
  // truncated sample always includes every recovering item before any lower-
  // priority one is shown.
  const PRIORITY: Record<string, number> = { recovering: 0, stranded: 1, cursed: 2 };
  summary.items.sort((a, b) => (PRIORITY[a.status] ?? 3) - (PRIORITY[b.status] ?? 3));
  return summary;
}

export async function summarizeOpenPlacements(
  workspaceId: string,
  installSlug: string,
  limit = 20,
): Promise<OpenPlacementSummary> {
  const empty: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  try {
    const { sql } = getOrgPg();
    const graceSec = Math.max(1, Math.round(STALE_CLAIM_GRACE_MS / 1000));
    const countRows = await sql<OpenPlacementCountRow[]>`
      WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
      live_open AS (
        SELECT p.status
          FROM harness_shared.pot_placements p
          LEFT JOIN harness_shared.harness_features_consolidated f
            ON f.workspace_id = p.workspace_id
           AND f.feature_id = p.work_item_id
         WHERE p.workspace_id = ${workspaceId}
           AND p.install_slug = ${installSlug}
           AND p.status IN ('recovering', 'cursed', 'stranded', 'working')
           AND f.feature_id IS NOT NULL
           AND f.status <> ALL(${SUMMARY_INACTIVE_UNIT_STATES}::text[])
           AND (
             p.status <> 'working'
             OR (
               f.taken_by IS NOT NULL
               AND f.taken_by <> ''
               AND EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
             )
           )
      )
      SELECT status, count(*)::int AS count
        FROM live_open
       GROUP BY status`;
    const rows = await sql<OpenPlacementItemRow[]>`
      WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
      live_open AS (
        SELECT p.work_item_id, p.status, p.fail_count, p.harness_slug, p.updated_at,
               f.source_plan_slug, f.source_plan_item_ids
          FROM harness_shared.pot_placements p
          LEFT JOIN harness_shared.harness_features_consolidated f
            ON f.workspace_id = p.workspace_id
           AND f.feature_id = p.work_item_id
         WHERE p.workspace_id = ${workspaceId}
           AND p.install_slug = ${installSlug}
           AND p.status IN ('recovering', 'cursed', 'stranded', 'working')
           AND f.feature_id IS NOT NULL
           AND f.status <> ALL(${SUMMARY_INACTIVE_UNIT_STATES}::text[])
           AND (
             p.status <> 'working'
             OR (
               f.taken_by IS NOT NULL
               AND f.taken_by <> ''
               AND EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
             )
           )
      )
      SELECT work_item_id, status, fail_count, harness_slug, updated_at, source_plan_slug, source_plan_item_ids
        FROM live_open
       ORDER BY (status = 'cursed') DESC, (status = 'stranded') DESC, (status = 'recovering') DESC, updated_at DESC
       LIMIT ${limit}`;
    return buildOpenPlacementSummary(countRows, rows);
  } catch {
    return empty;
  }
}

/** The Mug's MOST-RECENT real wake for a pot — the max `started_at` of her
 *  `spawned_agents` mug rows (child_role='queen', harness = the pot slug). The
 *  `pot.controlState` heartbeat reads this so the wake-brain Mug (which never
 *  calls `recordPotWake`) still shows "Running" when she actually wakes, instead of
 *  a permanent "Paused/Stalled" off the stale recordPotWake ledger (the owner's
 *  "I relaunched the app but still can't see her running" regression). ISO or null;
 *  best-effort (never throws). */
export async function latestMugWakeAt(workspaceId: string, potSlug: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ t: string | Date | null }[]>`
      SELECT max(started_at) AS t
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId}
         AND child_role = 'mug'
         AND harness_slug = ${potSlug}`;
    const t = rows[0]?.t;
    return t ? new Date(t).toISOString() : null;
  } catch {
    return null;
  }
}
