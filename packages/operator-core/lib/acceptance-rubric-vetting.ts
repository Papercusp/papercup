/**
 * Shared read of the acceptance-rubric vetting prerequisite.
 *
 * The completion gate, rubric reads, grading previews, and grading writes must
 * agree on what "vetted" means.  Keep the policy here, but inject the
 * scorecard reader so this module stays below the scorecards/rubrics dependency
 * cycle (scorecards itself reads rubrics).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  classifyRubricEvidenceCurrentness,
  getRubric as defaultGetRubric,
  getRubricPlanRevision as defaultGetRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
  type Rubric,
} from './rubrics';
import { settledGradingAuditIsCurrent, type ScorecardRow } from './scorecards';

export type AcceptanceRubricVettingState = 'not-required' | 'disabled' | 'unvetted' | 'vetted';

/**
 * Why one candidate meta-rubric card did not count as a settled attestation.
 *
 * These are the checks the card actually failed, in evaluation order.  The
 * refusal used to be decided from the SURVIVOR COUNT alone, so every one of
 * these landed on the single string `missing-attestation` and named no card —
 * making the four causes indistinguishable to the agent being refused.
 */
export type AcceptanceRubricVettingRejection =
  | 'rubric-unresolved'
  | 'incomplete-ratings'
  | 'synthesized'
  | 'grading-audit-unsettled'
  | 'no-critique-channel'
  | 'stale-revision';

/** One considered meta-rubric card, and the verdict the vetting read reached on it. */
export interface AcceptanceRubricVettingCandidate {
  /** The meta-rubric scorecard's engineer_issue id — the drill-back key. */
  issueId: string;
  createdAt: string;
  /** Which check dropped it; null when this card IS a settled, current attestation. */
  rejectedBy: AcceptanceRubricVettingRejection | null;
  /** What that check actually observed on THIS card, in the reader's own terms. */
  detail: string;
  attestedRevision: number | null;
  attestedCriteriaHash: string | null;
}

export interface AcceptanceRubricVettingStatus {
  /** Whether this rubric must carry a current meta-rubric attestation. */
  required: boolean;
  /** Whether the current rubric may proceed to grading/completion. */
  satisfied: boolean;
  state: AcceptanceRubricVettingState;
  /** Why the prerequisite is or is not active; useful to read surfaces and teaching errors. */
  reason:
    | 'non-acceptance-rubric'
    | 'empty-acceptance-rubric'
    | 'meta-rubric'
    | 'gate-disabled'
    | 'meta-rubric-missing'
    /** No meta-rubric card exists for this rubric at all — nobody has attested it. */
    | 'missing-attestation'
    /** Cards exist but every one failed a check before currentness; see `candidates`. */
    | 'rejected-attestation'
    /** A complete, linked, audited attestation exists but not for the current revision. */
    | 'stale-attestation'
    | 'current';
  gateEnabled: boolean;
  metaRubricRef: string;
  currentRevision: number | null;
  currentCriteriaHash?: string | null;
  attestedRevision: number | null;
  attestedCriteriaHash?: string | null;
  attestedRevisions: number[];
  attestationIssueId: string | null;
  consultId: string | null;
  /** WI-41477: the review work-item channel — set when the attestation's critique
   *  was recorded as work-item comments instead of a consult. */
  workItemId: string | null;
  /**
   * Every meta-rubric card considered, newest first, each with the check that
   * dropped it.  This is what makes an `unvetted` verdict actionable: the
   * top-level `reason` is a class, `candidates` is the evidence.
   */
  candidates: AcceptanceRubricVettingCandidate[];
  /**
   * A bounded one-line rendering of the rejected candidates, ready to splice
   * into a teaching error.  Null when no card was rejected.
   */
  diagnosis: string | null;
  vettedUnderWaiver?: { consultId: string; reason?: string };
}

export interface AcceptanceRubricVettingDeps {
  /** Required at call sites so this policy module does not import scorecards at runtime. */
  listScorecards: (filter: {
    rubricRef?: string;
    subjectRef?: string;
    limit?: number;
  }) => Promise<ScorecardRow[]>;
  getRubric?: typeof defaultGetRubric;
  getRubricPlanRevision?: typeof defaultGetRubricPlanRevision;
  vettingGateEnabled?: boolean;
  readVettingGateEnabled?: () => Promise<boolean>;
}

