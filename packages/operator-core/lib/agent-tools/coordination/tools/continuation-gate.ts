/**
 * continuation-gate — the flush-to-proceed CONTINUATION GATE
 * (flush-to-proceed-stretch-discipline-2026-07-04 P-005, spec rule 2).
 *
 * After a session SETTLES a unit of work, should it run the NEXT unit in the SAME
 * turn, or end the turn so the next wake is a fresh injection point? The old
 * engine rule answered this unconditionally ("always end the turn after one item")
 * — a zero-judgment reflex whose out-of-distribution failures (presence-blindness,
 * the per-wake orient/re-read boundary tax, work fragmentation) are exactly what
 * this plan removes. The continuation gate replaces the reflex with a MECHANICAL
 * read of the two conditions that actually make continuing unsafe:
 *
 *   1. CONTEXT HEADROOM — is context usage below the ceiling (default 60%)? Past it,
 *      settle so the next wake starts clean rather than compacting mid-unit.
 *   2. NO PENDING INBOX INTERRUPT — is there any unread message addressed to you
 *      since your last settle? A pending owner redirect / peer interrupt outranks
 *      continuing; end the turn and read it.
 *
 * PURE: the caller supplies the reads (contextPct from contextUsagePct(presence),
 * unreadInbox from the inbox), so the verdict is unit-testable without a DB.
 * loop:checkpoint fills them best-effort and returns the verdict, so settle-vs-
 * continue is a ONE-CALL read at the unit boundary the agent already checkpoints
 * at, not a guess. A leg the caller could not evaluate (null) is treated as
 * BLOCKING — the gate never recommends continuing on an unknown, so a read hiccup
 * fails safe toward settling.
 *
 * This is the JUDGMENT layer; D-002 requires the mechanical backstops (P-002
 * checkpoint-freshness gate, P-003 stale-checkpoint reclaim) to land first, because
 * a judgment gate gets rationalized under momentum ("just one more unit…") and the
 * backstops bound that failure mode.
 */
import {
  CONTEXT_GAUGE_CRITICAL_PCT,
  contextUsagePct,
} from './inbox-context-usage';
import { readCueAuthority } from '../cue-authority';

/** The envelope fields the interrupt classifier reads — structural, so the gate
 *  keeps no import edge to the coordination core types (CoordEnvelope satisfies it). */
export interface InterruptEnvelopeLike {
  category?: unknown;
  auto?: unknown;
  lifecycle?: unknown;
}

