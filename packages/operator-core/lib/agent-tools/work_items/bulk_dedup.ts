/**
 * work_items:bulk_dedup — execute P-006's model-backed, ratcheted bulk pass.
 *
 * This extends the work_items family instead of adding a parallel maintenance
 * surface. Every invocation first writes a fresh pinned census/shard map, then
 * executes only the D-002-selected scope. `confirm:true` is intentionally
 * mandatory because merge verdicts terminalize duplicate work-items.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFireAt } from '../../harness/routines/cron';
import { WORK_ITEM_ADMISSION_BULK_DEDUP } from '../../work-items-admission-bulk-dedup';

export default defineTool({
  name: 'work_items:bulk_dedup',
  profile: 'engineer',
  description:
    'Enqueue the durable staged work-item bulk deduplicator for one harness and return immediately. The one-shot system action creates a fresh pinned census/shard map, applies the promoter duplication-only charter to the D-002-selected full-corpus or machine-emitter-targeted scope, merges only r-finding-merge verdicts, and transactionally refuses any census rise. Requires confirm:true because accepted merge verdicts terminalize duplicate rows.',
  guidance: {
    when: 'A reviewed bulk-dedup plan is ready to execute and its current corpus must converge under the admission census ratchet.',
    notWhen:
      'Quick filing or ordinary pending-item admission — the durable work-item admission promoter handles those automatically.',
    chaining:
      'work_items:bulk_dedup { harness, confirm:true } → the durable one-shot runs independently → inspect workItemAdmission.runs / admin admission history for the stage and final census.',
    seeAlso: [
      'work_items:search (inspect candidate rows before an exceptional manual intervention)',
      'work_items:get (inspect one canonical or merged row)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80).describe('Harness whose active non-observation corpus is deduplicated.'),
    workspace: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Workspace override; defaults to call context/active workspace.'),
    confirm: z.literal(true).describe('Required acknowledgement that r-finding-merge verdicts terminalize duplicates.'),
    runId: z.string().min(1).max(160).optional().describe('Optional stable root run id for operator correlation.'),
    maxStages: z.number().int().min(1).max(50).optional().describe('Full-corpus convergence ceiling; default 12.'),
    pairsPerCall: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum pair verdicts per model call; default 150.'),
    shardConcurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('Maximum shards judged concurrently; default 4.'),
    targetTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .optional()
      .describe('Shard member-token target; default 300k.'),
    ceilingTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .optional()
      .describe('Per-item/shard safety ceiling; default 1M.'),
    chunkCount: z.number().int().min(1).max(256).optional().describe('Pinned edge-scan chunk count; default 16.'),
    fullCorpusPairThreshold: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('D-002 outside-machine pair threshold; default 150.'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ??
      (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : ctx.principal?.workspaceId) ??
      activeWorkspaceId();
    const runId = args.runId ?? `bulk-dedup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const routineName = `${WORK_ITEM_ADMISSION_BULK_DEDUP}-${runId}`.slice(0, 180);
    const routine = await upsertRoutine(
      getOrgPg().sql,
      {
        workspaceId,
        installSlug: args.harness,
        name: routineName,
        triggerKind: 'cron',
        triggerConfig: {},
        targetRole: `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`,
        payloadTemplate: {
          runId,
          maxStages: args.maxStages,
          pairsPerCall: args.pairsPerCall,
          shardConcurrency: args.shardConcurrency,
          targetTokens: args.targetTokens,
          ceilingTokens: args.ceilingTokens,
          chunkCount: args.chunkCount,
          fullCorpusPairThreshold: args.fullCorpusPairThreshold,
        },
        concurrency: 'skip',
        catchup: 'skip-old',
        active: true,
        nextFireAt: new Date(),
      },
      computeNextFireAt,
    );
    return {
      data: {
        ok: true,
        enqueued: true,
        runId,
        routineId: routine.id,
        nextFireAt: routine.nextFireAt?.toISOString() ?? null,
        targetRole: routine.targetRole,
        completionEvidence: {
          query: 'workItemAdmission.runs',
          expectedRunPrefix: runId,
          terminalStates: ['complete', 'failed'],
        },
      },
    };
  },
});
