/**
 * plans:cleanup-* — resolver contract for a Plans-pane cleanup run.
 *
 * The run-store holds authority/outcomes; the scanner supplies current proof;
 * action-dispatch routes every mutation through the canonical hand-edit seam.
 */
import { z } from 'zod';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { defineTool } from '@papercusp/agent-mcp';
import { bulkContent, runBulk } from '@papercusp/agent-mcp/_bulk';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { inProcessCall } from '../_compound-dispatch';
import { clampText, LIMITS, softText } from '../limits';
import {
  getActiveRun,
  getRun,
  failRunIfExecuting,
  recordRunHeartbeat,
  settleRunPhase,
  type BulkRunRow,
} from '../../attention/bulk-run-store';
import { notifyPlanCleanupRunChanged } from '../../attention/bulk-run-sync';
import { scanCleanupRun } from '../../plan-cleanup/deterministic-runner';
import type { CleanupEvidenceRef } from '../../plan-cleanup/scanner';
import {
  executeCleanupFindingAction,
  getRunFindings,
  reportFindingOutcomes,
  seedFindings,
  type CleanupFindingOutcomeReport,
} from '../../plan-cleanup/run-store';
import { dispatchCleanupFindingAction } from '../../plan-cleanup/action-dispatch';

async function cleanupEnabled(): Promise<boolean> {
  return await getFlag(FLAGS.PLAN_CLEANUP, 'system:plan-cleanup-run').catch(() => false);
}

async function resolveRunId(runId?: string): Promise<string | null> {
  if (runId) return runId;
  return (await getActiveRun(undefined, 'plan-cleanup'))?.runId ?? null;
}

function isExecuting(run: BulkRunRow): boolean {
  return run.phase === 'pending' || run.phase === 'running';
}

function toolJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export const cleanupManifest = defineTool({
  name: 'plans:cleanup-manifest',
  description:
    'Read a plan-cleanup run and its run-scoped findings with CURRENT autoApply verdicts. Omit runId for the active cleanup run. stopped:true means authority is revoked: halt without acting or reporting.',
  guidance: {
    when: 'First call as a plan-cleanup resolver, and again before each batch of actions.',
    notWhen: 'Browsing plans generally (plans:list/plans:get) or editing one plan by hand.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional(),
    includeReported: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const featureEnabled = await cleanupEnabled();
    const runId = await resolveRunId(args.runId);
    if (!runId) return toolJson({ ok: false, error: 'no_active_run' });

    const storedRun = await getRun(runId);
    if (!storedRun) return toolJson({ ok: false, error: 'run_not_found', runId });
    if (storedRun.runKind !== 'plan-cleanup') {
      return toolJson({ ok: false, error: 'run_wrong_kind', runId, runKind: storedRun.runKind });
    }
    const executing = isExecuting(storedRun);
    const heartbeat = featureEnabled && executing
      ? await recordRunHeartbeat({
          runId,
          resolverOwner: identity.ownerId,
          workspaceId: storedRun.workspaceId,
        }).catch(() => null)
      : null;
    const ownershipRevoked = featureEnabled && executing && heartbeat === null;
    const run = heartbeat ?? storedRun;

    const scan = await scanCleanupRun(run);
    let rows = await getRunFindings(runId, run.workspaceId);
    let seedRefused: string | null = null;
    if (rows.length === 0 && isExecuting(run)) {
      const seeded = await seedFindings({
        runId,
        findings: scan,
        resolverOwner: identity.ownerId,
        workspaceId: run.workspaceId,
      });
      seedRefused = seeded.refused?.reason ?? null;
      rows = await getRunFindings(runId, run.workspaceId);
    }

    const currentById = new Map(scan.map((finding) => [finding.findingId, finding]));
    const wanted = args.includeReported ? rows : rows.filter((row) => row.outcome === 'pending');
    const findings = wanted.map((row) => {
      const current = currentById.get(row.findingId);
      return {
        ...row,
        autoApply: current?.autoApply === true,
        autoApplyBlockedBy: current ? current.autoApplyBlockedBy : 'stale-finding',
        current: Boolean(current),
      };
    });

    return toolJson({
      ok: true,
      run: {
        runId: run.runId,
        phase: run.phase,
        planSlugs: run.seedRefs,
        totalItems: run.totalItems,
        autoApplied: run.autoResolved,
        recommended: run.recommended,
        skipped: run.skipped,
        failed: run.failed,
        heartbeatAt: run.heartbeatAt,
        resolverOwner: run.resolverOwner,
      },
      findings,
      remaining: rows.filter((row) => row.outcome === 'pending').length,
      featureDisabled: !featureEnabled,
      ownershipRevoked,
      stopped: !featureEnabled || ownershipRevoked || !isExecuting(run),
      ...(seedRefused ? { seedRefused } : {}),
    });
  },
});

