/**
 * pot:get-steering — read the owner's steering controls for the Mug
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * The agent-surface READ twin of `pot:set-steering`: returns the decoded
 * {@link OwnerSteering} (directive, eligible plans, pause state) the Mug reads on
 * every wake. The 👑 Mug tab reads via the `pot.steering` sync resolver; this is
 * the equivalent for an agent / a quick check.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { getOwnerSteering, steeringLooksInconsistent } from '../../owner-steering';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'pot:get-steering',
  profile: 'engineer',
  description:
    'Read the current owner steering for the pot — the focus `directive`, `eligiblePlans` (plans the Mug may pick up now), and pause state (`pauseNewWork` / `pausedUntil`) the Mug reads on every wake. An un-steered pot returns the default (no directive, no plan restriction, not paused). Also returns `inconsistent: true` (EI-8277) when the directive text reads like the pause was lifted but `pauseNewWork` is still true — a drift nothing else catches; reconcile with pot:set-steering if the owner meant to resume. The READ twin of pot:set-steering.',
  guidance: {
    when: 'Checking what the Mug is currently steered toward — before changing it, or to confirm a pot:set-steering write landed.',
    notWhen: 'Changing steering — pot:set-steering. Reading the whole pot status — pot:status.',
    seeAlso: [
      'pot:set-steering (change the steering directive)',
      'pot:status (the whole pot status, not just steering)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home-harness slug (default: ctx harness / PAPERCUSP_POT_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.pot, ctx.harnessSlug ?? undefined);
    if (!installSlug) {
      return json({
        ok: false,
        error: 'no_home_harness',
        message: 'Pass `pot` (or set PAPERCUSP_POT_HOME_SLUG) — steering is per-pot.',
      });
    }
    const steering = await getOwnerSteering(workspaceId, installSlug);
    return json({
      ok: true,
      pot: installSlug,
      steering,
      // EI-8277: flag when the directive text reads like "resumed" but pauseNewWork
      // is still the hard gate ON — advisory only, never auto-clears the pause.
      inconsistent: steeringLooksInconsistent(steering),
    });
  },
});
