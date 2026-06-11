/**
 * harness:health — single-call health verdict for a harness slug.
 *
 * Calls getHealth() in lib/harness-readers.ts directly — same function
 * the GET /api/harness/:slug/health route projects.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getHealth } from '../../harness-readers';

const ALL_ROLES = [...SU_ROLES, 'sentinel'] as const;

export default defineTool({
  name: 'harness:health',
  profile: 'engineer',
  description:
    'Read consolidated health verdict for a harness (alive, escalated, feature counts, ghost rate, checks).',
  capability: 'harness:read',
  guidance: {
    when: 'User asks "is sheets healthy?", "is the harness running?". Single fast snapshot — alive, escalated flag, feature-status counts.',
    notWhen: 'For LIVE phase + activity (recent audit events), use `harness:status`. For open issues, use `issues:list`.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args) {
    const result = await getHealth(args.slug);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
