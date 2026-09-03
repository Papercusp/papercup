/**
 * The one place an ACCEPTANCE-DRAIN work item is written — P-020 of
 * design-to-code-coverage-seam-2026-09-02 (D-032).
 *
 * # The defect this closes
 *
 * Entry into `awaiting-acceptance` is AUTOMATED and exit is not, so the state
 * accumulates monotonically:
 *
 *   - `plan-drain-rule.ts` (reaction) and `plan-drain-sweep.ts` (backstop) flip a
 *     plan to `awaiting-acceptance` the moment its last item goes terminal.
 *   - `applyPlanDrainTransition` performs a bare frontmatter flip and nothing
 *     else. Its own header says "Whether the rubric has been authored yet is the
 *     next ACTION, not a different state" — and nothing anywhere takes that next
 *     action, files it, or tells a soul.
 *   - Exit is a seven-step ceremony whose refusals are only ever seen by someone
 *     who explicitly attempts a ship or asks `plans:get { shipReadiness }`.
 *
 * Measured over ALL 187 awaiting-acceptance papercusp plans (D-032, full census
 * via the same evaluator `plans:set-plan-status` enforces): 161 (86.1%) have
 * never had `plans:audit` run even once, and the oldest has been sitting since
 * 2026-06-04. That population does not shrink on its own, for exactly the reason
 * `plan-drain-sweep.ts` gives about its own backlog: nothing will ever re-examine
 * it, because the event that would have is already in the past.
 *
 * # Why this files work instead of notifying an author
 *
 * `spec-triad-sweep.ts` states the standing design mandate this obeys, verbatim:
 * "a design that routes a decision to a person is a defect. Nothing here
 * escalates, notifies a human, or waits for approval — it files claimable work."
 * Notifying each plan's author would ALSO be the wrong instrument on the facts:
 * these plans' authors are overwhelmingly ended sessions, so a notify is a
 * message to nobody, while a claimable item can be drained by any agent.
 *
 * # Why the body carries the gate's OWN message
 *
 * `evaluatePlanAcceptanceGate` already writes a precise, actionable repair into
 * every refusal — `acceptance_unaudited` names the literal
 * `plans:audit { slug, items:[{ itemId, verdict, citations }] }` call to make.
 * That instruction has always existed and has simply never been DELIVERED to
 * anyone. So this filer quotes the live verdict rather than restating it: a
 * second copy of the repair text would drift from the gate that enforces it,
 * which is the derived-truth ladder's whole point.
 *
 * The dedupe key is `payload.acceptanceDrainPlan` — the plan's fully-qualified
 * `workspace/harness/slug` ref, for the same reason spec-triad uses one: two
 * tenants can hold a plan of the same name, and suppressing one tenant's filing
 * because another has one open would strand a lane with no way to notice.
 */

import { getOrgPg } from '@papercusp/db-org';
import { upsertConditionWorkItem } from '../../coord/condition-upsert';

/**
 * Work-item statuses that mean an existing filing is still outstanding.
 *
 * Kept identical to `SPEC_TRIAD_NON_TERMINAL_STATUSES` rather than imported from
 * it: the two sweeps file against different gates and must be able to diverge
 * without one silently redefining the other's idea of "still open".
 */
export const ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES = [
  'open',
  'todo',
  'wip',
  'in_progress',
  'blocked',
  'needs-human',
  'validating',
  'failing',
];

export interface AcceptanceDrainFilingInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** The gate's first refusal code, e.g. `acceptance_unaudited`. */
  code: string;
  /** The gate's own refusal message — quoted, never paraphrased. */
  message: string;
}

export type AcceptanceDrainFilingOutcome = 'created' | 'already-open' | 'error';

export interface AcceptanceDrainFilingResult {
  outcome: AcceptanceDrainFilingOutcome;
  id: string | null;
  ref: string;
  error?: string;
}

export function acceptanceDrainPlanRef(i: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): string {
  return `${i.workspaceId}/${i.harnessSlug}/${i.planSlug}`;
}

/**
 * The item body. Extracted so every caller says exactly the same thing.
 *
 * `message` is the gate's live text and is quoted whole. The surrounding prose
 * says only what the gate does NOT say: which state the plan is in, that the
 * refusal short-circuits (so clearing this code can reveal another), and that
 * dropping the plan is a legitimate resolution.
 */
