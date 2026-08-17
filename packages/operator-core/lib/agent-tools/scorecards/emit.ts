/** scorecards:emit — the typed write facade over the canonical observation ledger. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getOrgPg } from '@papercusp/db-org';
import { getRubric, getRubricPlanRevision } from '../../rubrics';
import { getIssue } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { activeWorkspaceId } from '../../workspace-registry';
import { consultStateExists } from '../../consult/get-feedback-core';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  ObservationEvidenceError,
  type ObservationRatings,
  type ScorecardVetting,
  asStructuredObservation,
} from '../../harness/improvements/observation-types';
import { readRunningGeneration } from '../../scout/generation-watermark';
import {
  listScorecards,
  evaluateScorecardInstrumentContract,
  scorecardEvidenceFingerprint,
  type ScorecardInstrumentSnapshot,
} from '../../scorecards';
import { scorecardInstrumentSnapshotSchema, scorecardRatingEntrySchema } from './evaluate';
import { acceptanceGraderLabelPrefix } from '../../acceptance-grader';
import { killTask } from '../../task-manager/control';
import { listTasks } from '../../task-manager/store';
import { evaluateCriterionTestChecks } from '../../rubrics-criterion-checks';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { clampForegroundTimeoutMs } from '../capability/foreground-transport-cap';

export const scorecardEmitArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z.string().min(1).max(120).optional(),
    targetHive: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(8000).optional(),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    subject: z
      .object({
        kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric']).optional(),
        ref: z.string().min(1).max(200),
        windowStart: z.string().min(1).max(64).optional(),
        windowEnd: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional()
      .describe(
        "WHAT this scorecard grades (stored as observation.subject) — e.g. { kind:'rubric', ref:'<rubricId>' } on a vetting card.",
      ),
    vettingConsult: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Vetting linkage (consult-min-max-and-rubric-vetting-2026-08-17 P-004): conversation_id of the get_feedback consult that critiqued the vetted rubric (subject.ref names it). Both are validated to exist, then stamped as observation.vetting.',
      ),
    supersedes: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Issue id of the earlier scorecard this corrected filing replaces.'),
    terminal: z
      .boolean()
      .optional()
      .describe(
        "Affirm the graded SUBJECT has terminated (P-008). Without it, rating any 'violatable'-class criterion stamps the card PROVISIONAL — a working note excluded from rubrics:trend until a terminal re-emit (terminal:true, supersedes the interim) makes the grading final.",
      ),
    force: z
      .boolean()
      .optional()
      .describe('File even when the canonical evidence fingerprint matches the latest scorecard.'),
  })
  .strict();

export async function cleanupAcceptanceGraderTasks(
  rubricRef: string,
  input: { workspaceId?: string } = {},
  deps: {
    list?: typeof listTasks;
    kill?: typeof killTask;
  } = {},
) {
  const prefix = acceptanceGraderLabelPrefix(rubricRef);
  const tasks = await (deps.list ?? listTasks)({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 2_000,
  });
  const matched = tasks.filter(
    (task) => task.detail.headless === true &&
      typeof task.detail.label === 'string' &&
      task.detail.label.startsWith(prefix),
  );
  const results = await Promise.all(
    matched.map(async (task) => ({
      taskId: task.taskId,
      outcome: await (deps.kill ?? killTask)(task.taskId, { includeSubtree: true }),
    })),
  );
  return { prefix, matched: matched.length, results };
}

export async function emitScorecard(
  args: z.infer<typeof scorecardEmitArgs>,
  input: {
    createdBy: string;
    ctxHarness?: string;
    role?: string;
    workspaceId?: string;
    /** P-011 (D-006): the tree tests-check files resolve + run against — the handler
     *  passes its ctx-resolved root; omitted ⇒ the resolver's ctx-less fallback. */
    checkRoot?: string;
  },
  deps: {
    /** Injectable seam for tests — production runs the real router via the testing:run core. */
    evaluateChecks?: typeof evaluateCriterionTestChecks;
  } = {},
) {
  const rubric = await getRubric(args.rubricRef);
  if (!rubric) return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  try {
    const ratings = normalizeScorecardRatings(args.ratings as ObservationRatings, rubric);
    const observationForValidation = { rubricRef: args.rubricRef, ratings };
    validateObservationRatings(observationForValidation);
    validateScorecardCompleteness(observationForValidation, rubric.criteria.map((criterion) => criterion.key));
    validateScorecardRatingValues(observationForValidation, rubric);
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
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        instrumentContract,
      };
    }
    // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
    // A vetting scorecard (meta-rubric grading of an acceptance rubric) links the
    // get_feedback consult that critiqued the rubric and pins the rubric's plan-row
    // version, so the acceptance gate can tell whether the attestation still covers
    // the CURRENT revision. Both halves are validated to EXIST before anything is
    // stamped — the gate trusts the stamp rather than re-querying, so a dangling
    // link here would be a booby trap (same posture as the acceptance-kind link
    // guards in proposeRubric).
    let vetting: ScorecardVetting | undefined;
    if (args.vettingConsult) {
      const subjectRef = args.subject?.ref;
      if (!subjectRef) {
        return {
          ok: false as const,
          error:
            "vettingConsult requires `subject` naming the vetted rubric — pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }",
        };
      }
      const vettedRubric = await getRubric(subjectRef);
      if (!vettedRubric) {
        return {
          ok: false as const,
          error: `vetting subject '${subjectRef}' does not resolve to a rubric — the vetting stamp would be a dangling link`,
        };
      }
      const consultOk = await consultStateExists(getOrgPg().sql, activeWorkspaceId(), args.vettingConsult);
      if (!consultOk) {
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' not found in consult_state — open the critique consult first ` +
            `(consult:get_feedback about rubric '${subjectRef}') and pass its conversation_id`,
        };
      }
      const rubricRevision = await getRubricPlanRevision(subjectRef);
      vetting = {
        consultId: args.vettingConsult,
        ...(rubricRevision != null ? { rubricRevision } : {}),
      };
    }
    // P-008 (EI-20581177540737568): a 'violatable' criterion is monotonic-downward — one
    // violation falsifies it permanently — so a mid-run rating of one cannot be final.
    // DEFAULT IS PROVISIONAL: the emitter must AFFIRM subject termination (terminal:true)
    // to file a final card. Forgetting the flag yields a card that doesn't count toward
    // the trend, never a false final (WI-39348's exemplary went stale 28 minutes after
    // an honest interim grade; the burden now sits on the safe side by construction).
    const violatableRatedKeys = rubric.criteria
      .filter((c) => c.criterionClass === 'violatable' && ratings[c.key] !== undefined)
      .map((c) => c.key);
    const provisional =
      !args.terminal && violatableRatedKeys.length > 0
        ? { violatableKeys: violatableRatedKeys, stampedAt: new Date().toISOString() }
        : undefined;
    const sourceHive = args.sourceHive ?? input.ctxHarness;
    if (args.supersedes) {
      const superseded = await getIssue(args.supersedes);
      const raw = superseded?.payload && typeof superseded.payload === 'object' && !Array.isArray(superseded.payload)
        ? (superseded.payload as { observation?: unknown }).observation
        : undefined;
      const prior = asStructuredObservation(raw);
      if (!prior?.rubricRef || !prior.ratings) {
        return { ok: false as const, error: `superseded scorecard '${args.supersedes}' not found` };
      }
      if (prior.rubricRef !== args.rubricRef) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' grades '${prior.rubricRef}', not '${args.rubricRef}'`,
        };
      }
      if ((prior.sourceHive ?? undefined) !== (sourceHive ?? undefined)) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' belongs to sourceHive '${prior.sourceHive ?? ''}', not '${sourceHive ?? ''}'`,
        };
      }
    }
    const latest = (
      await listScorecards({ rubricRef: args.rubricRef, sourceHive, limit: 1 })
    )[0];
    const latestFingerprint = latest
      ? latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({ rubricRef: latest.rubricRef, ratings: latest.ratings })
      : null;
    const sameCorrectionAlreadyExists = args.supersedes && latest?.supersedes === args.supersedes;
    // P-008: a terminal re-emit of IDENTICAL ratings is the finalization step, not a
    // duplicate — the fingerprint (rubricRef+ratings+snapshots, unchanged for
    // compatibility with stored rows) cannot see finality, so compare it separately.
    const finalityChanged = latest !== undefined && (latest.provisional !== undefined) !== (provisional !== undefined);
    // P-004: a re-emit that only moves the vetting stamp — a new consult, or the same
    // consult re-attested against a NEW rubric revision after the author improved the
    // rubric — is the re-vetting step, not a duplicate. The fingerprint cannot see it
    // (rubricRef + ratings + snapshots only, unchanged for stored-row compatibility),
    // so compare the stamps separately, like finality above.
    const vettingChanged =
      (latest?.vetting?.consultId ?? null) !== (vetting?.consultId ?? null) ||
      (latest?.vetting?.rubricRevision ?? null) !== (vetting?.rubricRevision ?? null);
    if (
      !args.force &&
      !finalityChanged &&
      !vettingChanged &&
      latestFingerprint === evidenceFingerprint &&
      (!args.supersedes || sameCorrectionAlreadyExists)
    ) {
      const acceptanceGraderCleanup = rubric.kind === 'acceptance' && input.role === 'judge'
        ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
        : undefined;
      return {
        ok: true as const,
        created: false,
        reason: 'unchanged-evidence' as const,
        evidenceFingerprint,
        previousIssueId: latest?.issueId ?? null,
        canonicalRatings: ratings,
        ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
      };
    }

    // ── P-011 (owner-ratified D-006): deterministic criterion checks ──
    // Every RATED criterion whose rubric check is kind:'tests' has its files actually
    // RUN here, at grading time (never a stale ledger read): a path that no longer
    // resolves refuses the emit, an unjudgeable run refuses the emit, and a
    // pass-claiming rating the run contradicts refuses the emit. Placed AFTER the
    // unchanged-evidence decline above so a deduped re-emit never burns a test run,
    // and BEFORE the write so a card is only ever filed with its live check verdicts
    // stamped (observation.checkRuns). Criteria without a tests-check are untouched.
    let checkRuns: Record<string, import('../../rubrics-criterion-checks').CriterionCheckRun> | undefined;
    const testCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'tests');
    if (testCheckedCriteria.length > 0) {
      const evaluateChecks = deps.evaluateChecks ?? evaluateCriterionTestChecks;
      const checkEvaluation = await evaluateChecks({
        criteria: rubric.criteria,
        ratings,
        ...(input.checkRoot ? { root: input.checkRoot } : {}),
        // Same foreground ceiling as testing:run, shared across ALL checks — the emit
        // call rides the same ~55s MCP transport, so an over-budget suite must surface
        // as an actionable refusal, not an opaque CONNECTION_CLOSED.
        timeoutMs: clampForegroundTimeoutMs(300_000),
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      checkRuns = Object.keys(checkEvaluation.checkRuns).length > 0 ? checkEvaluation.checkRuns : undefined;
    }

    const gradedGeneration = await readRunningGeneration().catch(() => null);
    const result = await captureImprovement({
      title: args.title ?? `Scorecard: ${rubric.title}${sourceHive ? ` — ${sourceHive}` : ''}`,
      kind: 'change',
      body: args.body,
      lane: 'observation',
      // D-002 (observation-lane-scorecard-classification-2026-08-16): an emitted
      // scorecard is a COMPLETED verdict — file it terminal so it never renders as
      // an untriaged open observation. Reads are state-agnostic (scorecards:list
      // selects on payload.observation.rubricRef only), so history/trends/gates
      // are unaffected.
      initialState: 'done',
      createdBy: input.createdBy,
      filedByRole: 'su',
      payloadExtra: {
        observation: {
          rubricRef: args.rubricRef,
          ratings,
          ...(sourceHive ? { sourceHive } : {}),
          ...(args.targetHive ? { targetHive: args.targetHive } : {}),
          ...(instrumentSnapshots ? { instrumentSnapshots } : {}),
          evidenceFingerprint,
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(gradedGeneration ? { gradedGeneration } : {}),
          ...(provisional ? { provisional } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(vetting ? { vetting } : {}),
          ...(checkRuns ? { checkRuns } : {}),
        },
      },
    });
    if (result.created) {
      // Push-on-write (push-audit 2026-07-26): the Verify stage's scorecard
      // list + rubric trend + release-readiness strip all fold this filing in.
      void import('../../sync-sse')
        .then((m) => {
          m.notifySyncInvalidate('scorecards.list');
          m.notifySyncInvalidate('rubrics.trend');
          m.notifySyncInvalidate('learning.releaseReadiness');
        })
        .catch(() => {});
    }
    const acceptanceGraderCleanup = rubric.kind === 'acceptance' && input.role === 'judge'
      ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
      : undefined;
    return {
      ok: true as const,
      created: result.created,
      issueId: result.issue?.id ?? null,
      evidenceFingerprint,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      canonicalRatings: ratings,
      // P-008: surfaced loudly so the emitter knows this card is a working note — a
      // terminal re-emit (terminal:true, supersedes this issueId) finalizes it.
      ...(provisional ? { provisional } : {}),
      // P-011: the live deterministic check verdicts this card was filed with.
      ...(checkRuns ? { checkRuns } : {}),
      ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) return { ok: false as const, error: error.message };
    throw error;
  }
}

export default defineTool({
  name: 'scorecards:emit',
  profile: 'engineer',
  description:
    'Validate, canonicalize, and file one COMPLETE rubric scorecard through the existing observation ledger. Requires evidence for every declared criterion, stamps the running generation, stores deterministic instrument snapshots, and declines unchanged evidence by fingerprint unless force:true.',
  guidance: {
    when:
      'Filing a GRADE-mode or release-readiness scorecard. Prefer this typed surface over hand-assembling improvements:capture observation payloads.',
    notWhen: 'Building the grading skeleton or previewing a delta — scorecards:evaluate. Free-text observations — improvements:capture.',
    chaining:
      'scorecards:evaluate { rubricRef } → grade every returned criterion → scorecards:emit { rubricRef, ratings, instrumentSnapshots } → scorecards:list / rubrics:trend.',
    seeAlso: ['scorecards:evaluate', 'scorecards:list', 'rubrics:trend'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // P-011 (D-006): grading a rubric with tests-checks shells a real Vitest run and can
  // block for tens of seconds without ever reading `ctx.tx` — holding the ambient
  // workspace transaction across that wait would trip idle_in_transaction_session_timeout
  // (60s), surfacing as a bare `write CONNECTION_CLOSED`. Same declaration as
  // testing:run, for the same reason; every DB access here manages its own connection.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEmitArgs,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ctxHarness =
      typeof ctx.harnessSlug === 'string' && ctx.harnessSlug && ctx.harnessSlug !== '*'
        ? ctx.harnessSlug
        : undefined;
    return {
      data: await emitScorecard(args, {
        createdBy: identity.ownerId,
        ctxHarness,
        role: ctx.role,
        workspaceId: identity.workspaceId ?? undefined,
        // P-011: tests-checks resolve + run against the tree the AGENT edits.
        checkRoot: resolveAgentWorkspaceRoot(ctx),
      }),
    };
  },
});
