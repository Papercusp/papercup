/**
 * work_items:bulk_dedup — execute P-006's model-backed, ratcheted bulk pass.
 *
 * This extends the work_items family instead of adding a parallel maintenance
 * surface. Every invocation first writes a fresh pinned census/shard map, then
 * executes only the D-002-selected scope. `confirm:true` is intentionally
 * mandatory because merge verdicts terminalize duplicate work-items.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { notifySyncInvalidate } from '../../sync-sse';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { runWorkItemAdmissionBulkDedup } from '../../work-items-admission-bulk-dedup';

export default defineTool({
  name: 'work_items:bulk_dedup',
  profile: 'engineer',
  description:
    'Run the staged work-item bulk deduplicator for one harness. It creates a fresh pinned census/shard map, applies the promoter duplication-only charter to the D-002-selected full-corpus or machine-emitter-targeted scope, merges only r-finding-merge verdicts, and transactionally refuses any census rise. Requires confirm:true because accepted merge verdicts terminalize duplicate rows.',
  guidance: {
    when: 'A reviewed bulk-dedup plan is ready to execute and its current corpus must converge under the admission census ratchet.',
    notWhen:
      'Quick filing or ordinary pending-item admission — the durable work-item admission promoter handles those automatically.',
    chaining:
      'work_items:bulk_dedup { harness, confirm:true } → inspect workItemAdmission.runs / admin admission history for the stage and final census.',
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
    if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
      for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
        if (!process.env[key]) process.env[key] = value;
      }
    }
    const { llmCall } = await import('../../llm-testing/llm-client');
    const result = await runWorkItemAdmissionBulkDedup({
      workspaceId,
      harnessSlug: args.harness,
      runId: args.runId,
      maxStages: args.maxStages,
      pairsPerCall: args.pairsPerCall,
      census: {
        targetTokens: args.targetTokens,
        ceilingTokens: args.ceilingTokens,
        chunkCount: args.chunkCount,
        fullCorpusPairThreshold: args.fullCorpusPairThreshold,
      },
      llmCall: (input) => llmCall({ ...input, priority: 'scout' }),
    });
    await notifySyncInvalidate('workItemAdmission.runs');
    return { data: { ok: true, ...result } };
  },
});