/** The small envelope slice needed to authenticate a fleet wind-down cue. */
export interface FleetWindDownCueLike extends InterruptEnvelopeLike {
  summary?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface FleetWindDownLoopEndAuthorizationInputs {
  /** `false` is the only affirmative claimless read; null/undefined is unknown. */
  activeClaimPresent: boolean | null | undefined;
  /** The member's current presence-fleet label; null means known non-member. */
  currentFleet: string | null | undefined;
  /** The durable registry control state for currentFleet. */
  fleetControlState: string | null | undefined;
  /** Cues read from the member's current inbox window. */
  cues: readonly FleetWindDownCueLike[] | null | undefined;
}

/**
 * Fail-closed authorization for the one no-PTY shutdown exception. A free-text
 * request, a stale/forged stamp, a held claim, a missing fleet/control read, or
 * a missing cue must never make a member stop its only wake source. The durable
 * registry state and the server-stamped cue are intentionally checked together:
 * either one alone can be stale or replayed.
 */
export function isFleetWindDownLoopEndAuthorized(
  inputs: FleetWindDownLoopEndAuthorizationInputs,
): boolean {
  if (inputs.activeClaimPresent !== false) return false;
  const fleet = typeof inputs.currentFleet === 'string' ? inputs.currentFleet.trim() : '';
  if (!fleet || inputs.fleetControlState !== 'winding-down') return false;
  if (!inputs.cues?.length) return false;

  return inputs.cues.some((cue) => {
    const stamp = readCueAuthority(cue);
    if (
      !stamp ||
      stamp.authority !== 'fleet-leader' ||
      stamp.scope !== 'fleet-members' ||
      stamp.authorityRef !== fleet ||
      stamp.scopeRef !== fleet
    ) {
      return false;
    }
    const text = [cue.summary, cue.body]
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    return text.includes('WIND-DOWN') && text.includes('loop:end');
  });
}

/**
 * WI-4179 (owner-reported 2026-07-11): is this unread envelope a REAL pending
 * interrupt — something a human or peer deliberately wrote — or system
 * machinery chatter? The gate's unread leg used to count the raw
 * readInbox/filterInbox output (which drops only own + notify-kind rows), so
 * categorized system broadcasts, `auto` lifecycle chatter (claim
 * announcements, digests) and peers' intent-declares all read as "pending
 * owner input": a watchdog burst of 16 IDENTICAL `severe-event-resolved` rows
 * in ~300ms closed the gate while coord:inbox/orient showed nothing pending.
 * The rule matches the gate's documented semantics ("a pending owner redirect
 * / peer interrupt outranks continuing") and coord:inbox's own view layers:
 *   - `category` present ⇒ a CATEGORIZED system broadcast (service-health,
 *     severe-event[-resolved], doc-drift, …) — status machinery, never an
 *     owner/peer input (and the repeat-prone class: watchdogs re-emit for
 *     hours, so counting them wedges the gate CLOSED);
 *   - `auto: true` ⇒ auto-generated lifecycle chatter (claim/plan-pickup
 *     broadcasts, digests) — nobody wrote it to you;
 *   - `lifecycle: 'intent'` ⇒ a peer's presence declare, excluded from the
 *     default inbox view for the same reason (P-005 fleet-member-dx).
 * Everything else (a directed peer/owner message, an owner-directive relay, an
 * ack, a claim-discipline nag) still counts. Pure.
 */
export function isPendingInterrupt(e: InterruptEnvelopeLike): boolean {
  if (typeof e.category === 'string' && e.category) return false;
  if (e.auto === true) return false;
  if (e.lifecycle === 'intent') return false;
  return true;
}

/** Count the unread envelopes that are real pending interrupts ({@link isPendingInterrupt}). */
export function countPendingInterrupts(entries: readonly InterruptEnvelopeLike[]): number {
  let n = 0;
  for (const e of entries) if (isPendingInterrupt(e)) n += 1;
  return n;
}

/**
 * Context-usage ceiling (percent of the soft limit) for continuing in-turn. Below
 * it, a settled session with a scoped next unit MAY run it in the same turn; at/above
 * it, settle so the next wake starts on fresh context instead of compacting mid-unit.
 * Deliberately well below the P-002 flush gate (75) and the compaction hint (85): the
 * continuation ceiling governs whether to START more work, which you stop doing before
 * you are anywhere near the flush/compaction-urgent zone.
 */
export const CONTINUATION_CEILING_PCT = 60;

export interface ContinuationGateInputs {
  /** Rounded context usage percent (contextUsagePct(presence)); null when uncomputable. */
  contextPct: number | null | undefined;
  /** Count of unread messages addressed to you since your last turn-settle; null when
   *  the inbox could not be evaluated (⇒ treated as blocking — fail safe toward settle). */
  unreadInbox: number | null | undefined;
  /** Override the context ceiling (default {@link CONTINUATION_CEILING_PCT}). */
  ceilingPct?: number;
  /** Is a re-wake GUARANTEED if this turn ends now — an armed loop, a registered
   *  (non-inbox-wake) event-await, or a present owner (turn-end-tracking's
   *  isRewakeGuaranteed)? A CLOSED gate says "settle", but SETTLING IS ONLY SAFE
   *  WHEN A RE-WAKE EXISTS: false here means ending the turn would silently halt
   *  an autonomous session, so the guidance escalates to self-compact / arm a
   *  wake instead of the plain "end the turn; the next wake re-opens the gate".
   *  null/undefined ⇒ unknown → guidance unchanged (non-breaking for callers
   *  that don't supply it; an interactive session's owner is the guaranteed wake). */
  rewakeGuaranteed?: boolean | null;
  /** Does the guaranteed next wake actually start on FRESH context? An armed
   *  warm loop guarantees another turn but preserves this transcript, so it
   *  must not satisfy the context-pressure remedy. false steers the caller to
   *  switch the loop to cold carry before settling. */
  nextWakeFresh?: boolean | null;
  /** Can this session actually SELF-COMPACT — i.e. would `session:request-compaction`
   *  succeed (selfCompactionAvailability(ownerId).available)? A carry-respawn is driven
   *  through a psu-pty host, so a headless/autonomous member has none and the call
   *  refuses (`no_live_pty_host`); a stale host refuses too (`host_predates_carry_respawn`).
   *  false ⇒ never prescribe self-compaction — it would spend the session's LAST turn on
   *  a call that cannot succeed. null/undefined ⇒ unknown (non-breaking). */
  selfCompactionAvailable?: boolean | null;
  /**
   * True only after the caller has independently verified the claimless,
   * current-fleet, durable-control, and typed-cue pair. This is deliberately
   * an affirmative override input: absent/false remains the ordinary no-PTY
   * guidance.
   */
  fleetWindDownLoopEndAuthorized?: boolean | null;
}

export interface ContinuationVerdict {
  /** The mechanical recommendation: run the next unit in-turn (true) or settle (false). */
  shouldContinue: boolean;
  ceilingPct: number;
  contextPct: number | null;
  /** contextPct is known AND strictly below the ceiling. */
  contextHeadroom: boolean;
  unreadInbox: number | null;
  /** The re-wake-guarantee input echoed back (null ⇒ unknown/not supplied). */
  rewakeGuaranteed: boolean | null;
  /** Whether the next wake sheds the current transcript (null ⇒ unknown). */
  nextWakeFresh: boolean | null;
  /** The self-compaction availability input echoed back (null ⇒ unknown/not supplied). */
  selfCompactionAvailable: boolean | null;
  /** Whether the fail-closed no-PTY fleet wind-down loop:end override was authorized. */
  fleetWindDownLoopEndAuthorized: boolean | null;
  /** Why the gate is CLOSED, one phrase per blocking leg (empty ⇒ open). */
  reasons: string[];
  /** One-line agent-facing guidance derived from the verdict. */
  guidance: string;
}

/**
 * Evaluate the continuation gate from the two mechanical legs. OPEN (shouldContinue)
 * only when context has known headroom AND there is no pending inbox interrupt. Any
 * unknown leg (null) blocks — the gate fails safe toward settling. The verdict is
 * mechanical; the agent still owns the third, judgment leg (is the next unit actually
 * scoped?) — surfaced in the guidance, not gated here.
 */
export function evaluateContinuationGate(inputs: ContinuationGateInputs): ContinuationVerdict {
  const ceilingPct = inputs.ceilingPct ?? CONTINUATION_CEILING_PCT;
  const contextPct =
    inputs.contextPct == null ? null : inputs.contextPct;
  const unreadInbox = inputs.unreadInbox == null ? null : inputs.unreadInbox;
  const reasons: string[] = [];

  const contextHeadroom = contextPct != null && contextPct < ceilingPct;
  if (contextPct == null) {
    reasons.push('context usage unknown — cannot confirm headroom, so settle');
  } else if (contextPct >= ceilingPct) {
    reasons.push(
      `at ${contextPct}% context (≥ ${ceilingPct}% continuation ceiling) — settle before starting another unit`,
    );
  }

  if (unreadInbox == null) {
    reasons.push('inbox not evaluated — check coord:inbox for a pending owner redirect before continuing');
  } else if (unreadInbox > 0) {
    reasons.push(
      `${unreadInbox} unread inbox message${unreadInbox === 1 ? '' : 's'} since your last settle — read coord:inbox first; a pending owner input / interrupt outranks continuing`,
    );
  }

  const shouldContinue = reasons.length === 0;
  const rewakeGuaranteed = inputs.rewakeGuaranteed ?? null;
  const nextWakeFresh = inputs.nextWakeFresh ?? null;
  const selfCompactionAvailable = inputs.selfCompactionAvailable ?? null;
  const fleetWindDownLoopEndAuthorized = inputs.fleetWindDownLoopEndAuthorized ?? null;
  let guidance = shouldContinue
    ? `continuation gate OPEN (${contextPct}% context, no unread inbox): you MAY run the next unit in this turn IF it is already scoped — but FIRST flush (every held work-item claim checkpointed, P-002). Re-evaluate this gate at the next unit boundary.`
    : `continuation gate CLOSED — settle this turn: ${reasons.join('; ')}. Checkpoint what you hold and end the turn; the next wake re-opens the gate.`;

  // A fleet wind-down is the one deliberate exception to the no-PTY rule. At
  // critical context, the member has already flushed/released its claim and the
  // fleet's durable control + typed cue authorize stopping the engine loop. It
  // must be checked before the ordinary re-wake/cold-carry remedies, because
  // neither a warm nor a missing wake should resurrect a fleet that is standing
  // down. This branch never authorizes session:end or process respawn.
  if (
    !shouldContinue &&
    selfCompactionAvailable === false &&
    contextPct != null &&
    contextPct >= CONTEXT_GAUGE_CRITICAL_PCT &&
    fleetWindDownLoopEndAuthorized === true
  ) {
    guidance =
      `continuation gate CLOSED — settle this turn: ${reasons.join('; ')}. ` +
      `⚠ AUTHORIZED FLEET WIND-DOWN: write loop:checkpoint { did, left, insight, next }, ` +
      `release any remaining locks, then call loop:end. This stops only the engine ` +
      `loop; preserve the session and do not call session:end or respawn.`;
  }

  // Re-wake guarantee: "settle" is only SAFE when a re-wake actually exists. For
  // an autonomous session with no armed loop / real await / present owner,
  // "end the turn; the next wake re-opens the gate" is FALSE COMFORT — there is
  // no next wake, so ending here silently HALTS the session. Replace the closing
  // instruction with an arm-a-wake / self-compact directive. Only fires on an
  // explicit false (unknown/true keeps the base guidance — non-breaking).
  //
  // WHICH remedy leads is not cosmetic (EI-20209826138488049). The diagnosed
  // condition is "no re-wake exists", and `loop:arm` REMOVES that condition,
  // whereas self-compaction only sidesteps it for one more turn — so arming is
  // the direct fix and is available to EVERY session. Self-compaction is the
  // CONDITIONAL one: it is driven through a psu-pty host, so on a headless or
  // autonomous member it fails (`no_live_pty_host`), and on a stale host it fails
  // too (`host_predates_carry_respawn`). Prescribing it first sent exactly the
  // sessions that could not use it to spend their LAST turn discovering that.
  if (
    !shouldContinue &&
    !(
      selfCompactionAvailable === false &&
      contextPct != null &&
      contextPct >= CONTEXT_GAUGE_CRITICAL_PCT &&
      fleetWindDownLoopEndAuthorized === true
    ) &&
    rewakeGuaranteed === false
  ) {
    const opening =
      `continuation gate CLOSED — settle this turn: ${reasons.join('; ')}. ` +
      `⚠ NO guaranteed re-wake (autonomous mode; no armed loop, no registered await, no owner present): ` +
      `ending the turn now would SILENTLY HALT the session. Do NOT just end it — `;
    const remedy =
      selfCompactionAvailable === false
        ? `ARM A WAKE: loop:arm { intervalSec, goal } (or events:await for a real condition). ` +
          `Self-compaction is NOT available to this session — it has no live psu-pty host able to carry-respawn, ` +
          `so session:request-compaction would refuse; do not spend your last turn on it.`
        : selfCompactionAvailable === true
          ? `ARM A WAKE first — loop:arm { intervalSec, goal } / events:await — which is what makes settling safe; ` +
            `or SELF-COMPACT to continue on fresh context (session:request-compaction), which this session CAN do.`
          : `ARM A WAKE: loop:arm { intervalSec, goal } / events:await — always available, and the direct remedy ` +
            `for the missing re-wake. Self-compaction (session:request-compaction) also continues the work, but it ` +
            `requires a live psu-pty host and refuses with no_live_pty_host on a session that has none.`;
    guidance = opening + remedy;
  } else if (
    !shouldContinue &&
    !(
      selfCompactionAvailable === false &&
      contextPct != null &&
      contextPct >= CONTEXT_GAUGE_CRITICAL_PCT &&
      fleetWindDownLoopEndAuthorized === true
    ) &&
    rewakeGuaranteed === true &&
    nextWakeFresh === false
  ) {
    // EI-20223970530333577: a WARM loop guarantees another wake but does not
    // shed context. Treating those two properties as equivalent told a 91%-full
    // loop to end for a "fresh" wake that could never arrive; Codex then tried
    // session:request-compaction, which structurally has no psu-pty host. The
    // executable boundary is: persist the carry-note, retune this already-armed
    // loop to cold, then settle. Cold-loop settle is accepted by the compaction
    // tool once the carry-note exists, but no extra call is required here.
    guidance =
      `continuation gate CLOSED — settle this turn: ${reasons.join('; ')}. ` +
      `⚠ The guaranteed next wake is WARM and will retain this over-ceiling context. ` +
      `Write loop:checkpoint { did, left, insight, next }, then retune the existing loop with ` +
      `loop:arm { carry: 'cold' } and end the turn; the cold wake starts from that durable carry-note. ` +
      (selfCompactionAvailable === false
        ? `Do not call session:request-compaction: this session has no live psu-pty host and it would refuse with no_live_pty_host.`
        : `A host-backed session may alternatively use session:request-compaction.`);
  }

  return {
    shouldContinue,
    ceilingPct,
    contextPct,
    contextHeadroom,
    unreadInbox,
    rewakeGuaranteed,
    nextWakeFresh,
    selfCompactionAvailable,
    fleetWindDownLoopEndAuthorized,
    reasons,
    guidance,
  };
}

/** Convenience: build the gate inputs from raw presence + inbox reads (the shape
 *  loop:checkpoint has on hand), so the tool wiring stays a one-liner. `unreadInbox`
 *  null ⇒ the inbox couldn't be evaluated (blocks, per {@link evaluateContinuationGate}). */
export function continuationGateFromReads(args: {
  contextTokens: number | null | undefined;
  compactionLimit: number | null | undefined;
  unreadInbox: number | null | undefined;
  ceilingPct?: number;
  rewakeGuaranteed?: boolean | null;
  nextWakeFresh?: boolean | null;
  selfCompactionAvailable?: boolean | null;
  fleetWindDownLoopEndAuthorized?: boolean | null;
}): ContinuationVerdict {
  return evaluateContinuationGate({
    contextPct: contextUsagePct(args.contextTokens, args.compactionLimit),
    unreadInbox: args.unreadInbox,
    ceilingPct: args.ceilingPct,
    rewakeGuaranteed: args.rewakeGuaranteed,
    nextWakeFresh: args.nextWakeFresh,
    selfCompactionAvailable: args.selfCompactionAvailable,
    fleetWindDownLoopEndAuthorized: args.fleetWindDownLoopEndAuthorized,
  });
}
