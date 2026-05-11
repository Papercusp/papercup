/**
 * agent_chats:archive — archive (soft-delete) a chat session. Sets
 * archived_at; the chat stops appearing in default list results.
 *
 * Calls archiveChat() in lib/agent-chats-data.ts directly — same function
 * the DELETE /api/harness/:slug/agent-chats/:chatId route projects.
 * Includes the "expert chat archive resumes the expert" side-effect.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { archiveChat } from '@/lib/agent-chats-data';

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
  name: 'agent_chats:archive',
  description: 'Archive (soft-delete) a chat session by id. Resumes the expert lifecycle if applicable.',
  capability: 'agent_chats:write',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 5 }, operator: { perRun: 50 } },
  args: z.object({
    slug: z.string().min(1),
    chatId: z.string().min(1),
  }),
  async handler(args) {
    const result = await archiveChat(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