function notRequired(
  reason: AcceptanceRubricVettingStatus['reason'],
  gateEnabled: boolean,
): AcceptanceRubricVettingStatus {
  return {
    required: false,
    satisfied: true,
    state: reason === 'gate-disabled' ? 'disabled' : 'not-required',
    reason,
    gateEnabled,
    metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
    currentRevision: null,
    attestedRevision: null,
    attestedRevisions: [],
    attestationIssueId: null,
    consultId: null,
    workItemId: null,
    candidates: [],
    diagnosis: null,
  };
}

/** Render a revision/criteria-hash pair the way a reader can compare two of them. */
function describeIdentity(revision: number | null | undefined, criteriaHash: string | null | undefined): string {
  const rev = revision == null ? 'revision (unrecorded)' : `revision ${revision}`;
  return criteriaHash ? `${rev} / criteria ${criteriaHash.slice(0, 12)}` : rev;
}

/**
 * Decide, for ONE meta-rubric card, whether it is a settled current attestation —
 * and when it is not, which check rejected it and what that check saw.
 *
 * The check order here IS the policy order the vetting read applies, and it
 * matters: `missingKeys` is only meaningful once `rubricResolved` is true, so an
 * unresolved rubric must be reported as such rather than as complete ratings.
 */
function classifyVettingCandidate(
  card: ScorecardRow,
  live: { revision: number | null; criteriaHash?: string | null },
): { rejectedBy: AcceptanceRubricVettingRejection | null; detail: string } {
  if (!card.rubricResolved) {
    return {
      rejectedBy: 'rubric-unresolved',
      detail: `rubricRef '${card.rubricRef}' did not resolve, so this card's completeness cannot be judged`,
    };
  }
  if (card.missingKeys.length > 0) {
    const n = card.missingKeys.length;
    return {
      rejectedBy: 'incomplete-ratings',
      detail: `rates no value for ${n} meta criteri${n === 1 ? 'on' : 'a'}: ${card.missingKeys.join(', ')}`,
    };
  }
  if (card.synthesized) {
    return { rejectedBy: 'synthesized', detail: 'synthesized floor card, never an emitted attestation' };
  }
  if (!settledGradingAuditIsCurrent(card)) {
    const audit = card.gradingAudit;
    const currentness = card.gradingAuditCurrentness;
    const detail =
      audit && audit.state !== 'passed'
        ? `grade-the-grader audit is '${audit.state}' — only an audited pass settles an attestation`
        : `grade-the-grader stamp is ${currentness?.state ?? 'unreadable'}` +
          (currentness?.reason ? ` (${currentness.reason})` : '');
    return { rejectedBy: 'grading-audit-unsettled', detail };
  }
  if (!card.vetting?.consultId && !card.vetting?.workItemId) {
    return {
      rejectedBy: 'no-critique-channel',
      detail: 'no vetting linkage recorded — neither a get_feedback consult nor a review work-item',
    };
  }
  const currentness = classifyRubricEvidenceCurrentness(
    { revision: card.vetting?.rubricRevision, criteriaHash: card.vetting?.criteriaHash },
    { revision: live.revision, criteriaHash: live.criteriaHash },
  );
  if (currentness.state !== 'current') {
    return {
      rejectedBy: 'stale-revision',
      detail:
        `attested ${describeIdentity(card.vetting?.rubricRevision, card.vetting?.criteriaHash)}, ` +
        `rubric is now at ${describeIdentity(live.revision, live.criteriaHash)} (${currentness.reason})`,
    };
  }
  return { rejectedBy: null, detail: 'settled attestation for the current revision' };
}

/** Bounded one-liner naming WHICH card failed WHICH check — safe to splice into an error. */
function summarizeRejections(candidates: AcceptanceRubricVettingCandidate[], show = 5): string | null {
  const rejected = candidates.filter((c) => c.rejectedBy !== null);
  if (rejected.length === 0) return null;
  const shown = rejected
    .slice(0, show)
    .map((c) => `${c.issueId} → ${c.rejectedBy}: ${c.detail}`)
    .join('; ');
  const omitted = rejected.length - Math.min(rejected.length, show);
  return omitted > 0 ? `${shown}; +${omitted} more rejected card(s)` : shown;
}

/**
 * Read the single acceptance-rubric vetting verdict used by all consumers.
 *
 * A missing meta-rubric intentionally disables this prerequisite: that is the
 * existing fail-open compatibility rule which prevents a fresh workspace from
 * deadlocking every acceptance plan before the meta-rubric is installed.  Once
 * the meta-rubric exists, a missing or stale current-revision attestation is a
 * hard unsatisfied result.  An unreadable current revision preserves the
 * historical open behavior: any complete linked attestation is usable because
 * there is no trustworthy revision to compare against.
 */