export const cleanupAct = defineTool({
  name: 'plans:cleanup-act',
  description:
    'Apply ONE currently-provable cleanup finding. Holds the run authority lock across fresh re-verification, canonical plan/claim dispatch, outcome, and counters. If Stop won first, no mutation starts.',
  guidance: {
    when: 'The cleanup manifest marks one pending finding autoApply:true and you have a concise evidence-based rationale.',
    notWhen: 'The finding is recommended, blocked by a live agent, stale, or only needs reporting.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional(),
    findingId: z.string().min(1),
    rationale: softText(LIMITS.ANNOTATION),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) return toolJson({ ok: false, error: 'no_active_run' });
    if (!(await cleanupEnabled())) {
      return toolJson({
        ok: false,
        refused: 'feature_disabled',
        flag: FLAGS.PLAN_CLEANUP,
        runId,
        actionDispatched: false,
      });
    }

    const rationale = clampText(args.rationale, LIMITS.ANNOTATION)?.trim() ?? '';
    if (!rationale) return toolJson({ ok: false, error: 'rationale_required', runId });
    const run = await getRun(runId);
    if (!run) return toolJson({ ok: false, error: 'run_not_found', runId });
    if (run.runKind !== 'plan-cleanup') {
      return toolJson({ ok: false, error: 'run_wrong_kind', runId, runKind: run.runKind });
    }
    const heartbeat = await recordRunHeartbeat({
      runId,
      resolverOwner: identity.ownerId,
      workspaceId: run.workspaceId,
    }).catch(() => null);
    if (!heartbeat) {
      return toolJson({
        ok: false,
        refused: 'resolver_owner_mismatch_or_not_executing',
        runId,
        actionDispatched: false,
      });
    }

    const call = inProcessCall(ctx);
    let actionDispatched = false;
    try {
      const result = await executeCleanupFindingAction({
        runId,
        findingId: args.findingId,
        resolverOwner: identity.ownerId,
        workspaceId: run.workspaceId,
        async execute(locked) {
          const fresh = (await scanCleanupRun(run, [locked.planSlug])).find(
            (finding) => finding.findingId === locked.findingId,
          );
          if (!fresh) throw new Error(`${locked.findingId}: finding is no longer present at current state`);
          if (!fresh.autoApply) {
            throw new Error(
              `${locked.findingId}: auto-apply is not currently authorized (${fresh.autoApplyBlockedBy ?? fresh.confidence})`,
            );
          }
          const dispatched = await dispatchCleanupFindingAction({ run, finding: fresh, call });
          actionDispatched = true;
          return dispatched;
        },
      });

      if (result.refused) {
        return toolJson({
          ok: false,
          refused: result.refused.reason,
          phase: result.refused.phase,
          runId,
          findingId: args.findingId,
          actionDispatched: false,
          message: 'Stop/settle or snapshot membership refused the action before its callback began.',
        });
      }

      await notifyPlanCleanupRunChanged().catch(() => undefined);
      return toolJson({
        ok: true,
        runId,
        findingId: args.findingId,
        rationale,
        actionDispatched: true,
        outcome: result.finding?.outcome ?? 'auto_applied',
        counters: result.run
          ? {
              autoApplied: result.run.autoResolved,
              recommended: result.run.recommended,
              skipped: result.run.skipped,
              failed: result.run.failed,
            }
          : null,
        dispatch: result.actionResult,
      });
    } catch (error) {
      return toolJson({
        ok: false,
        error: actionDispatched ? 'post_dispatch_persistence_failed' : 'cleanup_action_failed',
        message: error instanceof Error ? error.message : String(error),
        runId,
        findingId: args.findingId,
        actionDispatched,
        reconciliationRequired: actionDispatched,
      });
    }
  },
});

const OutcomeItem = z
  .object({
    findingId: z.string().min(1),
    outcome: z.enum(['recommended', 'skipped', 'failed']),
    rationale: softText(LIMITS.ANNOTATION).optional(),
    error: softText(LIMITS.ANNOTATION).optional(),
  })
  .refine((item) => item.outcome !== 'recommended' || Boolean(item.rationale?.trim()), {
    message: 'rationale is required for recommended findings',
    path: ['rationale'],
  })
  .refine(
    (item) => item.outcome === 'recommended' || Boolean(item.error?.trim()),
    { message: 'error is required for skipped/failed findings', path: ['error'] },
  );

