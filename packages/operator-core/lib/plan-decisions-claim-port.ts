/**
 * plan-decisions-claim-port.ts — surface a plan's governing Decisions at CLAIM
 * time (agent-trap-guards-2026-07-26 P-003b).
 *
 * Rationale (recorded live on the same plan, D-002): a leader ruling recorded
 * via `plans:add-decision` is auditable and re-readable — but only for an
 * agent who thinks to go look. A member who never re-reads the plan's
 * Decisions section before acting on a claimed item gets none of that benefit.
 * This port closes the gap the OTHER way: attach a compact brief of the
 * claimed item's plan's CURRENT decisions to the claim result itself
 * (scheduler:get_next / work_items:claim / work_items:claim_next), so seeing
 * the governing rulings costs zero extra round-trips — mirroring the existing
 * claim-time checkpoint hint (./work-item-checkpoint) and memory recall port
 * (./memory/claim-port), which attach at exactly the same seam for the same
 * reason.
 *
 * Fail-soft by contract, like those two ports: a lookup miss, an unresolved
 * plan slug, or a parse error degrades to `null` — this is decoration on a
 * claim, never a new way for the claim path to fail.
 */
import { planSlugOfWorkItem } from './scheduler/claim-spec-match';
import type { WorkItem } from './work-items';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';
import { clampSnippet } from './agent-tools/coordination/ref-hydrate';

export interface ClaimTimePlanDecision {
  id: string;
  title: string;
  /** Bounded verbatim excerpt — `plans:get { slug, heading:'Decisions' }` (or
   *  mode:'full') for the complete body. */
  snippet: string;
}

export interface ClaimTimePlanDecisionsBrief {
  planSlug: string;
  decisions: ClaimTimePlanDecision[];
}

/** Per-decision excerpt cap — generous enough to read the ruling's substance
 *  inline without re-fetching for the routine case, bounded so a decision-heavy
 *  plan can't overflow the claim payload the same way plans:get's own
 *  DECISION_BODY_CAP bounds its `sections` mode. */
const SNIPPET_CHARS = 240;
/** Cap on how many decisions ride the claim payload — a plan with more than
 *  this has a decision LOG, not a short list of live rulings; the excess stays
 *  one `plans:get` away. */
const MAX_DECISIONS = 8;

/**
 * Resolve the CURRENT structured Decisions (`### D-NNN` entries — see
 * `@papercusp/plan-parser`) for the plan the just-claimed work-item belongs
 * to. Returns `null` when: the item carries no plan_item back-pointer, the
 * plan slug doesn't resolve, or the plan has zero PARSED decisions (the
 * common case for most plans — must stay silent rather than noise every
 * claim). An informally-authored Decisions section (bare `- **D-NNN** ...`
 * bullets rather than the `### D-NNN` heading form) is NOT parsed here either
 * — same known limitation `plans:add-decision`'s id allocator already works
 * around for allocation; authoring decisions via `plans:add-decision` (rather
 * than hand-editing the plan body) keeps them in the structured, surfaced
 * form.
 */
export async function getClaimTimePlanDecisions(opts: {
  workItem: Pick<WorkItem, 'payload'>;
  harness?: string | null;
  workspaceId?: string | null;
}): Promise<ClaimTimePlanDecisionsBrief | null> {
  const planSlug = planSlugOfWorkItem(opts.workItem as WorkItem);
  if (!planSlug) return null;
  try {
    const row = await getPlanRow(planSlug, {
      ...(opts.harness ? { harnessSlug: opts.harness } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    if (!row) return null;
    const decisions = parsePlan(row.content).decisions;
    if (!decisions.length) return null;
    return {
      planSlug,
      decisions: decisions.slice(0, MAX_DECISIONS).map((d) => ({
        id: d.id,
        title: d.title,
        snippet: clampSnippet(d.body, SNIPPET_CHARS),
      })),
    };
  } catch {
    return null;
  }
}
