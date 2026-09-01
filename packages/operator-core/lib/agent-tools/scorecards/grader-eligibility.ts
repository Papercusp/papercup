/**
 * grader-eligibility — the ONE answer to "may agent X emit the independent
 * acceptance grading for rubric R?", shared by the surface that REFUSES
 * (`scorecards:emit`) and the surface that PRE-FLIGHTS (`scorecards:evaluate`).
 *
 * EI-21974075442192005: every rail below is a pure IDENTITY fact — knowable
 * before a single criterion is rated — but all of them were reachable only
 * through the terminal `scorecards:emit` call. A launched independent reviewer
 * therefore completed a full grading pass (re-running both bound suites,
 * verifying every claimed repair, tracing four degraded-value branches, writing
 * evidence strings for seven criteria) and only then learned it could never
 * file the result. `scorecards:evaluate` is ALREADY the documented pre-flight
 * for grading (`evaluate -> fill skeleton -> evaluate -> emit`); it resolved the
 * caller's identity and threw the value away.
 *
 * Both surfaces now derive their verdict HERE. That is the point of the module:
 * a pre-flight that re-implements the refusal it predicts is a pre-flight that
 * silently drifts out of agreement with it, and this file already exists
 * because of one such drift — WI-905074 widened the sole-critic REFUSAL from
 * `critics.length === 1` to "no recorded critic is independent of the grader",
 * and the D-031 advisory that warns about that refusal was left on the old
 * narrow test. Keep every predicate in this module and give each surface a
 * projection of it; do not copy one out.
 */
import { readRubricPlanRevision, META_ACCEPTANCE_RUBRIC_ID } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import {
  areAcceptanceLineageRelated,
  isAcceptanceAuthorIdentity,
} from '../../acceptance-author-identity';

/** Refusal codes emitted by the acceptance-grader rails, verbatim from `scorecards:emit`. */
export type GraderEligibilityCode =
  | 'grader_in_implementer_lineage'
  | 'grader_is_sole_vetting_critic_revision_unreadable'
  | 'grader_is_sole_vetting_critic';

export interface GraderEligibilityRefusal {
  code: GraderEligibilityCode;
  error: string;
}

export interface GraderEligibility {
  /** The rubric's implementer (its acceptance author), or null when unresolvable. */
  implementer: string | null;
  /** True when the caller IS the implementer — they record acceptance, not ratings. */
  callerIsImplementer: boolean;
  /**
   * The refusal this caller would receive from `scorecards:emit`, or null when
   * the identity rails permit them to grade. `null` is NOT a promise that the
   * emit will succeed: the ratings/evidence/instrument rails run separately and
   * are what `scorecards:evaluate` already validated.
   */
  refusal: GraderEligibilityRefusal | null;
}

export interface GraderEligibilityDeps {
  sameAcceptanceAuthor?: typeof isAcceptanceAuthorIdentity;
  lineageRelated?: typeof areAcceptanceLineageRelated;
}

/** The identity fields the rails read — a structural subset of `Rubric`. */
export interface GraderEligibilityRubric {
  rubricId: string;
  proposedBy?: string | null;
  createdBy?: string | null;
}

/**
 * Collapse a recorded vetting-critic list to the SINGLE party it represents, or
 * null when it names two or more genuinely independent parties.
 *
 * This is the predicate behind the sole-vetting-critic refusal, stated without
 * reference to a grader — which is what the vetting-attestation advisory needs,
 * since at attestation time no grader exists yet. `critics.length === 1` is the
 * degenerate case (a lone critic trivially collapses to itself); a list whose
 * members all resolve to one lineage is the same situation wearing a longer
 * list, and is exactly what WI-905074 found sailing through the old test.
 */
export async function collapseCriticsToSoleParty(
  critics: readonly string[],
  options: { workspaceId: string; lineageRelated?: typeof areAcceptanceLineageRelated },
): Promise<string | null> {
  if (critics.length === 0) return null;
  const [first, ...rest] = critics;
  if (rest.length === 0) return first;
  const lineageRelated = options.lineageRelated ?? areAcceptanceLineageRelated;
  const related = await Promise.all(
    rest.map((critic) => lineageRelated(critic, first, { workspaceId: options.workspaceId })),
  );
  return related.every(Boolean) ? first : null;
}

/**
 * Resolve whether `callerId` may emit the independent grading for an acceptance
 * rubric. Call ONLY for `kind: 'acceptance'` rubrics; other kinds have no
 * implementer/grader split and no rails to answer for.
 *
 * The rails are evaluated in the same order `scorecards:emit` returns them, so
 * a pre-flight reports the FIRST refusal a caller would actually receive rather
 * than an arbitrary one.
 */
