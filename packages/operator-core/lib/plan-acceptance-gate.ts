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
 * The VETTING check (consult-min-max-and-rubric-vetting-2026-08-17 P-004) sits inside
 * the rubric family: before the work is graded, the rubric AUTHOR vets the RUBRIC
 * against the meta-rubric (META_ACCEPTANCE_RUBRIC_ID), informed by a get_feedback
 * consult — the gate refuses (acceptance_rubric_unvetted) unless the CURRENT rubric
 * revision carries a complete meta-scorecard with a linked consult.
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
import { getAcceptanceRubricForPlan, getRubric, getRubricPlanRevision, META_ACCEPTANCE_RUBRIC_ID } from './rubrics';
import { listScorecards } from './scorecards';
import { isAcceptanceAuthorIdentity } from './acceptance-author-identity';
import {
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageGateVerdict,
} from './agent-tools/plans/plan-spec-coverage-gate';
import {
  citationBlobSha,
  getEffectiveItemAudits,
  getLatestPlanAudit,
  getPlanItemStatuses,
  planItemTextHash,
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
  | 'acceptance_not_recorded'
  | 'acceptance_rejected'
  // plan-completion-audit-and-acceptance-verdict-2026-08-13 — the code-truth family.
  | 'plan_items_unfinished'
  | 'acceptance_unaudited'
  | 'audit_coverage_stale'
  | 'audit_citations_unresolved'
  // first-class-spec-clauses-…-2026-08-20 P-008 — the spec-proof half of code truth.
  | 'spec_proof_stale'
  // …P-013 widened it: a clause with NO evidence at any revision now refuses too. Both
  // codes are carried through from the census verbatim so the author is told which of the
  // two actually happened — re-prove a stale binding, or bind one that never existed.
  | 'spec_clause_unproven'
  /** Never accompanies a refusal (the census degrades to report-only), carried for the union's honesty. */
  | 'spec_coverage_unavailable';

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
  /** EI-20821478338037350: the vetting attestation that satisfied the gate was made
   *  over a consult NOBODY critiqued, under an explicit recorded waiver. The ship is
   *  allowed (a dead reviewer pool is a real condition), but for the same reason
   *  `forcedPast` exists it must not be silent: this rubric received no external
   *  critique, and a reader of the verdict is entitled to know that. */
  vettedUnderWaiver?: { consultId: string; reason?: string };
  /**
   * P-008's structured spec-coverage aggregate — current clauses, adequacy scorecards,
   * exemptions and proof freshness — carried on BOTH the refusal it produces and the
   * satisfied verdict, so a reader of a successful ship can still see what was proven
   * and what merely went unreported. Absent when its own flag is off, when the plan is
   * exempt, and on the refusals that precede it (the item/audit family) or that follow
   * it on a different axis entirely (the rubric family's ceremony checks).
   *
   * ⚠ Its `reports` are ADVISORY: an enforceable clause with no evidence at all is
   * named there and deliberately does NOT refuse (D-018). A caller rendering `reports`
   * as a failure has imported P-013's enforcement early.
   */
  specCoverage?: PlanSpecCoverageGateVerdict;
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
 * D-001's one-time compatibility boundary. Scorecards created before the verdict
 * write surface existed had no way to carry `acceptance`; a qualifying legacy
 * independent grading therefore counts as accepted. Newer gradings must complete
 * the explicit implementer-verdict leg.
 */
export const ACCEPTANCE_VERDICT_REQUIRED_AFTER = '2026-08-21T00:00:00.000Z';

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
  // Read once, for two purposes: the exemption test below, and the harness slug the
  // spec-coverage census needs to scope its clause read (P-008).
  let planHarnessSlug: string | null = null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      { plan_slug: string; harness_slug: string | null; template: string | null; template_slug: string | null }[]
    >`
      SELECT plan_slug, harness_slug, template, template_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       LIMIT 1`;
    const row = rows.find((r) => r.plan_slug === planSlug);
    planHarnessSlug = row?.harness_slug ?? null;
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
    const unfinished = items.filter((i) => (UNFINISHED_ITEM_STATUSES as readonly string[]).includes(i.status));
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
      // D-006/D-007: a pass is NOT a full-plan snapshot. Resolve the latest entry
      // per item across every pass, then compare only that item's requirement and
      // evidence with the current tree. A narrow re-audit therefore cannot make all
      // the unchanged items disappear, and carrying an item cannot re-stamp it.
      const [items, effectiveAudits] = await Promise.all([
        getPlanItemStatuses(planSlug),
        getEffectiveItemAudits(planSlug),
      ]);
      const effectiveByItem = new Map(effectiveAudits.map((entry) => [entry.entry.itemId, entry]));
      const stale: string[] = [];
      const broken: string[] = [];
      const hasVerifyingCitations = effectiveAudits.some(({ entry }) =>
        entry.citations.some((citation) => citation.kind === 'code' || citation.kind === 'test'),
      );
      const citationContext = hasVerifyingCitations
        ? await repoCitationContextForHarness(
            audit.harnessSlug,
            effectiveAudits.flatMap(({ entry }) => entry.citations),
          )
        : null;

      if (hasVerifyingCitations && !citationContext) {
        broken.push(`audit harness '${audit.harnessSlug}' has no registered canonical source root`);
      }

      for (const item of items) {
        // A deliberate drop is the recorded exit supplied by D-002. It does not need
        // code evidence and must not be resurrected as an audit obligation.
        if (item.status === 'dropped') continue;

        const effective = effectiveByItem.get(item.itemId);
        if (!effective) {
          stale.push(`${item.itemId}: no audit entry`);
          continue;
        }

        const reasons: string[] = [];
        const { entry, auditSeq } = effective;
        if ((UNFINISHED_ITEM_STATUSES as readonly string[]).includes(item.status)) {
          reasons.push(`status '${item.status}' is unfinished/reopened since audit #${auditSeq}`);
        }
        if (!entry.itemTextHash) {
          reasons.push(`item-text fingerprint is missing from audit #${auditSeq}`);
        } else if (entry.itemTextHash !== planItemTextHash(item.itemText)) {
          reasons.push(`item text changed since audit #${auditSeq}`);
        }

        if (citationContext) {
          for (const citation of entry.citations) {
            // D-008: only code/test citations constitute verification. Doc/none
            // declarations never become code-truth merely by surviving this read.
            if (citation.kind !== 'code' && citation.kind !== 'test') continue;
            const resolution = resolveCitation(citation, citationContext.deps);
            if (!resolution.ok) {
              broken.push(
                `${item.itemId} (audit #${auditSeq}) → ${citation.path ?? '(no path)'} (${resolution.reason})`,
              );
              continue;
            }

            const currentBlobSha = citationBlobSha(citation, citationContext.deps);
            if (!citation.blobSha) {
              reasons.push(`${citation.path ?? '(no path)'} has no audit-time blob fingerprint (audit #${auditSeq})`);
            } else if (!currentBlobSha) {
              reasons.push(`${citation.path ?? '(no path)'} cannot be fingerprinted now (audit #${auditSeq})`);
            } else if (currentBlobSha !== citation.blobSha) {
              reasons.push(`${citation.path ?? '(no path)'} changed since audit #${auditSeq}`);
            }
          }
        }

        if (reasons.length > 0) stale.push(`${item.itemId}: ${reasons.join('; ')}`);
      }

      // Keep the advertised refusal order: coverage/text/blob drift first, broken
      // citations second, and both ahead of rubric ceremony. A force records every
      // check it waived instead of hiding later failures behind the first one.
      if (stale.length > 0) {
        if (force) {
          forcedChecks.push('audit_coverage_stale');
        } else {
          return {
            satisfied: false,
            code: 'audit_coverage_stale',
            message:
              `plan '${planSlug}' cannot be marked shipped: ${stale.length} item audit(s) are missing or stale — ` +
              `${stale.join('; ')}. Re-run plans:audit for ONLY the listed items. Every unlisted item carries ` +
              `forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. ` +
              `If no items are listed on a future check, no new audit pass is required. To ship anyway, pass ` +
              `force:{ reason }.`,
          };
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
              `plan '${planSlug}' cannot be marked shipped: ${broken.length} effective audit citation(s) no ` +
              `longer resolve against the tree — ${broken.slice(0, 5).join('; ')}` +
              `${broken.length > 5 ? ` (+${broken.length - 5} more)` : ''}. Re-run plans:audit for ONLY the ` +
              `listed items; all other item audits carry forward unchanged. To ship anyway, pass force:{ reason }.`,
          };
        }
      }
    }
  }

  // ── the SPEC-PROOF check (first-class-spec-clauses-…-2026-08-20 P-008) ───────
  // Last of the code-truth family and still ahead of rubric ceremony, for the reason
  // the audit checks are: a plan whose promises are no longer proven should be sent to
  // re-prove them, not to author a rubric. The audit asks whether the CODE still matches
  // what was claimed; this asks whether the PROMISE is still proven at the revision that
  // is actually in force — a clause revised after its evidence was recorded has green
  // proof for a promise nobody makes any more.
  //
  // Independently flagged, and `force`-waivable like its code-truth siblings: it is an
  // evidence-truth check, not the separate owner ruling the rubric family encodes.
  let specCoverage: PlanSpecCoverageGateVerdict | undefined;
  const specCoverageGate = await getFlag(FLAGS.PLAN_SPEC_COVERAGE_GATE, 'system').catch(() => true);
  if (specCoverageGate) {
    specCoverage = await evaluatePlanSpecCoverageGate({
      ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
      planSlug,
    });
    if (!specCoverage.satisfied) {
      // ⚠ Carry the census's OWN code through rather than hardcoding one. This said
      // `spec_proof_stale` on both legs, which was true while that was the only refusal
      // this gate could produce. P-013 added `spec_clause_unproven`, and a hardcoded code
      // would have reported "proven only at a superseded revision" for a clause that has
      // no proof at all — telling the author to re-bind evidence that was never there.
      // A misdiagnosis is worse than a bare refusal: it sends someone to fix the wrong
      // thing and reads as authoritative while doing it.
      const code = specCoverage.code ?? 'spec_proof_stale';
      if (force) {
        forcedChecks.push(code);
      } else {
        return {
          satisfied: false,
          code,
          message: specCoverage.message ?? `plan '${planSlug}' has spec clauses proven only at a superseded revision.`,
          specCoverage,
        };
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
      ...(specCoverage ? { specCoverage } : {}),
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
  // EI-20821478338037350: carried out of the vetting block so the SATISFIED verdict can
  // report a no-critique waiver. Set only when the attesting card says so explicitly.
  let vettedUnderWaiver: { consultId: string; reason?: string } | undefined;
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
      // The linked critique channel is what makes an attestation a VETTING (a plain
      // meta-grade without one skipped the external critique the flow exists to
      // inject). WI-41477: either channel counts — a get_feedback consult, or the
      // review work-item a launched independent reviewer's comments land on.
      const vettedCards = metaCards.filter((s) => s.vetting?.consultId || s.vetting?.workItemId);
      const current = vettedCards.find((s) => currentRevision == null || s.vetting?.rubricRevision === currentRevision);
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
      // The unanswered waiver exists only on the consult channel (a work-item link
      // with no third-party comment is refused at emit, never waived), so a waived
      // stamp always carries its consultId.
      if (current.vetting?.unanswered && current.vetting.consultId) {
        vettedUnderWaiver = {
          consultId: current.vetting.consultId,
          ...(current.vetting.unansweredReason ? { reason: current.vetting.unansweredReason } : {}),
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
  const implementerIdentities = new Set<string>();
  if (implementer) {
    implementerIdentities.add(implementer);
    const candidateIds = [...new Set(complete.map((s) => s.createdBy).filter((id): id is string => id != null))];
    await Promise.all(
      candidateIds.map(async (candidateId) => {
        if (await isAcceptanceAuthorIdentity(implementer, candidateId, { workspaceId: rubric.workspaceId })) {
          implementerIdentities.add(candidateId);
        }
      }),
    );
  }
  const isImplementerScorecard = (scorecard: (typeof complete)[number]) =>
    scorecard.createdBy != null && implementerIdentities.has(scorecard.createdBy);
  const independent = complete
    .filter((s) => !implementer || (s.createdBy != null && !isImplementerScorecard(s)))
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
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
  const explicitVerdicts = implementer ? complete.filter((s) => isImplementerScorecard(s) && s.acceptance) : [];
  // listScorecards is newest-first, but sort defensively because tests/injected
  // readers are not required to preserve the storage ordering contract.
  const latestVerdict = explicitVerdicts.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const verdictFollowsLatestIndependent = latestVerdict
    ? Date.parse(independent.createdAt) <= Date.parse(latestVerdict.createdAt)
    : false;
  const latestIndependentIsLegacy = Date.parse(independent.createdAt) < Date.parse(ACCEPTANCE_VERDICT_REQUIRED_AFTER);
  if (!verdictFollowsLatestIndependent && !latestIndependentIsLegacy) {
    return {
      satisfied: false,
      code: 'acceptance_not_recorded',
      rubricId: rubric.rubricId,
      gradedBy: independent.createdBy ?? null,
      message:
        `plan '${planSlug}' has a complete independent grading by '${independent.createdBy ?? 'unknown'}', but ` +
        `its implementer${implementer ? ` ('${implementer}')` : ''} has not recorded the post-grading acceptance ` +
        `call. After reading that grading, the rubric author must run scorecards:emit ` +
        `{ rubricRef:'${rubric.rubricId}', ratings:{ <every criterion key> }, ` +
        `acceptance:{ verdict:'accept'|'reject', reasoning:'<why this grading is acceptable or not>' } }.`,
    };
  }
  if (verdictFollowsLatestIndependent && latestVerdict?.acceptance?.verdict === 'reject') {
    return {
      satisfied: false,
      code: 'acceptance_rejected',
      rubricId: rubric.rubricId,
      gradedBy: independent.createdBy ?? null,
      message:
        `plan '${planSlug}' cannot be marked shipped: implementer '${implementer}' recorded REJECT — ` +
        `${latestVerdict.acceptance.reasoning}. Address the grading, then record a newer acceptance verdict with ` +
        `scorecards:emit; the latest implementer verdict is authoritative.`,
    };
  }
  return {
    satisfied: true,
    rubricId: rubric.rubricId,
    ...(vettedUnderWaiver ? { vettedUnderWaiver } : {}),
    ...(specCoverage ? { specCoverage } : {}),
    gradedBy: independent.createdBy ?? null,
    ...(forcedChecks.length > 0 && force ? { forcedPast: { reason: force.reason, checks: forcedChecks } } : {}),
  };
}
