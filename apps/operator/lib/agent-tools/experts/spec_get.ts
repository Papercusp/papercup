/**
 * experts:spec_get — read just the SPEC.md content (PG-canonical) for
 * an expert instance.
 *
 * Calls getExpertSpec() in lib/experts-data.ts directly — same function
 * the GET /api/harness/:slug/experts/:expertId/spec route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getExpertSpec } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:spec_get',
  description: 'Read SPEC.md content for an expert instance.',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1), expertId: z.string().min(1) }),
  async handler(args) {
    const result = await getExpertSpec(args.slug, args.expertId);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});
