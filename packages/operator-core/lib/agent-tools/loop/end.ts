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

export default defineTool({
  name: 'loop:end',
  profile: 'engineer',
  description:
    "End the loop on your own session (or another owner's, with `ownerId`) — stops the recurring warm wake. The routine is deactivated (history kept); re-arm anytime with loop:arm.",
  guidance: {
    when: 'Stop a loop you armed with loop:arm — the goal is done, you are blocked on something external, or the user says stop. Better to loop:end than burn empty wakes spinning.',
    notWhen:
      'Pause the WHOLE autoloop / routines engine — that is autoloop:control. End the autonomous hive loop — that is hive:pause.',
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
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    const ended = await deactivateLoop(ownerId);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            ended,
            note: ended
              ? 'Loop ended — no further wakes will fire.'
              : 'No active loop found for this owner (already ended or never armed).',
          }),
        },
      ],
    };
  },
});