export async function resolveAcceptanceGraderEligibility(params: {
  rubric: GraderEligibilityRubric;
  callerId: string;
  workspaceId: string;
  deps?: GraderEligibilityDeps;
}): Promise<GraderEligibility> {
  const { rubric, callerId, workspaceId } = params;
  const deps = params.deps ?? {};
  const sameAcceptanceAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
  const lineageRelated = deps.lineageRelated ?? areAcceptanceLineageRelated;

  const implementer = rubric.proposedBy ?? rubric.createdBy ?? null;
  const callerIsImplementer =
    implementer != null && (await sameAcceptanceAuthor(implementer, callerId, { workspaceId }));

  // The implementer's own rails (they must supply acceptance, must not supersede,
  // must follow an independent grading) are about the CARD's shape, not about
  // eligibility, and stay with the writer.
  if (callerIsImplementer) return { implementer, callerIsImplementer: true, refusal: null };

  const callerInImplementerLineage =
    implementer != null && (await lineageRelated(implementer, callerId, { workspaceId }));
  if (callerInImplementerLineage) {
    return {
      implementer,
      callerIsImplementer: false,
      refusal: {
        code: 'grader_in_implementer_lineage',
        error:
          `grader '${callerId}' is in acceptance-rubric author '${implementer}'s spawn/rebind lineage — ` +
          'a related session cannot supply the independent grading; recruit an existing unrelated live session via ' +
          'coord:presence/coord:dispatch, or use an unassigned grading work-item for scheduler pull — never launch a ' +
          'grader from this lineage',
      },
    };
  }

  // EI-21461866696604065: an acceptance rubric's sole vetting critic cannot also
  // be its independent grader. That collapses the intended three-party chain
  // (author -> critic -> grader) into two parties and makes the result
  // self-sealing: the grader is least able to notice the omissions in their own
  // critique. Read the same canonical meta-scorecards the acceptance gate trusts,
  // restricted to the current rubric revision.
  //
  // EI-21828643965337454: a failed revision read must not be flattened into "no
  // revision". The latter is a valid unversioned rubric; the former would make
  // the current-revision filter vacuously true and let the sole vetting critic
  // grade their own rubric. Refuse before reading scorecards so the failure
  // cannot be mistaken for an unvetted/empty history.
  const revisionRead = await readRubricPlanRevision(rubric.rubricId);
  if (!revisionRead.ok) {
    return {
      implementer,
      callerIsImplementer: false,
      refusal: {
        code: 'grader_is_sole_vetting_critic_revision_unreadable',
        error:
          `acceptance rubric '${rubric.rubricId}' current revision could not be read, so the ` +
          `sole-vetting-critic guard cannot verify that its vetting attestation is current; ` +
          `retry after the rubric plan-row read recovers`,
      },
    };
  }
  const currentRevision = revisionRead.revision;
  const vettingCards = await listScorecards({
    rubricRef: META_ACCEPTANCE_RUBRIC_ID,
    subjectRef: rubric.rubricId,
    limit: 50,
  });
  const currentVetting = vettingCards.find(
    (card) =>
      card.rubricResolved &&
      card.missingKeys.length === 0 &&
      !card.synthesized &&
      (card.vetting?.consultId != null || card.vetting?.workItemId != null) &&
      (currentRevision == null || card.vetting?.rubricRevision === currentRevision),
  );
  const critics = currentVetting?.vetting?.critics ?? [];
  // WI-905074: what preserves the three-party chain is an INDEPENDENT critic,
  // not a second row in the list. The old `critics.length === 1` made the
  // identity comparison unreachable for two or more critics, so a vetting record
  // whose critics all resolved to the grader's own identity/lineage was never
  // compared and sailed through the guard written to trip on it.
  if (critics.length > 0) {
    const criticResolvesToGrader = await Promise.all(
      critics.map((critic) => lineageRelated(critic, callerId, { workspaceId })),
    );
    if (criticResolvesToGrader.every(Boolean)) {
      const standing =
        critics.length === 1
          ? 'is the sole recorded vetting critic'
          : `is the only distinct party among the ${critics.length} recorded vetting critics`;
      return {
        implementer,
        callerIsImplementer: false,
        refusal: {
          code: 'grader_is_sole_vetting_critic',
          error:
            `grader '${callerId}' ${standing} for acceptance rubric ` +
            `'${rubric.rubricId}' — no recorded critic is independent of the grader, so rubric ` +
            `fitness and work compliance would be attested by the same party; use a different ` +
            `independent grader`,
        },
      };
    }
  }

  return { implementer, callerIsImplementer: false, refusal: null };
}
