/**
 * projects:list — list projects relevant to a harness, with feature counts.
 *
 * Mirrors GET /:slug/projects under the Hono harness mount. Cross-
 * harness rows are filtered to those with at least one feature in the
 * given harness slug. Workspace-scoped via withWorkspaceLegacy().
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listProjectsForHarness } from '@/lib/projects-data';

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
  name: 'projects:list',
  description: 'List projects relevant to a harness (filtered to those with at least one feature in the given slug). Includes feature counts.',
  capability: 'projects:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) {
      throw new Error('projects:list — harness slug required (passed or in spawn ctx)');
    }
    const projects = await listProjectsForHarness(slug);
    return { content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, projects }) }] };
  },
});
