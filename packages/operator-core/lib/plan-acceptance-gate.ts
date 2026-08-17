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
import {
  getAcceptanceRubricForPlan,
  getRubric,
  getRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
} from './rubrics';
import { listScorecards } from './scorecards';
import {
  getLatestPlanAudit,
  getPlanItemStatuses,
  repoCitationContextForHarness,
  resolveCitation,
  UNFINISHED_ITEM_STATUSES,
} from './plan-audits';

export type PlanAcceptanceGateCode =
  | 'acceptance_rubric_missing'
  // consult-min-max-and-rubric-vetting-2026-08-17 P-004 — the vetting check.
  | 'acceptance_rubric_unvetted'
  | 'acceptance_ungraded'
  | 'self_graded_only'
  // plan-completion-audit-and-acceptance-verdict-2026-08-13 — the code-truth family.
  | 'plan_items_unfinished'
  | 'acceptance_unaudited'
  | 'audit_coverage_stale'
  | 'audit_citations_unresolved';

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
  /** Set when an explicit reasoned `force` waived the code-truth checks (D-003). The
   *  caller stamps this on the plan so the waiver is permanent and visible, never a
   *  silent bypass — a force that is easy to hide is worth very little. */
  forcedPast?: { reason: string; checks: PlanAcceptanceGateCode[] };
}

export interface PlanAcceptanceGateOpts {
  /**
   * An explicit, reasoned override of the CODE-TRUTH family only —
   * `plan_items_unfinished`, `acceptance_unaudited`, `audit_coverage_stale`,
   * `audit_citations_unresolved` (plan D-003/D-005).
   *
   * It deliberately does NOT waive the rubric family. Those three refusals encode a
   * different owner ruling (an acceptance rubric, graded by someone other than its
   * author) and widening force to cover them would collapse two independent guards
   * into one switch.
   */
  force?: { reason: string };
}

/**
 * Evaluate the acceptance gate for a plan about to be marked shipped/complete.
 * Never throws — an infrastructure failure inside a check degrades toward the
 * feature's default posture for that check (the flag read fails toward ON;
 * the exemption read fails toward "not exempt").
 */
