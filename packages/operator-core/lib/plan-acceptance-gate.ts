/**
 * plan-acceptance-gate — the plan-completion acceptance gate
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-004/P-005).
 *
 * Owner-ruled model (D-007/D-008, [owner 2026-08-11]): every plan carries a gradeable
 * definition-of-done as an ACCEPTANCE-kind rubric (kind:'acceptance', subjectPlan =
 * the plan), authored AFTER implementation — better informed, and no tokens wasted on
 * criteria a mid-implementation redesign would invalidate. The single enforcement
 * point is COMPLETION: plan → shipped refuses unless the rubric exists AND a
 * NON-implementer graded it (grader ≠ rubric author, mirroring blender:grade-idea's
 * self-grade refusal). There is deliberately no gate at plans:new / plans:start.
 *
 * This module exists (rather than inlining in set-plan-status.ts) because rubrics.ts
 * cannot import scorecards.ts (scorecards already imports rubrics — a cycle), and any
 * future completion surface (a work-items completion audit, a plans:complete verb)
 * should read the SAME verdict rather than re-derive it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from './workspace-registry';
import { RUBRIC_TEMPLATE_NAME } from './agent-tools/plans/rubric-template';
import { getAcceptanceRubricForPlan } from './rubrics';
import { listScorecards } from './scorecards';

export type PlanAcceptanceGateCode = 'acceptance_rubric_missing' | 'acceptance_ungraded' | 'self_graded_only';

export interface PlanAcceptanceGateVerdict {
  satisfied: boolean;
  /** Why the gate did not apply (satisfied:true without a graded rubric). */
  skipped?: 'flag-off' | 'rubric-template-plan' | 'template-instance';
  /** Why the gate refused (satisfied:false). */
  code?: PlanAcceptanceGateCode;
  /** Teaching message for the refusal — the authoring/grading nudge (P-004). */
  message?: string;
  /** The acceptance rubric involved, when one exists. */
  rubricId?: string;
  /** The independent grader satisfying the gate, when satisfied by a grading. */
  gradedBy?: string | null;
}

/**
 * Evaluate the acceptance gate for a plan about to be marked shipped/complete.
 * Never throws — an infrastructure failure inside a check degrades toward the
 * feature's default posture for that check (the flag read fails toward ON;
 * the exemption read fails toward "not exempt").
 */
export async function evaluatePlanAcceptanceGate(planSlug: string): Promise<PlanAcceptanceGateVerdict> {
  const enabled = await getFlag(FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE, 'system').catch(() => true);
  if (!enabled) return { satisfied: true, skipped: 'flag-off' };

  // Exemptions: a rubric-template plan does not get an acceptance rubric of its own
  // (infinite regress), and a scheduled template INSTANCE is an auto-generated
  // recurrence, not authored work (disclosed in the plan's D-008 discussion).
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ plan_slug: string; template: string | null; template_slug: string | null }[]>`
      SELECT plan_slug, template, template_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       LIMIT 1`;
    const row = rows.find((r) => r.plan_slug === planSlug);
    if (row?.template === RUBRIC_TEMPLATE_NAME) return { satisfied: true, skipped: 'rubric-template-plan' };
    if (row?.template_slug) return { satisfied: true, skipped: 'template-instance' };
  } catch {
    /* not exempt — fall through to the rubric check */
  }

  const rubric = await getAcceptanceRubricForPlan(planSlug);
  if (!rubric) {
    return {
      satisfied: false,
      code: 'acceptance_rubric_missing',
      message:
        `plan '${planSlug}' cannot be marked shipped: it has no acceptance rubric ` +
        `(acceptance-rubrics-on-every-plan-2026-08-11). Author it NOW, post-implementation (D-007 — it is ` +
        `better informed against the as-built work): rubrics:propose { kind:'acceptance', subjectPlan:'${planSlug}', ` +
        `classRef:'<plan-class-feature-ship|plan-class-bugfix|plan-class-migration|plan-class-investigation>', ` +
        `criteria:[3–7 outcomes tracing to the plan's goal + Decisions — never merely describing the diff] } ` +
        `(a pure investigation may pass classRef:'plan-class-investigation' with criteria:[] — D-009). ` +
        `It activates immediately (no ratification); then a ` +
        `NON-implementer grades it (scorecards:emit) and the ship succeeds.`,
    };
  }

  // A qualifying grading: complete (every criterion rated), agent-emitted (synthesized
  // floors are excluded by listScorecards' default), against THIS rubric.
  const scorecards = await listScorecards({ rubricRef: rubric.rubricId, limit: 50 });
  const complete = scorecards.filter((s) => s.rubricResolved && s.missingKeys.length === 0 && !s.synthesized);
  const implementer = rubric.proposedBy ?? rubric.createdBy ?? null;
  if (complete.length === 0) {
    return {
      satisfied: false,
      code: 'acceptance_ungraded',
      rubricId: rubric.rubricId,
      message:
        `plan '${planSlug}' cannot be marked shipped: its acceptance rubric '${rubric.rubricId}' has no complete ` +
        `grading. A NON-implementer${implementer ? ` (someone other than '${implementer}')` : ''} grades it — ` +
        `scorecards:emit { rubricRef:'${rubric.rubricId}', ratings:{ <every criterion key> } } with concrete ` +
        `evidence per rating — then the ship succeeds (grader ≠ implementer, plan D-005).`,
    };
  }
  const independent = complete.find((s) => !implementer || (s.createdBy != null && s.createdBy !== implementer));
  if (!independent) {
    return {
      satisfied: false,
      code: 'self_graded_only',
      rubricId: rubric.rubricId,
      message:
        `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' is only graded by its ` +
        `own author ('${implementer}') — grader ≠ implementer (plan D-005, the self-graded-homework guard). A ` +
        `different agent or the owner must file the grading scorecard.`,
    };
  }
  return { satisfied: true, rubricId: rubric.rubricId, gradedBy: independent.createdBy ?? null };
}