export function acceptanceDrainFilingBody(
  planSlug: string,
  code: string,
  message: string,
): string {
  return (
    `Plan \`${planSlug}\` is sitting in \`awaiting-acceptance\` — its items are all terminal, ` +
    `so the implementation is done, but the plan is NOT shipped and nothing is moving it.\n\n` +
    `**Its first ship-gate blocker right now is \`${code}\`.**\n\n` +
    `The gate's own instruction, quoted verbatim from \`evaluatePlanAcceptanceGate\`:\n\n` +
    `> ${message}\n\n` +
    `**Read this before starting:** the gate SHORT-CIRCUITS on its first refusal, so clearing ` +
    `\`${code}\` can reveal another behind it. Re-read \`plans:get { slug:'${planSlug}', ` +
    `shipReadiness: true }\` after each step rather than assuming this is the only thing owed. ` +
    `The code-truth family (items finished → audit → citations → requirements) is checked ` +
    `ENTIRELY BEFORE the rubric family, so do not author a rubric first — on a plan that owes ` +
    `an audit it moves the gate by exactly zero (D-032).\n\n` +
    `**You do not have to be the plan's original author.** A code-truth audit compares each ` +
    `item to the ACTUAL CODE — not the plan text, not the work-item records, not anyone's ` +
    `memory of writing it — so it is performable by whoever picks this up. Citations are ` +
    `re-resolved against the real tree, so a path that does not exist is refused.\n\n` +
    `**If this plan should not ship at all**, that is a legitimate resolution and not a ` +
    `failure: supersede or archive it, or drop its residual items with a reason, and close ` +
    `this item with that as the completion evidence. What is not acceptable is leaving it ` +
    `where it is — the backlog's oldest entry has been in this state since 2026-06-04.`
  );
}

/**
 * File the acceptance-drain work item for a plan, unless one is already open.
 *
 * Never throws. The caller is a periodic sweep, and a DBOS step that throws is
 * marked permanently dead — i.e. one transient PG error would stop this sweep
 * FOREVER, silently, which is the same shape of invisible stall the sweep exists
 * to fix. A failure is returned, logged by the caller, and retried next pass.
 */
export async function ensureAcceptanceDrainFiling(
  input: AcceptanceDrainFilingInput,
): Promise<AcceptanceDrainFilingResult> {
  const ref = acceptanceDrainPlanRef(input);
  try {
    const { sql } = getOrgPg();
    // Payload fast-path, mirroring spec-triad-filing: adopt an existing open
    // filing rather than letting a keyed sibling join it. Cheap, and it also
    // covers any row filed before this condition key existed.
    const open = (await sql`
      SELECT 1
        FROM harness_shared.work_items
       WHERE payload->>'acceptanceDrainPlan' = ${ref}
         AND status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
       LIMIT 1
    `) as unknown as unknown[];
    if (open.length > 0) return { outcome: 'already-open', id: null, ref };

    // The read above is check-then-act and therefore RACED; the upsert claims the
    // unique condition-key index so a concurrent double-file resolves to ONE open
    // item regardless of timing (the failure WI-39594 recorded for spec-triad,
    // which filed 11 exact-title pairs before it was keyed). The key embeds
    // harness + plan, which is workspace-unique by construction.
    const res = await upsertConditionWorkItem(
      `acceptance-drain:${input.harnessSlug}/${input.planSlug}`,
      {
        kind: 'task',
        harness: input.harnessSlug,
        workspaceId: input.workspaceId,
        createdBy: 'system:acceptance-drain',
        title: `Unstick plan '${input.planSlug}' from awaiting-acceptance — blocked on ${input.code}`,
        summary: acceptanceDrainFilingBody(input.planSlug, input.code, input.message),
        payload: {
          acceptanceDrainPlan: ref,
          planSlug: input.planSlug,
          blockerCode: input.code,
        },
      },
    );
    return res.created
      ? { outcome: 'created', id: res.id, ref }
      : { outcome: 'already-open', id: res.id, ref };
  } catch (err) {
    return { outcome: 'error', id: null, ref, error: (err as Error).message };
  }
}
