/**
 * goal activity — the ONE place that folds a goal's ADMINISTRATIVE status
 * together with its HOLDER LIVENESS, so a deliberately paused goal can never be
 * reported as one that lost its holder
 * (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
 *
 * ── THE DISTINCTION, AND WHY IT NEEDS A HOME ────────────────────────────────
 *
 * `holder.ts` answers "is anybody alive on this goal?" and returns four values
 * (held / unheld / lost / unknown). It deliberately knows nothing about the
 * goal's status, because liveness is not status.
 *
 * But a goal that is DELIBERATELY PAUSED has no live holder BY DESIGN — the
 * pause fan-out disarms exactly those sessions' loops — so feeding its liveness
 * straight into a consumer produces `lost`: a stop rendered as a crash. That is
 * the lesson `unit-reconciler.ts`'s `isAdministrativelyPaused` (WI-5378)
 * already encodes one layer down: a disabled or masked unit is read from a
 * PERSISTED administrative marker, never inferred from the fact that nothing is
 * running, because from the outside a deliberate stop and a crash are identical.
 *
 * Today that exemption exists in exactly one place, as a bare `status =
 * 'active'` literal in the liveness watchdog's SQL, with no comment. P-004
 * derives goal activity from this same liveness for every read-side surface,
 * and every one of them would have to remember the exemption independently —
 * the precise D-003 shape: not hard to write, easy to forget, silent when
 * forgotten. So the rule lives here once, and the status short-circuits BEFORE
 * liveness is ever consulted.
 *
 * ── WHY `unknown` STILL WINS OVER `lost` ────────────────────────────────────
 *
 * Nothing here weakens `holder.ts`'s conservative rule. `unknown` (at least one
 * holder the oracle could not resolve) passes through unchanged, because a
 * degraded oracle fetch must never read as abandonment. This module only ever
 * ADDS reasons not to say `lost`.
 */
// From the SHARED module, not `goal-launch-settings.ts`: that one statically
// imports `@papercusp/db-org`, and this fold is pure + synchronous, so it must
// not drag the store into every consumer at load.
import {
  resolveGoalHolderPolicy,
  type GoalHolderPolicyInput,
  type ResolvedGoalHolderPolicy,
} from '../goal-launch-settings-shared';
import type { GoalHolderLiveness } from './holder';

/**
 * The statuses a holder-liveness judgement is entitled to be made about.
 *
 * ONE declaration, so the sweep's SQL predicate and the in-memory
 * classification cannot disagree — the drift shape `stop-seam.ts`'s
 * `STOPPING_STATUSES` was introduced to kill (`achieved` was a first-class
 * `GOAL_STATUSES` member while being invisible to the stop fan-out, WI-37832).
 *
 * Narrow on purpose: `paused` is excluded because the pause is deliberate, and
 * `achieved`/`killed` because the goal is over. Nothing else is a goal anyone
 * should still be holding.
 */
export const GOAL_LIVENESS_SWEEP_STATUSES: readonly string[] = ['active'];

/**
 * What a goal's activity actually is, once status and liveness are folded.
 *
 * The first two values come from the STATUS and are administrative facts; the
 * last four are `holder.ts`'s liveness verdict passed through. They are kept in
 * one union deliberately: a consumer that has to switch on two separate fields
 * is a consumer that can forget one of them.
 */
export type GoalActivity =
  /** A persisted, deliberate hold. No live holder is EXPECTED, not a fault. */
  | 'paused'
  /** achieved / killed — the goal is over; holders are irrelevant. */
  | 'terminal'
  /** At least one holder resolves positively alive. */
  | 'held'
  /** No goal-mode row exists at all — never picked up. */
  | 'unheld'
  /** Rows exist, all resolved, none alive — dropped mid-flight. */
  | 'lost'
  /** At least one holder could not be resolved. NOT evidence of death. */
  | 'unknown';

