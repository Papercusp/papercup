/**
 * pot:pause — the global "Pause Hive" control
 * (start-hive-wake-orchestration-2026-06-09 P-005, D-005/D-006).
 *
 * Pause reuses the wake-mode gate; it does not invent a new freeze (D-005):
 *   1. persist `hive_started = false` (disarms every watchdog seam — else
 *      Pause would be undone by its own safety net, P-013),
 *   2. set the global wake-mode default to `manual` — every autonomous wake in
 *      the system flows through the `wakeRecipients` gate, so the whole hive
 *      freezes cleanly at turn boundaries with staged wakes reviewable via
 *      coord:wake-queue,
 *   3. clear the Queen's pending time wake,
 *   4. optionally send every live bee the graceful drain cue (the harder stop).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { CUE_AUTHORITY_FIELD, hiveWideCueAuthority } from '../coordination/cue-authority';
import { activeWorkspaceId } from '../../workspace-registry';
import { clearHiveTimeWake, resolveHiveHomeSlug } from '../../hive/wake';
import { setHiveStarted, setHivePlacementStarted, anyHivePlacementStarted } from '../../hive/started';
import { setDefaultWakeMode } from '../coordination/wake-mode';

export default defineTool({
  name: 'pot:pause',
  profile: 'engineer',
  description:
    'PAUSE the hive: persist hive_started=false (disarms the liveness watchdog), set the global wake-mode to manual (autonomous wakes are STAGED for review instead of firing — the one freeze seam, D-005), and clear the Queen\'s pending time wake. Optionally drain live bees gracefully. Resume with pot:start.',
  guidance: {
    when: 'The user clicks Pause Hive / asks to freeze autonomous operation, or you need the colony quiet (incident, review, cost control).',
    notWhen:
      'To stop ONE bee — fleet:drain / fleet:cancel. To pause one plan — plans:pause. Pausing does not kill running turns; they finish and their follow-on wakes stage.',
    chaining:
      'pot:pause { drainBees:true } for the harder stop → coord:wake-queue to review staged wakes → pot:start to resume.',
    seeAlso: [
      'pot:start (resume autonomous operation)',
      'coord:wake-queue (review staged wakes while paused)',
      'pot:dissolve (tear down permanently instead of pausing)',
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
      .describe('Hive home-harness slug (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    drainBees: z
      .boolean()
      .default(false)
      .describe('Also send every live bee the graceful drain cue (checkpoint, release locks/claims, exit).'),
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
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the started state is per-hive.',
            }),
          },
        ],
      };
    }
    const { sql } = getOrgPg();

    // Per-hive Stop (per-hive start-stop 2026-06-30): clear THIS hive's placement
    // bit FIRST (P-013 ordering — no watchdog seam re-arms between the wake clear
    // and the state flip). This stops the workspace Queen placing THIS hive's work.
    await setHivePlacementStarted(workspaceId, installSlug, false);
    // Idle the workspace Queen LOOP (sentinel off + wake-mode manual + clear the
    // pending time wake) ONLY when NO hive remains started — otherwise the single
    // workspace Queen keeps running for the other started hives.
    const loopIdle = !(await anyHivePlacementStarted(workspaceId, installSlug));
    if (loopIdle) {
      await setHiveStarted(workspaceId, installSlug, false);
      await setDefaultWakeMode('manual');
      await clearHiveTimeWake(sql, installSlug, { workspaceId });
    }
    // Live UI reflection (P-006): the AdvShell harness-bar control
    // (AdvNowRunning) reads hive.controlState.
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hive.controlState', {}))
      .catch(() => {});

    // Optional harder stop: the graceful drain cue to every live bee (the same
    // message fleet:drain sends per-bee — propose/dispose preserved).
    let drained: string[] = [];
    if (args.drainBees) {
      const identity = resolveAgentIdentity(ctx);
      const rows = await sql<Array<{ session_owner: string | null }>>`
        SELECT session_owner FROM harness_shared.spawned_agents
        WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')
          AND child_role IN ('bee', 'cup') AND session_owner IS NOT NULL`;
      drained = [...new Set(rows.map((r) => r.session_owner).filter((s): s is string => Boolean(s)))];
      if (drained.length > 0) {
        await sendMessage(identity, {
          to: drained,
          summary: 'Graceful drain cue: the hive is being paused',
          body:
            'The hive is being PAUSED. Checkpoint your state (commit pending edits), release your locks ' +
            '(locks:release { all_mine: true }), return claimed work-items to the pool (work_items:release), ' +
            'and end your turn cleanly. You will not be re-woken until the hive is started again.',
          // P-003: an intrinsically HIVE-WIDE Queen control — stamp it so a recipient
          // reads it as a real hive pause, not a fleet-leader draining its members.
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
            wakeMode: loopIdle ? 'manual' : 'auto',
            workspaceLoopIdle: loopIdle,
            timeWakeCleared: loopIdle,
            drainedBees: drained,
          }),
        },
      ],
    };
  },
});
