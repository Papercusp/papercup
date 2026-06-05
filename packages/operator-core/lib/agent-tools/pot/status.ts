/**
 * pot:status — inspect the Pot's current wake declaration
 * (autoloop-pot-operator-rebuild-2026-06-05 P0). Read-only: the one-shot time
 * wake (routine row), the persisted event subscriptions + their live rule ids,
 * the last fire, and the floor.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listReactionRules } from '../../events/registry';
import {
  getPotTimeWake,
  potWakeFloorSec,
  readPotWakeState,
  resolvePotHomeSlug,
} from '../../pot/wake';

export default defineTool({
  name: 'pot:status',
  profile: 'engineer',
  description:
    "The Pot operator's current wake declaration: the pending time wake (one-shot routine), event subscriptions + live rule ids, last wake, and the floor. Read-only.",
  guidance: {
    when: 'To see when/whether the operator will wake next, or to verify a pot:declare-wake landed.',
    chaining: 'pot:declare-wake to change the declaration; pot:wake to fire now.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    const { sql } = getOrgPg();

    const time = installSlug ? await getPotTimeWake(sql, installSlug) : null;
    const state = await readPotWakeState(workspaceId);
    const ruleIds = listReactionRules()
      .filter((r) => r.id.startsWith(`pot-wake:${workspaceId}#`))
      .map((r) => r.id);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            time: time
              ? {
                  active: time.active,
                  nextFireAt: time.nextFireAt ? new Date(time.nextFireAt).toISOString() : null,
                  lastFiredAt: time.lastFiredAt ? new Date(time.lastFiredAt).toISOString() : null,
                }
              : null,
            subscriptions: state.subscriptions,
            liveRuleIds: ruleIds,
            lastWakeAt: state.lastWakeAt ? new Date(state.lastWakeAt).toISOString() : null,
            declaredAt: state.declaredAt ? new Date(state.declaredAt).toISOString() : null,
            floorSec: potWakeFloorSec(),
          }),
        },
      ],
    };
  },
});
