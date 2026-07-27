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
 * ── THE HOLE ABOVE IS NOW CLOSED (P-008 (d) / D-079) ────────────────────────
 *
 * This header used to end: "keys are FORMAT-checked, not resolved against
 * `harness_shared.agent_facts` ... until P-008 lands this gate enforces that an
 * assumption was STATED, not that it exists — strictly more than the nothing that
 * preceded it. P-011's conflicting-assumption detector is what consumes the
 * content."
 *
 * ⚠ BOTH of those closing claims were FALSE AS BUILT, which is why P-008 (d)
 * turned out bigger than "add a lookup". The declaration was never PERSISTED:
 * required, format-checked by two refines, then referenced ZERO times downstream
 * — `set_state`'s handler never read it, and `complete` threaded it into its item
 * shape under a comment warning it must be threaded "or the declaration the gate
 * just forced would be collected and then dropped on the floor", where its only
 * consumer never mentioned it. So it WAS dropped on the floor, one call deeper
 * than that comment guards. A declaration that is validated and discarded is not
 * "strictly more than nothing" — it is exactly nothing, plus a required field on
 * every terminal close; and P-011 cannot consume content that was never written.
 *
 * Now: {@link resolveDeclaredAssumptions} resolves every entry and the caller
 * PERSISTS the result under `TERMINAL_ASSUMPTIONS_KEY`. Only total non-existence
 * dangles — `lapsed`, `superseded` and `retracted` all resolve and carry their
 * condition (D-079 R3; a SUSPECTED fact's default TTL is six hours, so refusing
 * on lapse would punish the exact behaviour this gate encourages).
 */

import { z } from 'zod';
import { InvalidInputError } from '@papercusp/tooldef';
import {
  assumptionSelectorsFor,
  danglingAssumptionsMessage,
  isDanglingCondition,
  resolveAssumptions,
} from '../../agent-facts/assumptions';
import type { StoredAssumptionDeclaration } from '../../coord-lifecycle/records';

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

/**
 * P-008 (d) / D-079 — RESOLVE a declaration against the facts ledger and return
 * what to persist. Throws {@link InvalidInputError} when any entry dangles.
 *
 * ⚠ THE SINGLE ENTRY POINT FOR BOTH COMMITMENT TOOLS. D-050: "a half-verification
 * that resolves on one tool and not the other is worse than none." `set_state`'s
 * terminal branch and `complete`'s per-item path both call exactly this, so the
 * resolution rules, the refusal text, and the stored shape cannot diverge.
 *
 * Resolution is an async DB read, so it CANNOT live in the zod refine that
 * enforces the field's presence — a zod `.refine` is synchronous. Presence is
 * structural (schema); resolvability is semantic (here, at handler time).
 *
 * NOTE the `role` scope is absent from the bare-key search: `AgentIdentity`
 * carries no role, so there is nothing to resolve it against. A role-scoped fact
 * is still citable — with an absolute `fact:role:<role>:<key>` ref, which the
 * resolver reads outside the caller's own selector set precisely for this case.
 */
export async function resolveDeclaredAssumptions(args: {
  declared: AssumptionDeclaration;
  workItemId: string;
  ownerId?: string | null;
  harnessSlug?: string | null;
}): Promise<StoredAssumptionDeclaration> {
  const resolvedAt = new Date().toISOString();
  if (args.declared === NO_ASSUMPTIONS) return { declared: NO_ASSUMPTIONS, resolvedAt };

  const selectors = assumptionSelectorsFor({
    workItemId: args.workItemId,
    ownerId: args.ownerId,
    harnessSlug: args.harnessSlug,
  });
  // Only a GENUINE absence refuses. `resolveAssumptions` fails open to
  // `unresolved` when the ledger could not be read, so a PG blip never turns into
  // a fleet-wide block on closing work — see isDanglingCondition.
  const resolved = await resolveAssumptions(args.declared, selectors);
  const dangling = resolved.filter((r) => isDanglingCondition(r.condition));
  if (dangling.length > 0) {
    throw new InvalidInputError(danglingAssumptionsMessage(dangling, selectors));
  }
  return { declared: resolved, resolvedAt };
}
