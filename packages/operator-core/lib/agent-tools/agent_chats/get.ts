/**
 * agent_chats:get — read a single chat by id, including transcript and
 * the current feature_lock state if a feature_id is bound.
 *
 * Calls getChat() in lib/agent-chats-data.ts directly — same function
 * the GET /api/harness/:slug/agent-chats/:chatId route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getChat } from '../../agent-chats-data';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'agent_chats:get',
  description: 'Read one chat by id (transcript, totals, feature_lock state).',
  capability: 'agent_chats:read',
  guidance: {
    when: 'User names a specific chat ("the architect conversation about auth") and wants the full transcript or feature_lock state.',
    notWhen: 'For a list of chats in a harness, use `agent_chats:list` first to find the id. Don\'t fetch full transcripts speculatively.',
    chaining: 'Follow `agent_chats:list` to find the id.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    chatId: z.string().min(1),
  }),
  async handler(args) {
    const result = await getChat(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
