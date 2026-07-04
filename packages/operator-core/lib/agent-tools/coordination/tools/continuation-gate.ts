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
import { contextUsagePct } from './inbox-context-usage';

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
}

export interface ContinuationVerdict {
  /** The mechanical recommendation: run the next unit in-turn (true) or settle (false). */
  shouldContinue: boolean;
  ceilingPct: number;
  contextPct: number | null;
  /** contextPct is known AND strictly below the ceiling. */
  contextHeadroom: boolean;
  unreadInbox: number | null;
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
      `at ${contextPct}% context (≥ ${ceilingPct}% continuation ceiling) — settle so the next wake starts on fresh context, not a mid-unit compaction`,
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
  const guidance = shouldContinue
    ? `continuation gate OPEN (${contextPct}% context, no unread inbox): you MAY run the next unit in this turn IF it is already scoped — but FIRST flush (every held work-item claim checkpointed, P-002). Re-evaluate this gate at the next unit boundary.`
    : `continuation gate CLOSED — settle this turn: ${reasons.join('; ')}. Checkpoint what you hold and end the turn; the next wake re-opens the gate.`;

  return { shouldContinue, ceilingPct, contextPct, contextHeadroom, unreadInbox, reasons, guidance };
}

/** Convenience: build the gate inputs from raw presence + inbox reads (the shape
 *  loop:checkpoint has on hand), so the tool wiring stays a one-liner. `unreadInbox`
 *  null ⇒ the inbox couldn't be evaluated (blocks, per {@link evaluateContinuationGate}). */
export function continuationGateFromReads(args: {
  contextTokens: number | null | undefined;
  compactionLimit: number | null | undefined;
  unreadInbox: number | null | undefined;
  ceilingPct?: number;
}): ContinuationVerdict {
  return evaluateContinuationGate({
    contextPct: contextUsagePct(args.contextTokens, args.compactionLimit),
    unreadInbox: args.unreadInbox,
    ceilingPct: args.ceilingPct,
  });
}