export async function getAcceptanceRubricVettingStatus(
  rubric: Rubric,
  deps: AcceptanceRubricVettingDeps,
): Promise<AcceptanceRubricVettingStatus> {
  const gateEnabled =
    deps.vettingGateEnabled ??
    (deps.readVettingGateEnabled
      ? await deps.readVettingGateEnabled()
      : await getFlag(FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE, 'system').catch(() => true));

  if (rubric.kind !== 'acceptance') return notRequired('non-acceptance-rubric', gateEnabled);
  if (rubric.rubricId === META_ACCEPTANCE_RUBRIC_ID) return notRequired('meta-rubric', gateEnabled);
  if (rubric.criteria.length === 0) return notRequired('empty-acceptance-rubric', gateEnabled);
  if (!gateEnabled) return notRequired('gate-disabled', gateEnabled);

  const getRubric = deps.getRubric ?? defaultGetRubric;
  const getRubricPlanRevision = deps.getRubricPlanRevision ?? defaultGetRubricPlanRevision;
  const metaRubric = await getRubric(META_ACCEPTANCE_RUBRIC_ID);
  if (!metaRubric) return notRequired('meta-rubric-missing', gateEnabled);

  const [currentRevision, metaCards] = await Promise.all([
    getRubricPlanRevision(rubric.rubricId),
    deps.listScorecards({
      rubricRef: META_ACCEPTANCE_RUBRIC_ID,
      subjectRef: rubric.rubricId,
      limit: 50,
    }),
  ]);
  const vettedCards = metaCards
    .filter((card) => card.rubricResolved && card.missingKeys.length === 0 && !card.synthesized)
    // P-013: once a meta-scorecard carries a grade-the-grader stamp, only an
    // independently audited pass is a settled attestation. Keep accepting
    // unstamped cards for pre-P-013 history; a pending or failed stamp must
    // never make an acceptance rubric appear vetted.
    .filter((card) => settledGradingAuditIsCurrent(card))
    // WI-41477: either critique channel counts — a get_feedback consult, or the
    // review work-item a launched independent reviewer's comments land on.
    .filter((card) => Boolean(card.vetting?.consultId || card.vetting?.workItemId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const attestedRevisions = [
    ...new Set(vettedCards.map((card) => card.vetting?.rubricRevision).filter((v): v is number => v != null)),
  ];
  const current = vettedCards.find(
    (card) =>
      classifyRubricEvidenceCurrentness(
        { revision: card.vetting?.rubricRevision, criteriaHash: card.vetting?.criteriaHash },
        { revision: currentRevision, criteriaHash: rubric.criteriaHash },
      ).state === 'current',
  );

  if (!current) {
    return {
      required: true,
      satisfied: false,
      state: 'unvetted',
      reason: vettedCards.length > 0 ? 'stale-attestation' : 'missing-attestation',
      gateEnabled,
      metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
      currentRevision,
      currentCriteriaHash: rubric.criteriaHash ?? null,
      attestedRevision: vettedCards[0]?.vetting?.rubricRevision ?? null,
      attestedCriteriaHash: vettedCards[0]?.vetting?.criteriaHash ?? null,
      attestedRevisions,
      attestationIssueId: vettedCards[0]?.issueId ?? null,
      consultId: vettedCards[0]?.vetting?.consultId ?? null,
      workItemId: vettedCards[0]?.vetting?.workItemId ?? null,
    };
  }

  const vetting = current.vetting!;
  return {
    required: true,
    satisfied: true,
    state: 'vetted',
    reason: 'current',
    gateEnabled,
    metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
    currentRevision,
    currentCriteriaHash: rubric.criteriaHash ?? null,
    attestedRevision: vetting.rubricRevision ?? null,
    attestedCriteriaHash: vetting.criteriaHash ?? null,
    attestedRevisions,
    attestationIssueId: current.issueId,
    consultId: vetting.consultId ?? null,
    workItemId: vetting.workItemId ?? null,
    // The unanswered waiver exists only on the consult channel (WI-41477: a
    // work-item link with no third-party comment is refused at emit, never waived).
    ...(vetting.unanswered && vetting.consultId
      ? {
          vettedUnderWaiver: {
            consultId: vetting.consultId,
            ...(vetting.unansweredReason ? { reason: vetting.unansweredReason } : {}),
          },
        }
      : {}),
  };
}
