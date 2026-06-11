/**
 * projects:get — fetch a single project's detail (spec + counts +
 * last spec revision metadata).
 *
 * Mirrors GET /:slug/projects/:id under the Hono harness mount.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getProjectDetail } from '../../projects-data';

export default defineTool({
  name: 'projects:get',
  profile: 'engineer',
  guidance: {
    when: 'User names a specific project and wants its full record (spec, status, metadata).',
    notWhen: 'For SPEC revisions / history, use `projects:spec_revisions`. For the runtime harness state, use `harness:get`.',
    chaining: 'Follow `projects:list` for the slug.',
  },
  description: 'Fetch a single project detail (spec, feature counts, last spec revision summary). Returns null when not found.',
  capability: 'projects:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    id: z.string().min(1),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) {
      throw new Error('projects:get — harness slug required (passed or in spawn ctx)');
    }
    const project = await getProjectDetail(slug, args.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, id: args.id, found: project !== null, project }) }],
    };
  },
});
