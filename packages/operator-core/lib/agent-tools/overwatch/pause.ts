/**
 * overwatch:pause — the "Pause Overwatch" control (overwatch-role-2026-06-15 B-07).
 *
 * The sibling of hive:pause, for the autonomous system-health supervisor. PAUSE =
 *   1. persist `overwatch_started = false` FIRST (disarms every loop/watchdog seam
 *      — else Pause would be undone by its own safety net, the hive's P-013
 *      ordering lesson),
 *   2. clear any pending overwatch time-wake via the B-04 wake-bridge seam
 *      (fail-soft until B-04 is wired),
 *   3. optionally send the live overwatch session a graceful stop cue (drain).
 *
 * Resume with overwatch:start. Pausing does not kill a running overwatch turn; it
 * finishes, and with the started bit false nothing re-arms.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { setOverwatchStarted } from '../../overwatch/control-state';
import { clearOverwatchWake } from '../../overwatch/wake-bridge';

export default defineTool({
  name: 'overwatch:pause',
  profile: 'engineer',
  description:
    'PAUSE the overwatch (the autonomous system-health supervisor): persist overwatch_started=false (disarms the loop + liveness watchdog), clear its pending wake, and optionally send the live overwatch session a graceful stop cue. Resume with overwatch:start.',
  guidance: {
    when: 'The user clicks Pause Overwatch / asks to freeze the system-health supervisor (incident, review, cost control), or the overwatch is misbehaving and must be quieted.',
    notWhen:
      'To pause the Queen / colony — hive:pause (distinct loop). To pause one plan — plans:pause. Pausing does not kill a running overwatch turn; it finishes and nothing re-arms.',
    chaining: 'overwatch:pause { drain:true } for the harder stop → overwatch:start to resume.',
    seeAlso: [
      'overwatch:start (resume the overwatch)',
      'hive:pause (pause the Queen / colony — distinct loop)',
      'plans:pause (pause one plan)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Hive home-harness slug the overwatch supervises (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    drain: z
      .boolean()
      .default(false)
      .describe('Also send the live overwatch session a graceful stop cue (checkpoint, release locks, exit).'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, undefined);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the overwatch state is per-hive.',
            }),
          },
        ],
      };
    }
    const { sql } = getOrgPg();

    // Order matters: started=false FIRST so no loop/watchdog seam re-arms between
    // the state flip and the wake clear (the hive's P-013 lifecycle coupling).
    await setOverwatchStarted(workspaceId, installSlug, false);
    const wake = await clearOverwatchWake({ harness: installSlug, workspaceId });

    // Live UI reflection (mirrors hive.controlState): the overwatch pane (B-08)
    // reads overwatch.controlState. Invalidating an unwired name is a safe no-op.
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('overwatch.controlState', {}))
      .catch(() => {});

    // Optional harder stop: the graceful drain cue to a live overwatch session.
    let drained: string[] = [];
    if (args.drain) {
      const identity = resolveAgentIdentity(ctx);
      const rows = await sql<Array<{ session_owner: string | null }>>`
        SELECT session_owner FROM harness_shared.spawned_agents
        WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')
          AND child_role = 'overwatch' AND session_owner IS NOT NULL`;
      drained = [...new Set(rows.map((r) => r.session_owner).filter((s): s is string => Boolean(s)))];
      if (drained.length > 0) {
        await sendMessage(identity, {
          to: drained,
          summary: 'Graceful stop cue: the overwatch is being paused',
          body:
            'The overwatch is being PAUSED. Checkpoint your state, release your locks ' +
            '(locks:release { all_mine: true }), and end your turn cleanly. You will not be ' +
            're-woken until the overwatch is started again.',
        });
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            started: false,
            wakeCleared: wake,
            drainedOverwatch: drained,
          }),
        },
      ],
    };
  },
});
