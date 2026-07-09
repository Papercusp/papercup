/**
 * kettle:pause — the "Pause Overwatch" control (overwatch-role-2026-06-15 B-07).
 *
 * The sibling of pot:pause, for the autonomous system-health supervisor. PAUSE =
 *   1. persist `overwatch_started = false` FIRST (disarms every loop/watchdog seam
 *      — else Pause would be undone by its own safety net, the hive's P-013
 *      ordering lesson),
 *   2. clear any pending overwatch time-wake via the B-04 wake-bridge seam
 *      (fail-soft until B-04 is wired),
 *   3. optionally send the live overwatch session a graceful stop cue (drain).
 *
 * Resume with kettle:start. Pausing does not kill a running overwatch turn; it
 * finishes, and with the started bit false nothing re-arms.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { CUE_AUTHORITY_FIELD, hiveWideCueAuthority } from '../coordination/cue-authority';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../hive/wake';
import { setOverwatchStarted } from '../../overwatch/control-state';
import { clearOverwatchWake } from '../../overwatch/wake-bridge';

export default defineTool({
  name: 'kettle:pause',
  profile: 'engineer',
  description:
    'PAUSE the Kettle (the autonomous system-health supervisor): persist overwatch_started=false (disarms the loop + liveness watchdog), clear its pending wake, and optionally send the live Kettle session a graceful stop cue. Resume with kettle:start.',
  guidance: {
    when: 'The user clicks Pause Kettle / asks to freeze the system-health supervisor (incident, review, cost control), or the Kettle is misbehaving and must be quieted.',
    notWhen:
      'To pause the Mug / pot — pot:pause (distinct loop). To pause one plan — plans:pause. Pausing does not kill a running Kettle turn; it finishes and nothing re-arms.',
    chaining: 'kettle:pause { drain:true } for the harder stop → kettle:start to resume.',
    seeAlso: [
      'kettle:start (resume the Kettle)',
      'pot:pause (pause the Mug / pot — distinct loop)',
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
      .describe('Pot home-harness slug the Kettle supervises (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    drain: z
      .boolean()
      .default(false)
      .describe('Also send the live Kettle session a graceful stop cue (checkpoint, release locks, exit).'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, undefined);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the Kettle state is per-pot.',
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
          AND child_role IN ('overwatch', 'kettle') AND session_owner IS NOT NULL`;
      drained = [...new Set(rows.map((r) => r.session_owner).filter((s): s is string => Boolean(s)))];
      if (drained.length > 0) {
        await sendMessage(identity, {
          to: drained,
          summary: 'Graceful stop cue: the Kettle is being paused',
          body:
            'The Kettle is being PAUSED. Checkpoint your state, release your locks ' +
            '(locks:release { all_mine: true }), and end your turn cleanly. You will not be ' +
            're-woken until the Kettle is started again.',
          // P-003: an intrinsically HIVE-WIDE Queen-sibling control — stamp it so the
          // stop cue reads as a real hive-level pause, not a peer's fleet drain.
          extra: { [CUE_AUTHORITY_FIELD]: hiveWideCueAuthority(installSlug) },
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