export async function evaluatePlanAcceptanceGate(
  planSlug: string,
  opts: PlanAcceptanceGateOpts = {},
): Promise<PlanAcceptanceGateVerdict> {
  // Each family reads its OWN flag, below, rather than one early return for all of
  // them: the code-truth checks and the rubric checks are independently killable, so
  // rolling back one must not silently disable the other.
  const rubricGate = await getFlag(FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE, 'system').catch(() => true);

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

  // ── the CODE-TRUTH family (plan-completion-audit-…-2026-08-13) ───────────────
  // Ordered cheapest-to-understand first, and ahead of the rubric checks because the
  // audit is authored BEFORE the rubric (D-004): refusing on a missing rubric while
  // the plan still has unbuilt items would send the agent to the wrong repair.
  const forcedChecks: PlanAcceptanceGateCode[] = [];
  const force = opts.force;

  const itemGate = await getFlag(FLAGS.PLAN_ITEM_COMPLETION_GATE, 'system').catch(() => true);
  if (itemGate) {
    const items = await getPlanItemStatuses(planSlug);
    const unfinished = items.filter((i) =>
      (UNFINISHED_ITEM_STATUSES as readonly string[]).includes(i.status),
    );
    if (unfinished.length > 0) {
      if (force) {
        forcedChecks.push('plan_items_unfinished');
      } else {
        const list = unfinished.map((i) => `${i.itemId} (${i.status})`).join(', ');
        return {
          satisfied: false,
          code: 'plan_items_unfinished',
          message:
            `plan '${planSlug}' cannot be marked shipped: ${unfinished.length} item(s) are still unfinished — ` +
            `${list}. Finish them, or — if the work went elsewhere and that was deliberate — DROP each one ` +
            `with a reason: plans:set-status { slug:'${planSlug}', item:'<P-NNN>', status:'dropped', ` +
            `note:'<why this was departed from>' }. Departing from the plan is legitimate; departing from it ` +
            `silently is what this refuses. To ship anyway, pass force:{ reason } — it is recorded on the plan.`,
        };
      }
    }
  }

  const auditGate = await getFlag(FLAGS.PLAN_CODE_AUDIT_GATE, 'system').catch(() => true);
  if (auditGate) {
    const audit = await getLatestPlanAudit(planSlug);
    if (!audit) {
      if (force) {
        forcedChecks.push('acceptance_unaudited');
      } else {
        return {
          satisfied: false,
          code: 'acceptance_unaudited',
          message:
            `plan '${planSlug}' cannot be marked shipped: it has no code-truth audit. Compare every item to ` +
            `the ACTUAL CODE — not the plan text, not the work-item records, not your memory of writing it — ` +
            `then file what you found: plans:audit { slug:'${planSlug}', items:[{ itemId, verdict, citations }] }. ` +
            `Citations are resolved against the real tree, so a path that does not exist is refused. Gaps inside ` +
            `the plan's scope get fixed or dropped with a reason; bugs outside it go in \`findings\` with a filed ` +
            `work-item ref. To ship without one, pass force:{ reason } — it is recorded on the plan.`,
        };
      }
    } else {
      // Coverage is re-checked against the CURRENT item list, not the list as it stood
      // when the audit ran: items added afterwards are exactly the ones nobody looked at.
      const items = await getPlanItemStatuses(planSlug);
      const audited = new Set(audit.items.map((i) => i.itemId));
      const uncovered = items
        .filter((i) => i.status !== 'dropped' && !audited.has(i.itemId))
        .map((i) => i.itemId);
      if (uncovered.length > 0) {
        if (force) {
          forcedChecks.push('audit_coverage_stale');
        } else {
          return {
            satisfied: false,
            code: 'audit_coverage_stale',
            message:
              `plan '${planSlug}' cannot be marked shipped: audit #${audit.auditSeq} does not cover ` +
              `${uncovered.length} current item(s) — ${uncovered.join(', ')}. These were added or reopened after ` +
              `the audit ran, so nothing has checked them against the code. Re-run plans:audit covering them ` +
              `(a fresh pass appends, it does not overwrite). To ship anyway, pass force:{ reason }.`,
          };
        }
      } else {
        // The tree MOVES between audit and ship, so the stored audit is not trusted:
        // every code/test citation is resolved again, now. A citation that resolved at
        // audit time and does not resolve today means the evidence for that item is gone.
        const broken: string[] = [];
        const citationContext = await repoCitationContextForHarness(audit.harnessSlug);
        if (!citationContext) {
          broken.push(`audit harness '${audit.harnessSlug}' has no registered canonical source root`);
        } else {
          for (const entry of audit.items) {
            for (const c of entry.citations) {
              if (c.kind !== 'code' && c.kind !== 'test') continue;
              const res = resolveCitation(c, citationContext.deps);
              if (!res.ok) broken.push(`${entry.itemId} → ${c.path ?? '(no path)'} (${res.reason})`);
            }
          }
        }
        if (broken.length > 0) {
          if (force) {
            forcedChecks.push('audit_citations_unresolved');
          } else {
            return {
              satisfied: false,
              code: 'audit_citations_unresolved',
              message:
                `plan '${planSlug}' cannot be marked shipped: ${broken.length} citation(s) in audit ` +
                `#${audit.auditSeq} no longer resolve against the tree — ${broken.slice(0, 5).join('; ')}` +
                `${broken.length > 5 ? ` (+${broken.length - 5} more)` : ''}. The code moved after the audit, so ` +
                `the evidence for those items is stale. Re-run plans:audit against the current tree. To ship ` +
                `anyway, pass force:{ reason }.`,
            };
          }
        }
      }
    }
  }

  // ── the RUBRIC family (acceptance-rubrics-on-every-plan-2026-08-11) ──────────
  // Independently flagged, and NOT waivable by `force` (D-005): it encodes a separate
  // owner ruling, and collapsing both families into one switch would make the override
  // far broader than the one that was actually authorised.
  if (!rubricGate) {
    return {
      satisfied: true,
      skipped: 'flag-off',
      ...(forcedChecks.length > 0 && force ? { forcedPast: { reason: force.reason, checks: forcedChecks } } : {}),
    };
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

  // ── the VETTING check (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
  // Ordered BEFORE the grading checks because it is the earlier step of the flow: the
  // rubric AUTHOR vets the RUBRIC (informed by a get_feedback consult, min 1 / max 3
  // responders) before a non-implementer grades the WORK against it. The pass is the
  // vetting agent's ATTESTATION — a complete meta-scorecard on the CURRENT rubric
  // revision with a linked consult; deliberately NO mechanical score floor (D-001 §3),
  // so the ratings' values are never inspected here. Independently flagged and, like
  // the sibling rubric checks, NOT waivable by `force` (D-005).
  const vettingGate = await getFlag(FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE, 'system').catch(() => true);
  // Exempt: a criteria:[] investigation rubric (D-009 — nothing to vet) and the
  // meta-rubric itself (kind:'standard' so it can never be a plan's acceptance rubric,
  // but the guard is cheap and the regress would be infinite).
  if (vettingGate && rubric.criteria.length > 0 && rubric.rubricId !== META_ACCEPTANCE_RUBRIC_ID) {
    // Prerequisite: a REGISTERED meta-rubric, any status — 'proposed' counts, because
    // ratification governs content authority, not gate mechanics; a workspace with no
    // meta-rubric at all cannot run the flow, so the check disables rather than
    // deadlocking every ship on a missing prerequisite (recorded as a plan Decision).
    const metaRubric = await getRubric(META_ACCEPTANCE_RUBRIC_ID);
    if (metaRubric) {
      const currentRevision = await getRubricPlanRevision(rubric.rubricId);
      const metaCards = (
        await listScorecards({ rubricRef: META_ACCEPTANCE_RUBRIC_ID, subjectRef: rubric.rubricId, limit: 50 })
      ).filter((s) => s.rubricResolved && s.missingKeys.length === 0 && !s.synthesized);
      // The linked consult is what makes an attestation a VETTING (a plain meta-grade
      // without one skipped the external critique the flow exists to inject).
      const vettedCards = metaCards.filter((s) => s.vetting?.consultId);
      const current = vettedCards.find(
        (s) => currentRevision == null || s.vetting?.rubricRevision === currentRevision,
      );
      if (!current) {
        const vettedRevisions = [
          ...new Set(vettedCards.map((s) => s.vetting?.rubricRevision).filter((v) => v != null)),
        ];
        const stale = vettedCards.length > 0;
        return {
          satisfied: false,
          code: 'acceptance_rubric_unvetted',
          rubricId: rubric.rubricId,
          message: stale
            ? `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' was vetted at ` +
              `revision ${vettedRevisions.join('/') || '(unrecorded)'} but the rubric is now at revision ` +
              `${currentRevision} — the content changed after vetting, so the attestation no longer covers what ` +
              `ships. Re-emit the meta-scorecard against the current revision: scorecards:emit ` +
              `{ rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, ` +
              `vettingConsult:'<consult conversation_id>', ratings:{ <every meta criterion> } }. Citing the SAME ` +
              `consult is fine when the revision IS the improvement its critique asked for.`
            : `plan '${planSlug}' cannot be marked shipped: its acceptance rubric '${rubric.rubricId}' has not ` +
              `been VETTED against the meta-rubric (consult-min-max-and-rubric-vetting-2026-08-17). The rubric ` +
              `AUTHOR vets it BEFORE a non-implementer grades the work: (1) consult:get_feedback for external ` +
              `critique of the rubric (selection is automatic, min 1 / max 3 responders), (2) improve the rubric ` +
              `from the critique (rubrics:propose), (3) attest: scorecards:emit ` +
              `{ rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, ` +
              `vettingConsult:'<the consult conversation_id>', ratings:{ <every meta criterion, with evidence> } }. ` +
              `Pass is your judgment per criterion — no mechanical score floor (D-001 §3).`,
        };
      }
    }
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
  return {
    satisfied: true,
    rubricId: rubric.rubricId,
    gradedBy: independent.createdBy ?? null,
    ...(forcedChecks.length > 0 && force ? { forcedPast: { reason: force.reason, checks: forcedChecks } } : {}),
  };
}
