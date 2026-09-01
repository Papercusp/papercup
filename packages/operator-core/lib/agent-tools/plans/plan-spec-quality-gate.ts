/** Exact specSetHash gate shared by plans:start and direct plan-item promotion (P-004). */
import {
  listScorecards,
  scorecardEvidenceFingerprint,
  type ScorecardRow,
} from '../../scorecards';
import { listSpecClauses } from './spec-clauses-store';
import { evaluatePlanSpecQuality, SPEC_QUALITY_RUBRIC_REF, type PlanSpecQualityResult } from './spec-quality';
import { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './spec-test-adequacy';

export type PlanSpecQualityGateCode =
  | 'spec_quality_failed'
  | 'spec_quality_scorecard_missing'
  | 'spec_quality_scorecard_grading_audit_pending'
  | 'spec_quality_scorecard_grading_audit_failed'
  | 'spec_quality_unavailable';

export interface PlanSpecQualityGateVerdict {
  satisfied: boolean;
  applicable: boolean;
  mode: 'report-only' | 'enforced';
  planSlug: string;
  specSetHash: string | null;
  classRef?: PlanClassRubricRef;
  scorecardId?: string;
  code?: PlanSpecQualityGateCode;
  message?: string;
  wouldBlock: string[];
  candidates?: Array<{
    classRef: PlanClassRubricRef;
    verdict: PlanSpecQualityResult['verdict'];
    wouldBlock: string[];
    subjectRef: string;
  }>;
}

type GateDeps = {
  listClauses?: typeof listSpecClauses;
  listCards?: typeof listScorecards;
};

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

/**
 * Every scorecard test EXCEPT the P-013 grade-the-grader audit stamp — deliberately
 * split from {@link scorecardMatches} so a card that fails ONLY on a pending/failed
 * audit can still be recognised and reported precisely, instead of collapsing into
 * the same "no scorecard was ever emitted" verdict as a card that never existed
 * (EI-22068670622018218: the two look identical to a caller once merged).
 */
function scorecardStructurallyExact(card: ScorecardRow, evaluation: PlanSpecQualityResult): boolean {
  const expectedFingerprint = scorecardEvidenceFingerprint({
    rubricRef: SPEC_QUALITY_RUBRIC_REF,
    ratings: evaluation.ratings,
    instrumentSnapshots: card.instrumentSnapshots,
  });
  return (
    card.rubricRef === SPEC_QUALITY_RUBRIC_REF &&
    card.subject?.kind === 'plan' &&
    card.subject.ref === evaluation.scorecardDraft.subject.ref &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    card.extraKeys.length === 0 &&
    !card.synthesized &&
    !card.retracted &&
    !card.supersededBy &&
    card.provisional === undefined &&
    card.evidenceFingerprint === expectedFingerprint &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

function scorecardMatches(card: ScorecardRow, evaluation: PlanSpecQualityResult): boolean {
  return (
    scorecardStructurallyExact(card, evaluation) &&
    card.gradingAudit?.state !== 'pending' &&
    card.gradingAudit?.state !== 'failed'
  );
}

/**
 * Legacy/no-clause plans are report-only so rollout cannot freeze the existing
 * queue. A plan becomes enforcement-eligible by adopting any first-class clause;
 * from that point incomplete clauses, uncovered items, and stale scorecards fail
 * closed before promotion.
 */
export async function evaluatePlanSpecQualityGate(
  input: { harnessSlug: string; planSlug: string; planItemIds: readonly string[] },
  deps: GateDeps = {},
): Promise<PlanSpecQualityGateVerdict> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listCards = deps.listCards ?? listScorecards;
  let clauses;
  try {
    clauses = await listClauses({ harnessSlug: input.harnessSlug, planSlug: input.planSlug });
  } catch (error) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      specSetHash: null,
      code: 'spec_quality_unavailable',
      wouldBlock: ['spec-quality-read-unavailable'],
      message:
        `Spec-quality report could not read first-class clauses (${error instanceof Error ? error.message : String(error)}). ` +
        'The plan has not been proven enforcement-eligible, so this legacy-safe rollout reports the gap without freezing promotion.',
    };
  }
  if (clauses.length === 0) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      specSetHash: null,
      wouldBlock: ['no-first-class-spec-clauses'],
      message:
        'Report-only: this plan has not adopted first-class clauses. Once any clause exists, exact spec-quality scorecards become fail-closed for start/promotion.',
    };
  }

  const evaluations = PLAN_CLASS_RUBRIC_REFS.map((classRef) =>
    evaluatePlanSpecQuality({
      planSlug: input.planSlug,
      harnessSlug: input.harnessSlug,
      planItemIds: input.planItemIds,
      clauses,
      classRef,
    }),
  );
  const candidates = evaluations.map((evaluation) => ({
    classRef: evaluation.classRef,
    verdict: evaluation.verdict,
    wouldBlock: [...evaluation.wouldBlock],
    subjectRef: evaluation.scorecardDraft.subject.ref,
  }));
  const best = evaluations
    .slice()
    .sort((a, b) => a.wouldBlock.length - b.wouldBlock.length || a.classRef.localeCompare(b.classRef))[0];
  const passing = evaluations.filter((evaluation) => evaluation.verdict === 'pass');
  if (passing.length === 0) {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: best.specSetHash,
      classRef: best.classRef,
      code: 'spec_quality_failed',
      wouldBlock: [...best.wouldBlock],
      candidates,
      message:
        `Plan '${input.planSlug}' adopted first-class clauses but fails spec quality for every plan class. ` +
        `Closest class ${best.classRef} would block on: ${best.wouldBlock.join(', ')}. ` +
        `Run plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${best.classRef}' } for exact per-criterion reasons, repair the clauses/exemptions, then emit the returned scorecard.`,
    };
  }

  try {
    let pendingAudit: { card: ScorecardRow; evaluation: PlanSpecQualityResult } | undefined;
    let failedAudit: { card: ScorecardRow; evaluation: PlanSpecQualityResult } | undefined;
    for (const evaluation of passing) {
      const cards = await listCards({
        rubricRef: SPEC_QUALITY_RUBRIC_REF,
        subjectRef: evaluation.scorecardDraft.subject.ref,
        limit: 20,
      });
      const matching = cards.find((card) => scorecardMatches(card, evaluation));
      if (matching) {
        return {
          satisfied: true,
          applicable: true,
          mode: 'enforced',
          planSlug: input.planSlug,
          specSetHash: evaluation.specSetHash,
          classRef: evaluation.classRef,
          scorecardId: matching.issueId,
          wouldBlock: [],
          candidates,
        };
      }
      // Not accepted — but distinguish "exact card exists, still audit-pending/failed"
      // from "no exact card was ever emitted" so the refusal can name the real next
      // step instead of pointing back at scorecards:emit, which the caller already ran.
      if (!pendingAudit) {
        const pending = cards.find(
          (card) => scorecardStructurallyExact(card, evaluation) && card.gradingAudit?.state === 'pending',
        );
        if (pending) pendingAudit = { card: pending, evaluation };
      }
      if (!failedAudit) {
        const failed = cards.find(
          (card) => scorecardStructurallyExact(card, evaluation) && card.gradingAudit?.state === 'failed',
        );
        if (failed) failedAudit = { card: failed, evaluation };
      }
    }
    // Prefer reporting the pending case: a card can only be 'failed' after having been
    // 'pending' first, and a fresh re-emit (the failed-audit remedy) always resets to
    // pending, so a caller who has both is already mid-repair — the pending stamp is
    // the one to act on next.
    if (pendingAudit) {
      return {
        satisfied: false,
        applicable: true,
        mode: 'enforced',
        planSlug: input.planSlug,
        specSetHash: pendingAudit.evaluation.specSetHash,
        classRef: pendingAudit.evaluation.classRef,
        scorecardId: pendingAudit.card.issueId,
        code: 'spec_quality_scorecard_grading_audit_pending',
        wouldBlock: ['exact-specSetHash-scorecard-grading-audit-pending'],
        candidates,
        message:
          `Plan '${input.planSlug}' has an exact terminal ${SPEC_QUALITY_RUBRIC_REF} scorecard ` +
          `(${pendingAudit.card.issueId}) for exact specSetHash ${pendingAudit.evaluation.specSetHash}, but it ` +
          "does not yet satisfy this gate: P-013 grade-the-grader stamps every terminal standard-rubric card " +
          "'gradingAudit.state: pending' until a NON-AUTHOR independently audits it, and this gate only accepts " +
          'an audited (or audit-exempt) card. Have a DIFFERENT agent settle it — ' +
          `scorecards:emit { rubricRef:'grading-integrity', terminal:true, subject:{ kind:'scorecard', ` +
          `ref:'${pendingAudit.card.issueId}' }, ratings:{...} } — then retry plans:start. Re-running ` +
          'plans:evaluate-spec-quality / scorecards:emit yourself files a duplicate pending card and does not ' +
          'settle this one (self-audits are refused).',
      };
    }
    if (failedAudit) {
      return {
        satisfied: false,
        applicable: true,
        mode: 'enforced',
        planSlug: input.planSlug,
        specSetHash: failedAudit.evaluation.specSetHash,
        classRef: failedAudit.evaluation.classRef,
        scorecardId: failedAudit.card.issueId,
        code: 'spec_quality_scorecard_grading_audit_failed',
        wouldBlock: ['exact-specSetHash-scorecard-grading-audit-failed'],
        candidates,
        message:
          `Plan '${input.planSlug}' has an exact terminal ${SPEC_QUALITY_RUBRIC_REF} scorecard ` +
          `(${failedAudit.card.issueId}) for exact specSetHash ${failedAudit.evaluation.specSetHash}, but its ` +
          'independent P-013 grading-integrity audit FAILED it, so it cannot satisfy this gate. Re-run ' +
          `plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${failedAudit.evaluation.classRef}' }, ` +
          'repair whatever the audit flagged, then emit a fresh scorecard through scorecards:emit for a new ' +
          'grading-integrity audit.',
      };
    }
  } catch (error) {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: passing[0].specSetHash,
      code: 'spec_quality_unavailable',
      wouldBlock: ['scorecard-read-unavailable'],
      candidates,
      message:
        `Plan '${input.planSlug}' is enforcement-eligible, but the exact spec-quality scorecard read failed ` +
        `(${error instanceof Error ? error.message : String(error)}). Refusing promotion fail-closed; retry after the scorecard store is healthy.`,
    };
  }

  return {
    satisfied: false,
    applicable: true,
    mode: 'enforced',
    planSlug: input.planSlug,
    specSetHash: passing[0].specSetHash,
    code: 'spec_quality_scorecard_missing',
    wouldBlock: ['exact-specSetHash-scorecard-missing'],
    candidates,
    message:
      `Plan '${input.planSlug}' has structurally passing clauses but no current complete terminal ` +
      `${SPEC_QUALITY_RUBRIC_REF} scorecard for exact specSetHash ${passing[0].specSetHash}. ` +
      `Run plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${passing[0].classRef}' }, ` +
      'emit its scorecardDraft through scorecards:emit, then retry. Any clause revision changes the hash and invalidates older cards.',
  };
}