export const cleanupReport = defineTool({
  name: 'plans:cleanup-report',
  description:
    'Record non-action cleanup outcomes: recommended with a rationale, or skipped/failed with an error. This verb cannot claim auto_applied; effects must use plans:cleanup-act.',
  guidance: {
    when: 'Batch the non-action outcomes after reviewing a cleanup manifest.',
    notWhen: 'Applying a finding or ending the run.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      runId: z.string().min(1).optional(),
      findingId: z.string().min(1).optional(),
      outcome: z.enum(['recommended', 'skipped', 'failed']).optional(),
      rationale: softText(LIMITS.ANNOTATION).optional(),
      error: softText(LIMITS.ANNOTATION).optional(),
      items: z.array(OutcomeItem).min(1).max(100).optional(),
    })
    .refine((args) => Boolean(args.items?.length) || (Boolean(args.findingId) && Boolean(args.outcome)), {
      message: 'pass one { findingId, outcome } or items:[...]',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) return toolJson({ ok: false, error: 'no_active_run' });
    if (!(await cleanupEnabled())) {
      return toolJson({
        ok: false,
        refused: 'feature_disabled',
        flag: FLAGS.PLAN_CLEANUP,
        runId,
        wrote: 0,
      });
    }
    const run = await getRun(runId);
    const heartbeat = run
      ? await recordRunHeartbeat({
          runId,
          resolverOwner: identity.ownerId,
          workspaceId: run.workspaceId,
        }).catch(() => null)
      : null;
    if (!heartbeat) {
      return toolJson({
        ok: false,
        refused: 'resolver_owner_mismatch_or_not_executing',
        runId,
        wrote: 0,
      });
    }

    const reports = args.items?.length
      ? args.items
      : [{
          findingId: args.findingId!,
          outcome: args.outcome!,
          rationale: args.rationale,
          error: args.error,
        } as z.infer<typeof OutcomeItem>];
    const rows = await getRunFindings(runId);
    const byId = new Map(rows.map((row) => [row.findingId, row]));
    const accepted: CleanupFindingOutcomeReport[] = [];
    const env = await runBulk(
      reports,
      async (report) => {
        const row = byId.get(report.findingId);
        const rationale = clampText(report.rationale, LIMITS.ANNOTATION)?.trim() ?? '';
        const error = clampText(report.error, LIMITS.ANNOTATION)?.trim() ?? null;
        const evidence: CleanupEvidenceRef[] | undefined = row
          ? [
              ...row.evidence,
              ...(rationale
                ? [{ kind: 'plan' as const, ref: row.planSlug, note: `resolver recommendation: ${rationale}` }]
                : []),
            ]
          : undefined;
        accepted.push({
          findingId: report.findingId,
          outcome: report.outcome,
          error,
          ...(evidence ? { evidence } : {}),
        });
        return { ok: true as const, findingId: report.findingId, outcome: report.outcome };
      },
      { keyOf: ({ findingId }) => ({ findingId }) },
    );

    if (accepted.length === 0) return bulkContent(env);
    const result = await reportFindingOutcomes({
      runId,
      reports: accepted,
      resolverOwner: identity.ownerId,
      workspaceId: heartbeat.workspaceId,
    });
    if (result.refused) {
      return toolJson({
        ok: false,
        refused: result.refused.reason,
        phase: result.refused.phase,
        runId,
        wrote: 0,
      });
    }
    await notifyPlanCleanupRunChanged().catch(() => undefined);
    if (result.missing.length === 0) return bulkContent(env);
    return bulkContent({
      ...(env as unknown as Record<string, unknown>),
      ignored: {
        reason: "not in this run's finding snapshot",
        findingIds: result.missing,
      },
    });
  },
});

// Wind-down is deliberately never feature-gated: OFF must revoke acting, not
// strand an already-launched run in `running`.
export const cleanupSettle = defineTool({
  name: 'plans:cleanup-settle',
  description:
    'End a plan-cleanup pass. The final phase is derived from finding rows; pass failed:true with an error only when abandoning the run part-way.',
  guidance: {
    when: 'Last call after every cleanup finding was acted or reported.',
    notWhen: 'Mid-pass.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    runId: z.string().min(1).optional(),
    failed: z.boolean().optional(),
    error: softText(LIMITS.ANNOTATION).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const runId = await resolveRunId(args.runId);
    if (!runId) return toolJson({ ok: false, error: 'no_active_run' });
    const run = args.failed
      ? await failRunIfExecuting({
          runId,
          resolverOwner: identity.ownerId,
          error: clampText(args.error, LIMITS.ANNOTATION)?.trim() || 'resolver abandoned the run',
        })
      : await settleRunPhase({ runId, resolverOwner: identity.ownerId });
    if (!run) {
      return toolJson({
        ok: false,
        refused: 'resolver_owner_mismatch_or_not_executing',
        runId,
      });
    }
    await notifyPlanCleanupRunChanged().catch(() => undefined);
    return toolJson({
      ok: true,
      runId,
      phase: run.phase,
      autoApplied: run.autoResolved,
      recommended: run.recommended,
      skipped: run.skipped,
      failed: run.failed,
    });
  },
});

export default cleanupManifest;
