/** scorecards:evaluate — typed rubric skeleton + deterministic evidence delta. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getRubric } from '../../rubrics';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  ObservationEvidenceError,
  type ObservationRatings,
} from '../../harness/improvements/observation-types';
import {
  listScorecards,
  evaluateScorecardInstrumentContract,
  scorecardEvidenceFingerprint,
  type ScorecardInstrumentSnapshot,
} from '../../scorecards';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAcceptanceGraderEligibility } from './grader-eligibility';

export const scorecardRatingEntrySchema = z
  .object({
    rating: z.string().min(1),
    evidence: z.string().min(1),
    suggestion: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const scorecardInstrumentSnapshotSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'unknown']),
    measuredAt: z.string().min(1),
    window: z.record(z.string(), z.unknown()).optional(),
    value: z.unknown().optional(),
    evidenceRef: z.string().min(1).max(500).optional(),
  })
  .strict();

export const scorecardEvaluateArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z.string().min(1).max(120).optional(),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema).optional(),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
  })
  .strict();

/**
 * Who the caller is, for the acceptance-grader pre-flight. Optional: omitting it
 * yields `graderEligibility: null` (the pre-existing behaviour) rather than a
 * guess, so a non-agent caller is never told it is disqualified.
 */
export interface ScorecardEvaluateCaller {
  id: string;
  workspaceId?: string | null;
}

export type GraderEligibilityReport =
  | {
      role: 'acceptance-author' | 'independent-grader' | 'disqualified' | 'unknown';
      canEmitGrading: boolean;
      blocksEmit: boolean;
      implementer: string | null;
      advice: string;
      refusal?: { code: string; error: string };
    }
  | null;

/**
 * EI-21974075442192005: this tool is the DOCUMENTED pre-flight before grading
 * (`evaluate -> fill skeleton -> evaluate -> emit`), which makes it the place a
 * would-be grader has to learn it is disqualified. The acceptance-grader rails
 * are pure identity facts, settled before any criterion is rated, yet they used
 * to be reachable only through the terminal `scorecards:emit` — so a launched
 * reviewer could complete an entire independent pass and only then be refused.
 *
 * Derived from the same module `scorecards:emit` refuses with; never a second
 * copy of the predicates. It reports rather than refuses: the skeleton is still
 * useful to a disqualified caller (handing it to the replacement grader), and a
 * read-only pre-flight that hard-failed would be a worse instrument than one
 * that answers.
 */
async function reportGraderEligibility(
  rubric: { rubricId: string; kind?: string | null; workspaceId?: string | null; proposedBy?: string | null; createdBy?: string | null },
  caller: ScorecardEvaluateCaller | undefined,
): Promise<GraderEligibilityReport> {
  if (!caller || rubric.kind !== 'acceptance') return null;
  try {
    const verdict = await resolveAcceptanceGraderEligibility({
      rubric,
      callerId: caller.id,
      workspaceId: rubric.workspaceId || caller.workspaceId || activeWorkspaceId(),
    });
    if (verdict.refusal) {
      return {
        role: 'disqualified',
        canEmitGrading: false,
        blocksEmit: true,
        implementer: verdict.implementer,
        advice:
          `STOP — do not grade: scorecards:emit will refuse this card with '${verdict.refusal.code}' ` +
          `however complete it is. Report this to whoever assigned the review so a different ` +
          `independent grader is named; the ratings skeleton below is still useful to hand them.`,
        refusal: verdict.refusal,
      };
    }
    if (verdict.callerIsImplementer) {
      return {
        role: 'acceptance-author',
        canEmitGrading: false,
        blocksEmit: false,
        implementer: verdict.implementer,
        advice:
          'You authored this acceptance rubric. You record the acceptance verdict ' +
          "(acceptance:{ verdict, reasoning }) AFTER reading a non-implementer's independent grading — " +
          'emitting the grading ratings yourself is refused.',
      };
    }
    return {
      role: 'independent-grader',
      canEmitGrading: true,
      blocksEmit: false,
      implementer: verdict.implementer,
      advice:
        'Eligible to emit the independent grading (omit acceptance — that is the rubric author’s call). ' +
        'Identity rails only; the ratings/evidence rails are what this call validates.',
    };
  } catch (error) {
    // A pre-flight that cannot answer must say so, not imply clearance.
    return {
      role: 'unknown',
      canEmitGrading: false,
      blocksEmit: false,
      implementer: null,
      advice:
        'Grader eligibility could not be resolved (' +
        `${error instanceof Error ? error.message : String(error)}` +
        ') — this is NOT a clearance; scorecards:emit re-checks the identity rails and may still refuse.',
    };
  }
}

