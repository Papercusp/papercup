/**
 * routines:fire — enqueue one live scheduled routine immediately.
 *
 * This is the recovery/test lever for a routine whose next cron tick is too far away.
 * It reads the routine row from the active workspace, then delegates queue selection,
 * timeout selection, and DBOS deduplication to the same seam used by routinesTick.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { enqueueRoutineFire, type RoutineFireRow } from '../../dbos/routines-workflow';

const argsSchema = z
  .object({
    name: z.string().min(1).max(200).optional().describe('Routine name, e.g. "green-checkpoint" or "git-sync".'),
    id: z.string().min(1).max(200).optional().describe('Exact routine row id, when known.'),
    installSlug: z.string().max(120).optional().describe('Install slug owning the routine (default: operator home).'),
    harness: z.string().max(120).optional().describe('Alias for installSlug.'),
    reason: z.string().max(500).optional().describe('Optional reason recorded in this call audit metadata.'),
  })
  .superRefine((args, ctx) => {
    if (!args.name && !args.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fire requires name or id' });
    }
    if (args.installSlug && args.harness && args.installSlug !== args.harness) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'installSlug and harness must match when both are supplied' });
    }
  });

type RoutineFireDbRow = RoutineFireRow;

export default defineTool({
  name: 'routines:fire',
  profile: 'engineer',
  description:
    'Enqueue one live scheduled routine immediately without changing its cron, active flag, or next_fire_at. Reads the routine from the current workspace, uses the routine target to select the same DBOS queue and timeout as the scheduler, and reports enqueued, deduplicated, or DBOS-unavailable explicitly.',
  guidance: {
    when: 'You need to run a routine once now to verify or recover it without retuning its schedule.',
    notWhen: 'To change cadence or pause/resume a routine, use routines:set. To inspect routine configuration, use routines:list.',
    chaining: 'routines:list → routines:fire { name, installSlug } → inspect DBOS/routine health.',
    seeAlso: ['routines:list', 'routines:set', 'schedule:inventory'],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: argsSchema,
  async handler(args, ctx) {
    const workspaceId = activeWorkspaceId();
    const slug = args.installSlug ?? args.harness ?? operatorHomeHarnessSlug();
    const { sql } = getOrgPg();
    const rows = await sql<RoutineFireDbRow[]>`
      SELECT id,
             workspace_id AS "workspaceId",
             install_slug AS "installSlug",
             name,
             target_role AS "targetRole",
             trigger_config AS "triggerConfig",
             payload_template AS "payloadTemplate",
             reschedule_interval_sec AS "rescheduleIntervalSec",
             target_owner_id AS "targetOwnerId"
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId}
         AND (${args.id ?? null}::text IS NULL OR id = ${args.id ?? null})
         AND (${args.name ?? null}::text IS NULL OR name = ${args.name ?? null})
         AND install_slug = ${slug}
       LIMIT 1
    `;
    const routine = rows[0];
    if (!routine) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_found', id: args.id, name: args.name, installSlug: slug }) }],
      };
    }

    if (args.reason != null) ctx.metadata?.({ fireReason: args.reason });
    const result = await enqueueRoutineFire(routine);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...result, routine: `${routine.installSlug}/${routine.name}` }) }],
    };
  },
});
