/**
 * agent_chats:create — open a new chat session in a harness for a given
 * role (optionally bound to a feature_id). Streaming message exchange
 * stays on the dedicated SSE route.
 *
 * Calls createChat() in lib/agent-chats-data.ts directly — same function
 * the POST /api/harness/:slug/agent-chats route projects. Including the
 * "expert chat opens flips the expert into awaiting_user" side-effect.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { createChat } from '@/lib/agent-chats-data';

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
  name: 'agent_chats:create',
  description:
    'Open a new chat session for a role in a harness; optionally bind it to a feature_id.',
  capability: 'agent_chats:write',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 5 }, operator: { perRun: 50 } },
  args: z.object({
    slug: z.string().min(1),
    role: z.string().min(1),
    feature_id: z.string().optional(),
    title: z.string().optional(),
  }),
  async handler(args) {
    const result = await createChat(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
