/* ══════════════════════════════════════════════════════════════════════════════
 * INTEREST PROFILES — what an agent in a given CONTEXT should be watching.
 *
 * P-010 of state-plane-interest-and-hardening-2026-08-21.
 *
 * ── WHY THIS IS A SEPARATE MODULE, NOT MORE FIELDS ON CellSpec ────────────────
 * Interest is a property of the READER, not of the cell. `gate.greenCheckpoint.verdict`
 * is the same cell whether a fleet leader or an item holder reads it; what differs is
 * whether they should be folded it, suggested it, or auto-armed on it. Pushing that
 * onto CellSpec would widen an interface whose axes are ratified, and would say
 * nothing at all about EVENTS, which are half of what an agent watches.
 *
 * So this follows the cell-transcription-detector precedent: declared data as a
 * module-scope readonly array, co-located with the registry it references.
 *
 * ── ⚠ THESE ROWS ARE DECLARED INTENT, NOT MEASURED DEMAND ─────────────────────
 * Every `why` below traces to an instruction the system ALREADY gives agents (the
 * su persona's leader-monitor mandate, its member operating loop, and CLAUDE.md's
 * "is my change live" guidance). None of them is justified by observed reads, and
 * this file must not be described as demand-driven.
 *
 * The measurement, recorded here so nobody re-derives it and reaches the opposite
 * conclusion: across all retained telemetry only 13 distinct cell names are read via
 * `state:read`. Of the 5 unregistered names, 2 are deliberate probes and 1 is a
 * truncated-name typo; the only genuine reaches for something unregistered are
 * `host.load` (2 callers) and `release.gate` (1), over 14 days. That is noise-level,
 * not demand. Existing read volume is therefore evidence about ADOPTION, and cannot
 * be used to argue that any row below is or is not wanted.
 *
 * ── HOW DRIFT IS PREVENTED (two different mechanisms, deliberately) ───────────
 * CELL references are imported CONSTANTS (`GATE_VERDICT_CELL.cell`), never retyped
 * string literals. This is the rule AGENT_GOAL_CELL states in its own comment: a
 * hand-typed id that drifts from the registry's fails SILENTLY, because `getCell`
 * simply returns undefined and the surface discloses nothing, forever. Importing the
 * const moves that whole failure class to compile time.
 *
 * EVENT references cannot get the same treatment — a family is a catalog string —
 * so they are covered at runtime by interest-profiles.test.ts, which also re-checks
 * the cells for the one thing the compiler cannot know: whether the spec is actually
 * REGISTERED, as opposed to merely defined.
 * ══════════════════════════════════════════════════════════════════════════════ */

import {
  BUILTIN_CELLS,
  DEPLOYED_SHA_CELL,
  GATE_VERDICT_CELL,
  GIT_PIPELINE_POSITION_CELL,
  HOST_MEMORY_PRESSURE_CELL,
} from './cell-registrations';
import { catalogEntry } from './events/await/catalog';
import type { PredicateOp } from './events/await/predicate-watch';

/**
 * The role an agent is occupying when the interest applies. An agent can occupy
 * several at once (a fleet leader is usually also an item holder); profiles are
 * additive, never exclusive.
 */
export type InterestContext = 'fleet-leader' | 'fleet-member' | 'plan-holder' | 'item-holder';

/**
 * How strongly the system should act on the interest.
 *
 * - `fold`     — include the current value in what the agent is already being handed
 *                (an orient/brief fold). Costs a read, never a turn.
 * - `suggest`  — surface it as a recommendation the agent may act on.
 * - `auto-arm` — register the watch on the agent's behalf. Costs a turn when it
 *                fires, so it is reserved for conditions that genuinely need one.
 */
export type InterestTier = 'fold' | 'suggest' | 'auto-arm';

/**
 * What is being watched. A discriminated union rather than the bare
 * `cell id | event key` string the plan item described, because the two validate
 * against DIFFERENT registries: given only `"release.gate"` a checker cannot tell
 * whether an unknown name is a misspelled cell or a misspelled event family, and
 * would have to guess — which is how a typo passes as "probably the other kind".
 */
export type InterestWatch =
  | { readonly kind: 'cell'; readonly cell: string }
  | { readonly kind: 'event'; readonly family: string };

/** A predicate, reusing the state:subscribe / events:watch comparator vocabulary. */
export interface InterestCondition {
  readonly op: PredicateOp;
  readonly value?: unknown;
}

export interface InterestProfileRow {
  /** Who this interest belongs to. */
  readonly context: InterestContext;
  /** The cell or event family being watched. */
  readonly watch: InterestWatch;
  /** How strongly to act on it. */
  readonly tier: InterestTier;
  /**
   * The predicate that makes the watch fire. Required for an `auto-arm` CELL row —
   * `state:subscribe` cannot arm without one — and forbidden on a `fold` row, which
   * has nothing to trigger. An `auto-arm` EVENT row needs none: the emit IS the edge.
   */
  readonly on?: InterestCondition;
  /**
   * Names of the fields in the agent's own context that supply the watch's subject,
   * in order.
   *
   * For an EVENT, these fill the family's key params — and a row MUST name one per
   * REQUIRED param. That is not bookkeeping: `buildKey` on a family whose params are
   * unresolved produces a key nothing ever emits, so the waiter sleeps forever and
   * silently, which is the exact hazard predicate-watch documents.
   *
   * For a CELL, it names the caller-relative subject (the `as` argument) — several
   * cells answer about a different subject, or refuse to answer at all, without it.
   */
  readonly of?: readonly string[];
  /** Why this context should care. Traces to an existing instruction — see header. */
  readonly why: string;
}

