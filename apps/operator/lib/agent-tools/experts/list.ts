/**
 * experts:list — list expert instances for a harness slug.
 *
 * Calls listExperts() in lib/experts-data.ts directly — same function
 * the GET /api/harness/:slug/experts route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listExperts } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:list',
  guidance: {
    when: 'Enumerate registered experts in the harness. Experts are role-scoped reviewer agents that fire on specific events.',
    notWhen: 'For AGENTS (any role), use `agents:list`. Experts are a subset with explicit firing rules.',
    chaining: 'Pair with `experts:get` for full definition.',
  },
  description: 'List expert instances for a harness slug. Returns id, title, status, featureSize, agentCount, roundCount, userEngaged, forkedFrom, createdAt, updatedAt, nextAction.',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1) }),
  async handler(args) {
    const result = await listExperts(args.slug);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: result.data.experts.length, experts: result.data.experts }),
      }],
    };
  },
});
