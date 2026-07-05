/**
 * pot:get-steering — read the owner's steering controls for the Queen
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * The agent-surface READ twin of `pot:set-steering`: returns the decoded
 * {@link OwnerSteering} (directive, eligible plans, pause state) the Queen reads on
 * every wake. The 👑 Queen tab reads via the `hive.steering` sync resolver; this is
 * the equivalent for an agent / a quick check.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { getOwnerSteering } from '../../owner-steering';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'pot:get-steering',
  profile: 'engineer',
  description:
    'Read the current owner steering for the Hive — the focus `directive`, `eligiblePlans` (plans the Queen may pick up now), and pause state (`pauseNewWork` / `pausedUntil`) the Queen reads on every wake. An un-steered Hive returns the default (no directive, no plan restriction, not paused). The READ twin of pot:set-steering.',
  guidance: {
    when: 'Checking what the Queen is currently steered toward — before changing it, or to confirm a pot:set-steering write landed.',
    notWhen: 'Changing steering — pot:set-steering. Reading the whole hive status — pot:status.',
    seeAlso: [
      'pot:set-steering (change the steering directive)',
      'pot:status (the whole hive status, not just steering)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z
      .string()
      .max(120)
      .optional()
      .describe('Hive home-harness slug (default: ctx harness / PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.hive, ctx.harnessSlug ?? undefined);
    if (!installSlug) {
      return json({
        ok: false,
        error: 'no_home_harness',
        message: 'Pass `hive` (or set PAPERCUSP_HIVE_HOME_SLUG) — steering is per-hive.',
      });
    }
    return json({ ok: true, hive: installSlug, steering: await getOwnerSteering(workspaceId, installSlug) });
  },
});
