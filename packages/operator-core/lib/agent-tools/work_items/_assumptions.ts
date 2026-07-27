/**
 * _assumptions.ts — the commitment-class assumption declaration
 * (unified-agent-state-plane-2026-07-27 P-017 (b) gate #2, per D-016 / D-050).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * D-016 requires every agent-facing behaviour to name an enforcement TIER, and
 * says the prompt is never one. "Declare an assumption" was one of the three
 * behaviours it recorded as UNCOVERED, with the tier available to it being
 * "GATE at commitment calls + DETECTOR".
 *
 * D-050 defines the commitment class, and the line is NOT "important calls". It
 * is calls that REMOVE OTHERS' ABILITY TO CHECK YOU:
 *
 *   • a terminal work-item close removes the item from the shared queue — nobody
 *     re-derives it, nobody re-reads it, and if the close rested on a wrong
 *     assumption, the assumption leaves with the item. IN CLASS.
 *   • a plan Decision stays addressable forever and is MEANT to be re-read and
 *     challenged. OUT.
 *   • coord:escalate goes to a human, who is the check. OUT.
 *   • coord:send is gate #1's surface (`expects`). OUT — double-gating one call
 *     is how a field becomes noise.
 *
 * ── WHY A LITERAL 'none' AND NOT null / an optional field ───────────────────
 *
 * D-016: "A default is how a field dies — everyone takes it, and the field then
 * carries no information. Forcing an explicit choice, even when the choice is
 * `none`, is what makes the field real."
 *
 * So this is REQUIRED with no default. `'none'` is a literal string rather than
 * JSON `null` on purpose: `null` and *absent* are one fumble apart in a
 * hand-built payload, and this gate exists precisely to make the choice
 * conscious. A caller who means "nothing" must type it.
 *
 * ── WHAT THIS DOES NOT DO (a named hole, not an oversight) ──────────────────
 *
 * Keys are FORMAT-checked, not resolved against `harness_shared.agent_facts`.
 * `relayOf` refuses a dangling msg_id on the principle that a reference nobody
 * can resolve is laundering, and the same argument applies here — but P-008 owns
 * the assumption substrate and has not landed, so the resolution semantics
 * (facts are TTL'd, scoped and retractable — is an expired key dangling, or
 * merely old?) are its call, not this item's. A half-verification that resolves
 * on one tool and not the other would be worse than none.
 *
 * Until P-008 lands this gate enforces that an assumption was STATED, not that
 * it exists — strictly more than the nothing that preceded it. P-011's
 * conflicting-assumption detector is what consumes the content.
 */

import { z } from 'zod';

/** The literal a caller passes to declare, explicitly, that this commitment rests
 *  on no recorded assumption. Exported so tests and callers cannot drift from it. */
export const NO_ASSUMPTIONS = 'none' as const;

/** Max keys accepted on one commitment. A close resting on more than a handful of
 *  assumptions is a signal the work was not actually scoped, not a shape to support. */
export const MAX_ASSUMPTION_KEYS = 10;

export type AssumptionDeclaration = string[] | typeof NO_ASSUMPTIONS;

/**
 * REQUIRED on every commitment-class call. Deliberately NOT `.optional()` and
 * deliberately without a default — see the header.
 */
export const assumptionsArg = z
  .union([
    z.array(z.string().min(1).max(120)).min(1).max(MAX_ASSUMPTION_KEYS),
    z.literal(NO_ASSUMPTIONS),
  ])
  .describe(
    "REQUIRED — the `facts:assert` KEYS this close rests on (e.g. [\"gate-red-is-flake-not-regression\"]), " +
      'or the literal "none" if it rests on no recorded assumption. There is deliberately NO default: a ' +
      'terminal close removes the item from the queue, so a wrong assumption leaves with it and nobody ' +
      'can catch it afterwards. Saying "none" is a valid answer; omitting the field is not.',
  );

/** The refusal message for the shorthand/inline axis, where a union cannot carry
 *  the requirement structurally. Shared so both tools refuse identically. */
export const ASSUMPTIONS_REQUIRED_MESSAGE =
  'a terminal close requires `assumptions` — the facts:assert key(s) this close rests on, or the ' +
  'literal "none". This is required-with-explicit-none by design (D-016/D-050): a terminal close ' +
  'removes the item from the shared queue, so an assumption that was wrong leaves with it. If the ' +
  'close rests on nothing you recorded, pass "none" explicitly.';

/** True when a value is a well-formed declaration. Used by the shorthand checks,
 *  which run BEFORE the object schema validates the field itself. */
export function hasAssumptionDeclaration(v: unknown): boolean {
  if (v === NO_ASSUMPTIONS) return true;
  return Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k.trim().length > 0);
}
