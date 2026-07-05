/**
 * signal-actor-registry — every monitoring/freshness SIGNAL must declare its
 * ACTING consumer, or an explicit accepted-risk waiver with an expiry
 * (EI-7347, 2026-07-05).
 *
 * The WI-2374 rubric-emission incident generalizes: `scorecards:freshness`
 * had 172 reads by 61 agents and ZERO consumers that ACTED on a stale
 * verdict — emission died silently for ~34h because a "signal" existed but
 * nothing was wired to DO anything when it went bad. The same read-only-
 * signal trap recurs across the platform: a health panel, a freshness
 * check, or an alarm interpreter that only ever returns `actionable: false`
 * is a signal with no teeth. `coord:conditions` is a confirmed live
 * instance (see its registration below) — its own docstring says "Read-only
 * … it never fires on a transition" (service-health-events.ts).
 *
 * This is a SMALL, MANUALLY-curated catalog (same shape as
 * `testing-domains-registry.ts` / `KNOWN_DARK_FLAGS`), not an automatic
 * codebase scan — "what counts as a monitoring signal" is not mechanically
 * decidable, so new signals are registered here as they are built or
 * discovered. The enforcement is the coverage invariant every entry must
 * satisfy:
 *
 *   - `actingConsumer` set (something concrete periodically re-evaluates
 *     the signal and takes action — fires an alarm, escalates, files a
 *     floor, wakes an await key, …), OR
 *   - a `waiver` whose `expiresAt` has not passed (an accepted, tracked,
 *     time-boxed gap — mirrors `KNOWN_DARK_FLAGS`' expiry discipline so a
 *     "we'll wire an actor later" can't linger silently forever).
 *
 * `signal-actor-registry.test.ts` REDS the moment either condition lapses —
 * a new signal registered with neither, or a waiver whose expiry has
 * passed — so "we built a signal" can no longer silently mean "the signal
 * is decorative."
 *
 * Companion sweep (provenance-diversity — flag any signal stream where
 * >95% of rows come from ONE emitter, the monoculture that made rubric
 * emission fragile) is a natural next step but is NOT built here; tracked
 * as a follow-up rather than scope-creeping this seed registry.
 */

/** An accepted, tracked, time-boxed exception to the actor mandate. */
export interface SignalActorWaiver {
  /** Why no actor exists yet / why acting is deliberately deferred. */
  reason: string;
  /** ISO timestamp this waiver must be revisited by — past this, coverage fails. */
  expiresAt: string;
  /** Who accepted the risk (ownerId / role). */
  acceptedBy: string;
  /** Tracking ref for the follow-up that will close the gap (WI-xxx / EI-xxx). */
  followUp?: string;
}

/** One registered monitoring/freshness signal. */
export interface SignalActorEntry {
  /** Stable, kebab-case id (matches the tool/panel name where practical). */
  id: string;
  /** What the signal reports and why it exists. */
  description: string;
  /** Where the signal is emitted/read from (file path or tool name). */
  source: string;
  /**
   * What ACTS on the signal — fires an alarm, opens/resolves an escalation,
   * files a floor, wakes an await key, self-debounces a re-fire, etc.
   * Required unless a live `waiver` is present.
   */
  actingConsumer?: string;
  /** file[#symbol] pointer(s) into the consumer, for spot-checking. */
  consumerRefs?: string[];
  waiver?: SignalActorWaiver;
}

const registry = new Map<string, SignalActorEntry>();

/** Register a signal. Throws on a duplicate id — ids are stable + unique. */
export function defineSignal(entry: SignalActorEntry): void {
  if (registry.has(entry.id)) {
    throw new Error(`signal-actor-registry: duplicate signal id "${entry.id}"`);
  }
  registry.set(entry.id, entry);
}

export function getSignal(id: string): SignalActorEntry | undefined {
  return registry.get(id);
}

export function listSignals(): SignalActorEntry[] {
  return [...registry.values()];
}

/** True when `entry` currently satisfies the actor-or-live-waiver mandate. */
export function isSignalCovered(entry: SignalActorEntry, now: number = Date.now()): boolean {
  if (entry.actingConsumer && entry.actingConsumer.trim().length > 0) return true;
  if (entry.waiver) return new Date(entry.waiver.expiresAt).getTime() > now;
  return false;
}

/** Every signal that is NEITHER actor-backed NOR waiver-covered right now. */
export function uncoveredSignals(now: number = Date.now()): SignalActorEntry[] {
  return listSignals().filter((e) => !isSignalCovered(e, now));
}