export interface GoalActivityVerdict {
  activity: GoalActivity;
  /** A persisted administrative pause is in force. */
  deliberatelyPaused: boolean;
  /** The goal is over (achieved / killed). */
  terminal: boolean;
  /**
   * The holder liveness this verdict used, or null when the STATUS decided the
   * answer and liveness was never consulted. Null is the honest reading of
   * "we did not ask" — distinct from having asked and got `unknown`.
   */
  liveness: GoalHolderLiveness | null;
}

/**
 * Is this goal DELIBERATELY paused? The goal-level analogue of the unit
 * reconciler's `isAdministrativelyPaused` (WI-5378), and the reason P-005
 * exists: there, a `disabled`/`masked` unit is read from a PERSISTED
 * administrative marker rather than inferred from the fact that nothing is
 * running, because a deliberate stop and a crash look identical from the
 * outside. A goal is no different.
 *
 * Takes the raw status string rather than `GoalStatus` so a caller holding an
 * unvalidated column value (every SQL read) can ask without a cast.
 *
 * LIVES HERE, not in `agent-mcp`'s `pause-record.ts` where P-005 first wrote it
 * (which now re-exports it, so P-005's callers are unchanged). The move is
 * structural, not cosmetic: this module is operator-core's cheapest PURE fold,
 * and reaching for the predicate through the agent-mcp package BARREL pulled
 * that entire index into every consumer of it — a cycle
 * (`sync-resolver → activity → @papercusp/agent-mcp → goals/get → …`) for a
 * one-line string comparison. Plan D-011.
 */
export function isGoalAdministrativelyPaused(status: string | null | undefined): boolean {
  return status === 'paused';
}

/**
 * Terminal per the goal partition (`GOAL_TERMINAL_STATUSES`, mirrored here as a
 * string test so a raw column value needs no cast).
 */
function isTerminal(status: string | null | undefined): boolean {
  return status === 'achieved' || status === 'killed';
}

/**
 * PURE: fold a goal's status and holder liveness into one verdict.
 *
 * ORDER IS THE WHOLE POINT. Status is consulted FIRST and short-circuits:
 *
 *   1. `paused`  — a deliberate hold. Returns `paused` and never looks at
 *      liveness, so no amount of dead holders can turn it into `lost`.
 *   2. terminal  — the goal is over. Same short-circuit, for the same reason.
 *   3. otherwise — the liveness verdict, unchanged.
 *
 * `liveness` is optional so a caller that has already short-circuited on status
 * (the sweep's SQL predicate does exactly that) can ask without paying for an
 * oracle round-trip it does not need. Omitting it on an ACTIVE goal yields
 * `unknown` — we were not told, so we do not know — never `lost`.
 */
export function resolveGoalActivity(input: {
  status: string | null | undefined;
  liveness?: GoalHolderLiveness | null;
}): GoalActivityVerdict {
  if (isGoalAdministrativelyPaused(input.status)) {
    return { activity: 'paused', deliberatelyPaused: true, terminal: false, liveness: null };
  }
  if (isTerminal(input.status)) {
    return { activity: 'terminal', deliberatelyPaused: false, terminal: true, liveness: null };
  }
  const liveness = input.liveness ?? null;
  return {
    activity: liveness ?? 'unknown',
    deliberatelyPaused: false,
    terminal: false,
    liveness,
  };
}

/**
 * Is this goal's quiet a FAULT worth reporting, rather than something somebody
 * chose? The one predicate a watchdog / alarm / respawn path should ask.
 *
 * `unknown` is false here for the same reason `holder.ts` keeps it apart from
 * `lost`: a degraded oracle read is not evidence of abandonment.
 */
export function isGoalQuietUnexpectedly(verdict: GoalActivityVerdict): boolean {
  return verdict.activity === 'unheld' || verdict.activity === 'lost';
}

