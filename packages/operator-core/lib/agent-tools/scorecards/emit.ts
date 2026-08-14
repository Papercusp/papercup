/** scorecards:emit — the typed write facade over the canonical observation ledger. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getRubric } from '../../rubrics';
import { getIssue } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  ObservationEvidenceError,
  type ObservationRatings,
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

export const scorecardEmitArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z.string().min(1).max(120).optional(),
    targetHive: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(8000).optional(),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    supersedes: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Issue id of the earlier scorecard this corrected filing replaces.'),
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
  input: { createdBy: string; ctxHarness?: string; role?: string; workspaceId?: string },
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
    if (!args.force && latestFingerprint === evidenceFingerprint && (!args.supersedes || sameCorrectionAlreadyExists)) {
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

    const gradedGeneration = await readRunningGeneration().catch(() => null);
    const result = await captureImprovement({
      title: args.title ?? `Scorecard: ${rubric.title}${sourceHive ? ` — ${sourceHive}` : ''}`,
      kind: 'change',
      body: args.body,
      lane: 'observation',
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
      }),
    };
  },
});