/* ---------------------------------------------------------------- *
 * Seed registrations — the 4 signal categories named in EI-7347.
 * Extend this list as new monitoring/freshness signals ship; a signal
 * with neither an actor nor a live waiver fails signal-actor-registry.test.ts.
 * ---------------------------------------------------------------- */

defineSignal({
  id: 'scorecards-freshness',
  description:
    "Has the Overwatch emitted a COMPLETE rubric scorecard since its last wake? The WI-2374 " +
    'incident signal: 172 reads / 61 agents, zero actors, died silently for ~34h.',
  source: 'packages/operator-core/lib/scorecard-freshness.ts (checkScorecardFreshness / interpretOverwatchEmission)',
  actingConsumer:
    'scorecard-emission-pulse files a deterministic synthesized floor whenever the freshness window ' +
    'is empty (decoupled from overwatch aliveness, WI-2374); interpretOverwatchEmission classifies ' +
    'a real gap as loop-dead vs agent-skipping, and the infra-liveness alarm escalates both ' +
    "(`rubric-emission-dark`, `overwatch-scorecard-skipped`) to the owner.",
  consumerRefs: [
    'packages/operator-core/lib/scorecard-emission-pulse.ts#runScorecardEmissionPulse',
    'packages/operator-core/lib/system-health/liveness-alarm.ts#evaluateLivenessAlarm',
  ],
});

defineSignal({
  id: 'liveness-alarm',
  description:
    'The request-path infra-supervision signal: dead routines, queen/overwatch dark, a stale ' +
    'health-tick snapshot, an all-paused LLM account pool, or any panel self-reporting `crit`.',
  source: 'packages/operator-core/lib/system-health/liveness-alarm.ts (evaluateLivenessAlarm)',
  actingConsumer:
    'runLivenessAlarmTick opens a durably-deduped (per-signature) owner escalation for every NEW ' +
    'signal and auto-resolves it the moment the condition clears — self-contained signal+action, ' +
    'ticked every ~2min on a request worker (startInfraLivenessAlarm).',
  consumerRefs: ['packages/operator-core/lib/system-health/liveness-alarm.ts#runLivenessAlarmTick'],
});

defineSignal({
  id: 'hive-watchdog-fires',
  description:
    'The shared `harness_shared.hive_watchdog_fires` ledger every *-watchdog.ts source writes a row ' +
    'to on each fire (scorecard-pulse, overwatch, hive queen, scout draft-review, release-deploy-staleness, …).',
  source: 'harness_shared.hive_watchdog_fires (mig 212)',
  actingConsumer:
    'Each watchdog reads its OWN recent fire count from this ledger to self-debounce re-firing — the ' +
    "ledger is a durable per-source cooldown gate, not a passive log nobody reads. Not the same trap " +
    'as scorecards-freshness (which had a reader with no actor); here every writer is also a reader-actor.',
  consumerRefs: [
    'packages/operator-core/lib/hive/watchdog.ts',
    'packages/operator-core/lib/overwatch/watchdog.ts',
    'packages/operator-core/lib/scout/draft-review-watchdog.ts',
  ],
});

defineSignal({
  id: 'coord-conditions',
  description:
    "coord:conditions folds condition-keyed alarm/resolution broadcasts (severe-event-broadcast.ts) " +
    'into current open/resolved state — the live "what is wrong RIGHT NOW" view (EI-6138).',
  source: 'packages/operator-core/lib/agent-tools/coordination/tools/conditions.ts (computeConditionStates)',
  // Confirmed GAP, not an oversight: service-health-events.ts's own comment says it plainly —
  // "conditions.ts is a read-only FOLD … it never fires on a transition". Nothing in the codebase
  // periodically re-evaluates computeConditionStates() and escalates a long-open condition; every
  // caller is an on-demand READ (an agent checking "what's wrong right now"). This is the exact
  // EI-7347 read-only-signal trap, caught by building this registry rather than left implicit.
  waiver: {
    reason:
      'No actor exists yet. Building one safely needs a design call this bug-drain pass should not ' +
      'make unilaterally: what open-duration threshold escalates, and how it avoids double-alarming ' +
      'conditions that severe-event-broadcast.ts (the alarm source) may already independently escalate ' +
      'elsewhere. Tracked as a scoped follow-up rather than a silent gap.',
    expiresAt: '2026-07-19T00:00:00.000Z',
    acceptedBy: 'su-e958e416 (backlog-drain-0705 fleet, EI-7347)',
    followUp: 'WI-2965: wire a periodic actor for coord:conditions (extend evaluateLivenessAlarm, or a dedicated tick)',
  },
});
