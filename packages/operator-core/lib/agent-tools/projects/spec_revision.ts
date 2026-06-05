/**
 * projects:spec_revision — fetch one project spec-revision in full
 * (including the spec body). Mirrors GET /:slug/projects/:id/spec/
 * revisions/:revId.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getProjectSpecRevision } from '../../projects-data';

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
  name: 'projects:spec_revision',
  profile: 'engineer',
  guidance: {
    when: 'User names a specific revision id and wants its full body — what the spec looked like at that point.',
    notWhen: 'For the CURRENT spec, use `projects:get`. For the list of revisions, use `projects:spec_revisions`.',
    chaining: 'Follow `projects:spec_revisions` for the id.',
  },
  description: 'Fetch one project spec-revision in full (includes the spec body). Returns null when not found.',
  capability: 'projects:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    projectId: z.string().min(1),
    revId: z.number().int().positive(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) throw new Error('projects:spec_revision — slug required');
    const revision = await getProjectSpecRevision(slug, args.projectId, args.revId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          harnessSlug: slug,
          projectId: args.projectId,
          revId: args.revId,
          found: revision !== null,
          revision,
        }),
      }],
    };
  },
});
