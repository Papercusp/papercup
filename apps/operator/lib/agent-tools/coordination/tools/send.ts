/**
 * coord:send — send a typed message (or coord broadcast) to one or
 * more other agents. agent-coordination-architecture-v2 §6.4 (#6).
 *
 * Persists to the `messages` surface of the CoordEventLog (the operator
 * backs it with Postgres — harness_shared.coord_event_log). Recipients
 * see it via coord:inbox.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { sendMessage } from '../messages';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:send',
  description:
    'Send a message to other coordination agents. `to` is a list of ownerIds; use ["*"] to broadcast, ["human"] to surface to the user. Returns the assigned msg_id.',
  guidance: {
    when: 'Sharing context with another agent — "I just finished X, the next step is Y", or asking a question, or handing off a piece of work.',
    notWhen: 'For an in-conversation reply to the human, just speak. For locking a file, use locks:acquire — coord:send is async/eventual, not a lock.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    to: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1),
    body: z.string().optional(),
    files: z.array(z.string()).optional(),
    plan_slug: z.string().optional(),
    related_msg_id: z.string().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the sender's harness when it's a real, harness-scoped agent
    // (pipeline roles carry ctx.harnessSlug). '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level (broadcast); leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    const env = await sendMessage(identity, {
      to: args.to,
      summary: args.summary,
      body: args.body,
      files: args.files,
      plan_slug: args.plan_slug,
      related_msg_id: args.related_msg_id,
      ...(harnessSlug ? { harnessSlug } : {}),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, msg_id: env.msg_id, ts: env.ts }),
        },
      ],
    };
  },
});
