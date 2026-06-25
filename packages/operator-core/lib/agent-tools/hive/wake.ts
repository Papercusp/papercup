/**
 * hive:wake — fire the Hive operator NOW (autoloop-hive-operator-rebuild-2026-06-05
 * P0, D-002). The manual/user override and the event-wake target: event-reaction
 * rules registered by hive:declare-wake fire THIS tool, so the floor debounce
 * lives here — a burst of subscribed events collapses to one wake, and a wake
 * within the floor of the previous one is skipped (`force` overrides).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { fireLaunchBlueprint } from '../../blueprint/launch-blueprint';
import {
  HIVE_BLUEPRINT_ID,
  claimHiveWakeFire,
  effectiveHiveWakeFloorSec,
  resolveHiveHomeSlug,
} from '../../hive/wake';
import { getOrgPg } from '@papercusp/db-org';

async function hasRecentOpenQueenWake(workspaceId: string, installSlug: string, maxAgeMs = 10 * 60_000): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND label LIKE ${'hive · ' + installSlug + '/%'}
           AND ended_at IS NULL
           AND started_at > now() - (${Math.max(1, Math.floor(maxAgeMs))}::text || ' milliseconds')::interval
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'hive:wake',
  profile: 'engineer',
  description:
    'Fire the Hive operator immediately (launches the hive blueprint via the invoke route). Floor-debounced: a wake within the floor window of the previous one is skipped unless force:true. The target of event-wake reaction rules and the manual user override.',
  guidance: {
    when: 'The user asks to wake/kick the operator now, or an event-wake rule fires (it targets this tool automatically).',
    notWhen: 'To schedule a future wake — that is hive:declare-wake.',
    chaining: 'hive:status to see the last/next wake; hive:declare-wake to schedule.',
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    reason: z.string().max(2000).optional().describe('Why this wake fired — becomes the kickoff context.'),
    source: z.enum(['user', 'event', 'manual']).optional().describe("Provenance label (event-wake rules pass 'event')."),
    harness: z.string().max(120).optional().describe('Home harness slug (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
    force: z.boolean().optional().describe('Bypass the wake-floor debounce.'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the hive launch is harness-scoped.',
            }),
          },
        ],
      };
    }

    // Owner cadence-floor (queen-steering-panel P-006): the event-burst debounce
    // honours the owner's raised wake-cadence floor (MAX of system + owner knob).
    const floorSec = await effectiveHiveWakeFloorSec(workspaceId, installSlug);
    if (await hasRecentOpenQueenWake(workspaceId, installSlug)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, fired: false, skipped: 'wake-inflight' }),
          },
        ],
      };
    }

    const admission = await claimHiveWakeFire(workspaceId, { floorSec, force: args.force });
    if (!admission.fired) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, ...admission }),
          },
        ],
      };
    }

    const kickoff = `Wake (${args.source ?? 'manual'}): ${args.reason ?? 'no reason given'}. You are the operator in charge; survey the fleet and figure out what to do.`;
    const target = await fireLaunchBlueprint(HIVE_BLUEPRINT_ID, { installSlug, workspaceId, kickoff });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, fired: true, role: target.role, harness: installSlug }),
        },
      ],
    };
  },
});
