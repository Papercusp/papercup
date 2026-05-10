/**
 * roles:get — fetch one role manifest by id.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getRole } from '@/lib/role-registry';

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
  name: 'roles:get',
  description: 'Fetch one role manifest by id, scoped to a harness slug (or global when slug omitted).',
  capability: 'roles:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    id: z.string().min(1),
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    const role = getRole(args.id, slug);
    return {
      content: [{ type: 'text', text: JSON.stringify({ id: args.id, harnessSlug: slug || null, found: role !== null, role }) }],
    };
  },
});