/**
 * THE registry. Order is display order, grouped by context.
 *
 * ⚠ Adding a row is cheap; adding an `auto-arm` row is not — it spends one of the
 * agent's turns every time it fires. Default to `fold`, and reserve `auto-arm` for a
 * condition where a late reaction has a real cost.
 */
export const INTEREST_PROFILES: readonly InterestProfileRow[] = [
  // ── fleet-leader ───────────────────────────────────────────────────────────
  // The persona tells a leader to PARK on the fleet's transition events rather than
  // re-read state on a timer, because the payload names WHICH member changed — which
  // no poll can tell you — and arrives when it happens rather than up to an interval late.
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-member-dead' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: 'A dead member strands whatever it claimed. Only a running leader relaunches it, and every wake spent not knowing is a lane sitting idle — this is the single failure the leader-monitor mandate exists to catch.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-drained' },
    tier: 'auto-arm',
    of: ['fleet.slug'],
    why: "The drain edge is the leader's own loop:end condition. Discovering it a interval late keeps a finished fleet burning wakes.",
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-member-stalled' },
    tier: 'suggest',
    of: ['fleet.slug'],
    why: 'A stalled member is indistinguishable from a slow one without looking; surfacing it lets the leader bench the lane instead of waiting on it.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-context-critical' },
    tier: 'suggest',
    of: ['fleet.slug'],
    why: 'A member near its context ceiling is about to lose state. The leader can have it checkpoint before that happens rather than after.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-claim-released' },
    tier: 'fold',
    of: ['fleet.slug'],
    why: 'A released claim is work that just became re-placeable; folding it into the leader brief is what makes reclaiming orphans a read rather than a sweep.',
  },
  {
    context: 'fleet-leader',
    watch: { kind: 'event', family: 'fleet-item-completed' },
    tier: 'fold',
    of: ['fleet.slug'],
    why: 'Burn-down delta. Cheap to fold, and it is the number the leader reports; waking a turn for it would not be.',
  },

  // ── fleet-member ───────────────────────────────────────────────────────────
  {
    context: 'fleet-member',
    watch: { kind: 'event', family: 'work-item-claimable' },
    tier: 'auto-arm',
    why: 'The member operating loop mandates exactly ONE park on this key when the lane drains, so the pool refilling re-wakes the member instead of it burning empty scheduler polls. The key is global and the payload carries the discriminator, so the wake is a HINT — scheduler:get_next on the wake turn stays the authoritative claim.',
  },

  // ── plan-holder ────────────────────────────────────────────────────────────
  {
    context: 'plan-holder',
    watch: { kind: 'cell', cell: GATE_VERDICT_CELL.cell },
    tier: 'fold',
    why: 'A red gate blocks promotion for every item in the plan at once, so it is the plan holder\'s problem before it is any single item\'s. Folded rather than armed because the holder should learn it on the next read, not be woken per flip.',
  },
  {
    context: 'plan-holder',
    watch: { kind: 'event', family: 'plan-item' },
    tier: 'suggest',
    of: ['plan.slug', 'planItem.id'],
    why: 'The done edge on a specific item is what unblocks dependents. Both key params are required, which is why two context fields are named — a family this parameterized is precisely where an unresolved key would strand a waiter silently.',
  },

  // ── item-holder ────────────────────────────────────────────────────────────
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: GATE_VERDICT_CELL.cell },
    tier: 'suggest',
    on: { op: 'changed' },
    why: 'CLAUDE.md makes greening a red gate the job of whoever it blocks, not a queue to wait in. Suggesting the verdict on change is what turns that from a rule an agent must remember into one it is reminded of.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: DEPLOYED_SHA_CELL.cell },
    tier: 'suggest',
    on: { op: 'changed' },
    why: 'A change is not live until the serving sha moves. This is the cell that answers it; the deployed position tick is a git fact and does not.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: GIT_PIPELINE_POSITION_CELL.cell },
    tier: 'fold',
    of: ['workItem.primaryPath'],
    why: 'Answers "is my edit live, and if not the ONE lever" in a single read. It is per-path: without the subject it reports about a different one, which is why the path is named here rather than left to the caller.',
  },
  {
    context: 'item-holder',
    watch: { kind: 'cell', cell: HOST_MEMORY_PRESSURE_CELL.cell },
    tier: 'fold',
    why: 'Host pressure is the standard false explanation for a slow or flaky run. Folding the measured value lets an agent check the claim instead of asserting it — the persona forbids blaming load without the mechanism.',
  },
];

/** Rows that apply to a given context. */
export function interestProfilesFor(context: InterestContext): InterestProfileRow[] {
  return INTEREST_PROFILES.filter((row) => row.context === context);
}

/** Every distinct cell id referenced by any profile. */
export function referencedCellIds(): string[] {
  return [...new Set(INTEREST_PROFILES.flatMap((r) => (r.watch.kind === 'cell' ? [r.watch.cell] : [])))];
}

/** Every distinct event family referenced by any profile. */
export function referencedEventFamilies(): string[] {
  return [...new Set(INTEREST_PROFILES.flatMap((r) => (r.watch.kind === 'event' ? [r.watch.family] : [])))];
}
