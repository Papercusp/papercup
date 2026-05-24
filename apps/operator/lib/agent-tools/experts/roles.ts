/**
 * experts:roles — list registered cross-cutting expert roles for a
 * harness (from prompts/<role>.role.json sidecars).
 *
 * Calls listExpertRoles() in lib/experts-data.ts directly — same
 * function the GET /api/harness/:slug/expert-roles route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listExpertRoles } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:roles',
  profile: 'engineer',
  guidance: {
    when: 'Read the set of roles experts are configured for in the harness.',
    notWhen: 'For ROLES across the workspace, use `roles:list`. experts:roles is the experts subset.',
  },
  description: 'List registered cross-cutting expert roles for a harness.',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1) }),
  async handler(args) {
    const result = await listExpertRoles(args.slug);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: result.data.roles.length, roles: result.data.roles }),
      }],
    };
  },
});