/* ────────────────────────────────────────────────────────────────────────────
 * P-004 — DETERMINISTIC DEACTIVATION
 *
 * The half `resolveGoalActivity` above deliberately does NOT decide: whether a
 * goal's quiet should stop it reading as `active`. That question needs one more
 * input — the goal's own HOLDER POLICY (P-002's `holder { requireLive }`) — and
 * folding it here keeps the whole rule in the module that already owns the
 * status/liveness fold, rather than in each read-side surface.
 *
 * DERIVED AT READ TIME, NEVER SWEPT. Nothing below writes anything. A sweep
 * that flipped `goals.status` would (a) need a writer racing every other writer
 * of that column, (b) be unable to un-flip the moment a holder came back, and
 * (c) destroy the administrative value the column is FOR — the difference
 * between "somebody paused this" and "this went quiet", which D-009 records as
 * the distinction the whole plan exists to keep. The column keeps meaning what
 * a human put in it; the derived reading answers what is actually true now.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The read-side label for a holder-required goal that is quiet unexpectedly.
 *
 * Deliberately NOT a member of `GOAL_STATUSES`: it is computed on every read and
 * MUST NEVER be written to `goals.status`. Keeping it outside the persisted
 * union is what makes that mistake a type error rather than a silent one — and
 * it is why the word is new rather than a reuse of `paused`, which already means
 * something a human chose (D-009).
 */
export const GOAL_DORMANT_STATUS = 'dormant';

export interface GoalEffectiveActivity extends GoalActivityVerdict {
  /** The goal's resolved holder policy — read-time defaults applied (D-008). */
  policy: ResolvedGoalHolderPolicy;
  /** Shorthand for `policy.requireLive`. */
  requiresLiveHolder: boolean;
  /**
   * The goal requires a live holder, is administratively `active`, and has none
   * — so it should NOT be read as active. Never true for a paused, terminal, or
   * `requireLive: false` goal, and never true on `unknown`.
   */
  deactivated: boolean;
  /**
   * The status a reader should USE in place of the raw column: the raw value,
   * or `GOAL_DORMANT_STATUS` when `deactivated`.
   */
  effectiveStatus: string | null;
}

/**
 * PURE: what a goal's status EFFECTIVELY is, once its policy and its holder
 * liveness are folded in. The one function a read-side surface should call.
 *
 * Four gates, in this order — each one a reason NOT to deactivate:
 *
 *   1. `paused` / terminal — `resolveGoalActivity`'s administrative
 *      short-circuit. Liveness is never consulted, so a deliberate hold can
 *      never be rendered as a loss.
 *   2. `requireLive: false` — the goal told us it is driven by routines rather
 *      than a held session, so "nobody is holding it" is its normal condition
 *      and not a fault. This is the opt-out D-008 requires be SAYABLE.
 *   3. status not in `GOAL_LIVENESS_SWEEP_STATUSES` — only a goal that claims to
 *      be active can stop reading as active. Reusing that constant is what keeps
 *      this in-memory rule and the sweep's SQL predicate from drifting apart.
 *   4. liveness is `held` or `unknown` — `isGoalQuietUnexpectedly`. `unknown` is
 *      the load-bearing one: a degraded oracle fetch must never deactivate a
 *      goal, or one transient DB hiccup silently empties the board.
 *
 * Omitting `liveness` yields `unknown`, so a caller that has not paid for the
 * oracle gets the SAFE answer (not deactivated) rather than a confident wrong
 * one.
 */
export function resolveGoalEffectiveActivity(input: {
  status: string | null | undefined;
  launchSettings?: GoalHolderPolicyInput | null;
  liveness?: GoalHolderLiveness | null;
}): GoalEffectiveActivity {
  const verdict = resolveGoalActivity({ status: input.status, liveness: input.liveness });
  const policy = resolveGoalHolderPolicy(input.launchSettings);
  const rawStatus = input.status ?? null;

  const deactivated =
    !verdict.deliberatelyPaused &&
    !verdict.terminal &&
    policy.requireLive &&
    GOAL_LIVENESS_SWEEP_STATUSES.includes(rawStatus ?? '') &&
    isGoalQuietUnexpectedly(verdict);

  return {
    ...verdict,
    policy,
    requiresLiveHolder: policy.requireLive,
    deactivated,
    effectiveStatus: deactivated ? GOAL_DORMANT_STATUS : rawStatus,
  };
}
