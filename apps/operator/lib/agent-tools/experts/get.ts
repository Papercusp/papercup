/**
 * experts:get — read one expert instance with full spec, spend, and
 * next-action computed for the panel.
 *
 * Calls getExpert() in lib/experts-data.ts directly — same function
 * the GET /api/harness/:slug/experts/:expertId route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getExpert } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:get',
  profile: 'engineer',
  guidance: {
    when: 'User names a specific expert and wants its definition (prompt, firing rules, output schema).',
    notWhen: 'For the list, use `experts:list`. For the SPEC body specifically, use `experts:spec_get`.',
  },
  description: 'Read one expert instance by id with spec content, spentCents, and nextAction.',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1), expertId: z.string().min(1) }),
  async handler(args) {
    const result = await getExpert(args.slug, args.expertId);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
