/**
 * experts:chat_agents — list chatable agents (static roles + instanced
 * non-terminal experts) for a harness. Drives the sidebar.
 *
 * Calls listChatAgents() in lib/experts-data.ts directly — same function
 * the GET /api/harness/:slug/chat-agents route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listChatAgents } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:chat_agents',
  guidance: {
    when: 'List expert-backed chat agents — the subset of experts that participate in conversational mode (not just batch-fire).',
    notWhen: 'For ALL chat sessions, use `agent_chats:list`. For all experts, use `experts:list`. chat_agents is the intersection.',
  },
  description: 'List chatable agents for a harness (static roles + non-terminal expert instances).',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1) }),
  async handler(args) {
    const result = await listChatAgents(args.slug);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: result.data.agents.length, agents: result.data.agents }),
      }],
    };
  },
});
