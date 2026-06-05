/**
 * coord:declare-intent — set what this agent is currently working on.
 *
 * Upserts the caller's liveness row in harness_shared.coord_presence
 * and bumps its heartbeat. This is the explicit-declaration path; the
 * OMP hook also writes presence automatically on session_start /
 * turn_start. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * Semantics: this declares the caller's *whole* current work state —
 * omitted `current_plan_slug` / `current_files` reset to empty. Pass
 * them if they should persist.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { writePresence, getPresence } from '../presence';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:declare-intent',
  description:
    'Declare what you are working on right now — a one-line intent, optionally the plan slug and the files in scope. Other agents see this via coord:presence. Declares your whole current state; omitted fields reset.',
  guidance: {
    when: 'Starting a distinct piece of work, so other agents see what you have taken on.',
    notWhen: 'Every turn — the OMP hook heartbeats automatically; call this when your intent changes.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    intent: z
      .string()
      .min(1)
      .describe('One line: what you are working on right now.'),
    current_plan_slug: z
      .string()
      .optional()
      .describe('Plan slug this work belongs to, if any.'),
    current_files: z
      .array(z.string())
      .optional()
      .describe('Repo-relative files currently in scope.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    await writePresence(identity, {
      intent: args.intent,
      currentPlanSlug: args.current_plan_slug ?? null,
      currentFiles: args.current_files ?? [],
    });
    const record = await getPresence(identity.ownerId);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, presence: record }),
        },
      ],
    };
  },
});
