/**
 * loop:end — end the engine-managed loop on your own session (or another owner's,
 * with `ownerId`): stop the recurring warm wake (loop-routines-interval-recurrence-
 * 2026-06-20, B-LOOP-5 / P-008). The routine is DEACTIVATED (the row is kept for
 * fire-history + a quick re-arm). Deliberately NOT flag-gated — you must always be
 * able to stop a loop you armed, even if the loop feature flag was later turned off.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { deactivateLoop } from '../../harness/routines/loop';
import { activeWorkspaceId } from '../../workspace-registry';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';

export default defineTool({
  name: 'loop:end',
  profile: 'engineer',
  description:
    "End the owner-scoped loop on your own session (or another owner's, with `ownerId`) — stops the recurring warm wake. The routine is deactivated (history kept); an optional `reason` is recorded in the transition log. This tool intentionally has no `harness` argument; loops are keyed by owner. Re-arm anytime with loop:arm.",
  guidance: {
    when: 'Stop a loop you armed with loop:arm — the goal is done, you are blocked on something external, or the user says stop. Pass `reason` when a durable stop explanation matters. This owner-scoped tool intentionally does not take `harness`. Better to loop:end than burn empty wakes spinning.',
    notWhen:
      'Pause the WHOLE autoloop / routines engine — that is autoloop:control. End the autonomous hive loop — that is pot:pause.',
    chaining: 'loop:arm to start; loop:status to check; loop:end to stop.',
    seeAlso: [
      'loop:arm (start a loop)',
      'loop:status (check it)',
      'autoloop:control (pause the whole autoloop engine)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe('End the loop for this owner id (default: yourself).'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional durable reason for ending the loop; recorded in the loop transition log.'),
    acknowledgeOpenDirectives: z
      .boolean()
      .optional()
      .describe(
        'EI-11484 guard: open owner directives soft-block loop:end (ending removes their wake render surface). Pass true to consciously proceed with them still open.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    // EI-11484 P4: while OPEN owner directives exist, ending the loop silently
    // removes the surface that re-renders them every wake — warn first;
    // acknowledgeOpenDirectives:true proceeds. Fail-open on read errors (you
    // must always be able to stop a loop you armed).
    {
      const { checkOpenDirectivesGuard } = await import('../orders/open-directives-guard');
      const guard = await checkOpenDirectivesGuard({
        workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId,
        acknowledged: args.acknowledgeOpenDirectives,
        action: 'loop:end',
      });
      if (guard) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(guard) }],
          isError: true,
        };
      }
    }
    const ended = await deactivateLoop(ownerId, { reason: args.reason });
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const control = ended
      ? await refreshControlAnchorAfterMutation({
          ownerId,
          workspaceId,
          origin: 'agent',
          actorId: identity.ownerId,
          source: 'loop:end',
        })
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            ended,
            controlGeneration: control?.generation ?? null,
            note: ended
              ? 'Loop ended — no further wakes will fire.'
              : 'No active loop found for this owner (already ended or never armed).',
          }),
        },
      ],
    };
  },
});