export async function evaluateScorecard(
  args: z.infer<typeof scorecardEvaluateArgs>,
  caller?: ScorecardEvaluateCaller,
) {
  const rubric = await getRubric(args.rubricRef);
  if (!rubric) return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  const graderEligibility = await reportGraderEligibility(rubric, caller);

  const skeleton = rubric.criteria.map((criterion) => ({
    key: criterion.key,
    title: criterion.title,
    instrumentKey: criterion.instrumentKey ?? null,
    // P-011 (D-006): the structured check, so a grader KNOWS a criterion is
    // deterministic before rating it — a kind:'tests' check is actually RUN by
    // scorecards:emit, and a pass-claiming rating a failing run contradicts is refused.
    check: criterion.check ?? null,
    allowedRatings: criterion.ratingScale ?? rubric.ratingScale,
    rating: null,
    evidence: null,
    required: true,
  }));
  const latest = (
    await listScorecards({ rubricRef: args.rubricRef, sourceHive: args.sourceHive, limit: 1 })
  )[0];

  if (!args.ratings) {
    return {
      ok: true as const,
      graderEligibility,
      rubric: {
        rubricRef: rubric.rubricId,
        title: rubric.title,
        status: rubric.status,
        releaseGating: rubric.releaseGating ?? false,
        criteriaCount: rubric.criteria.length,
        ratingScale: rubric.ratingScale,
      },
      skeleton,
      latest: latest ?? null,
    };
  }

  try {
    const ratings = normalizeScorecardRatings(args.ratings as ObservationRatings, rubric);
    const observation = { rubricRef: args.rubricRef, ratings };
    validateObservationRatings(observation);
    validateScorecardCompleteness(observation, rubric.criteria.map((criterion) => criterion.key));
    validateScorecardRatingValues(observation, rubric);
    const instrumentSnapshots = args.instrumentSnapshots as
      | Record<string, ScorecardInstrumentSnapshot>
      | undefined;
    const evidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: args.rubricRef,
      ratings,
      instrumentSnapshots,
    });
    const instrumentContract = evaluateScorecardInstrumentContract({
      rubric,
      ratings,
      instrumentSnapshots,
    });
    if (rubric.releaseGating && !instrumentContract.valid) {
      return {
        ok: false as const,
        graderEligibility,
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        skeleton,
        canonicalRatings: ratings,
        evidenceFingerprint,
        instrumentContract,
        latest: latest ?? null,
      };
    }
    const latestFingerprint = latest
      ? latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({
          rubricRef: latest.rubricRef,
          ratings: latest.ratings,
          ...(latest.rerunRecipe ? { rerunRecipe: latest.rerunRecipe } : {}),
        })
      : null;
    const changedCriteria = rubric.criteria
      .map((criterion) => criterion.key)
      .filter((key) => {
        const before = latest?.ratings[key];
        const after = ratings[key];
        return !before || before.rating !== after.rating || before.evidence !== after.evidence;
      });
    return {
      ok: true as const,
      graderEligibility,
      rubric: {
        rubricRef: rubric.rubricId,
        title: rubric.title,
        status: rubric.status,
        releaseGating: rubric.releaseGating ?? false,
        criteriaCount: rubric.criteria.length,
        ratingScale: rubric.ratingScale,
      },
      skeleton,
      canonicalRatings: ratings,
      evidenceFingerprint,
      instrumentContract,
      changed: latestFingerprint !== evidenceFingerprint,
      delta: {
        previousIssueId: latest?.issueId ?? null,
        changedCriteria,
        instrumentSnapshotsChanged:
          Boolean(instrumentSnapshots) && latest?.evidenceFingerprint !== evidenceFingerprint,
      },
      latest: latest ?? null,
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) {
      return {
        ok: false as const,
        graderEligibility,
        error: error.message,
        skeleton,
        latest: latest ?? null,
      };
    }
    throw error;
  }
}

export default defineTool({
  name: 'scorecards:evaluate',
  profile: 'engineer',
  description:
    'Return the exact typed grading skeleton for a rubric. Optionally validate + canonicalize a complete ratings map, attach deterministic instrument snapshots, compute its evidence fingerprint, and show the criterion delta from the latest scorecard. Read-only; use scorecards:emit to file the validated result.',
  guidance: {
    when:
      'Before grading/emitting a rubric scorecard, especially in GRADE mode. This eliminates criterion-key, rating-case, evidence, and nested-schema guessing. For an acceptance rubric it also returns `graderEligibility` — whether YOU may file the grading at all; read it BEFORE doing the grading work, not after.',
    notWhen: 'Reading scorecard history only — scorecards:list. Filing the validated scorecard — scorecards:emit.',
    chaining:
      'scorecards:evaluate { rubricRef } → fill the returned skeleton → scorecards:evaluate { rubricRef, ratings, instrumentSnapshots } → scorecards:emit with the canonical result.',
    seeAlso: ['scorecards:emit', 'scorecards:list', 'rubrics:get'],
  },
  // EI-21228209276284649: this is a correctness payload, not a browseable list.
  // A trimmed MCP session used the framework's generic bounded projection on a
  // 29,746-char, 26-criterion result before the result door saw it. The door's
  // otherwise-lossless spill therefore contained only 12 skeleton rows plus a
  // truncation marker and six canonical ratings while `criteriaCount` still
  // truthfully said 26. Ignore only the AMBIENT session tier so the door receives
  // the complete validation result and can spill it losslessly; an explicit
  // caller `payloadTier:'trimmed'` still wins, and the 30k hard ceiling remains.
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  // The dedicated acceptance judge validates ratings and instrument evidence;
  // keep its admission local to this read-only tool rather than widening
  // COORD_ROLES (which would expose unrelated coordination writes).
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEvaluateArgs,
  async handler(args, ctx) {
    // EI-21974075442192005: this identity used to be resolved and discarded, which
    // is why the pre-flight could not answer the one question that costs a whole
    // grading pass to get wrong. Pass it through.
    const identity = resolveAgentIdentity(ctx);
    return {
      data: await evaluateScorecard(args, {
        id: identity.ownerId,
        workspaceId: identity.workspaceId,
      }),
    };
  },
});
