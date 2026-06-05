/**
 * fleet:supervise — report a crashed spawn to the supervisor (P1, D-002).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The control supervisor (the
 * curator-operator) calls this when a supervised child crashes. The engine decides:
 * restart per the spawn's strategy (one_for_one | one_for_all | rest_for_one) if within
 * the restart-intensity budget, or — if crash-looping — tear the subtree down (freeing
 * its locks/claims) and escalate to a human.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { superviseCrash } from '../../fleet/supervision';

export default defineTool({
  name: 'fleet:supervise',
  profile: 'engineer',
  description:
    'Report a crashed spawn. The supervisor restarts the strategy\'s set (one_for_one/one_for_all/rest_for_one) within the restart-intensity budget, or tears the subtree down + escalates to a human when it is crash-looping.',
  guidance: {
    when: 'A supervised child exited abnormally and you (the control supervisor / curator) must decide restart-vs-escalate. Returns the restart set, or the escalation id when the crash-loop bound is breached.',
    notWhen: 'For a clean human abort — that is fleet:cancel, not a crash.',
    chaining: 'detect crash → fleet:supervise { spawn_id } → (restart the returned set) | (handle the escalation).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    spawn_id: z.string().min(1),
    reason: z.string().max(500).optional().describe('What the crash was (exit code, error).'),
    max_restarts: z.number().int().min(1).max(50).optional(),
    window_sec: z.number().int().min(1).max(86_400).optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const res = await superviseCrash(sql, {
      workspaceId,
      spawnId: args.spawn_id,
      actor,
      reason: args.reason,
      maxRestarts: args.max_restarts,
      windowSec: args.window_sec,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            spawn_id: res.spawnId,
            action: res.action,
            strategy: res.strategy,
            restart_count: res.intensity?.count ?? null,
            to_restart: res.toRestart,
            escalation_id: res.escalationId ?? null,
            reason: res.reason,
          }),
        },
      ],
    };
  },
});
