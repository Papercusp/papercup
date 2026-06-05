/**
 * conversations:join — follow ONE conversation (the "I can contribute to THIS
 * thread" motivation, substrate D-005a). Its replies/answers/resolution get
 * injected into your inbox, honoring the delivery mode you pick. This is the
 * per-object subscribe; topics:subscribe is the standing-interest one.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { joinConversation, leaveConversation } from '../conversations';

export default defineTool({
  name: 'conversations:join',
  description:
    'Follow a single conversation so its updates are injected into your inbox. mode = full | digest | mention (D-006). Idempotent — re-joining updates the mode/TTL. Pass leave:true to stop following.',
  guidance: {
    when:
      'A specific conversation is one you want to track or contribute to. Posting/answering auto-joins you; call this to follow without posting, or to change your delivery mode.',
    notWhen:
      'To follow an AREA (not one thread), use topics:subscribe. For a one-time read, just conversations:get.',
    chaining:
      'conversations:list / conversations:get → conversations:join.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1),
    mode: z.enum(['full', 'digest', 'mention']).optional(),
    ttl_sec: z.number().int().positive().optional(),
    leave: z.boolean().optional().describe('Stop following this conversation.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.leave) {
      await leaveConversation(identity, args.conversation_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, left: args.conversation_id }) }] };
    }
    const res = await joinConversation(identity, { conversation_id: args.conversation_id, mode: args.mode, ttl_sec: args.ttl_sec });
    if ('error' in res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: res.error }) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, conversation_id: args.conversation_id, mode: res.mode }) }] };
  },
});
