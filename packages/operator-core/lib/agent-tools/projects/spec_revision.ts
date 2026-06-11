/**
 * projects:spec_revision — fetch one project spec-revision in full
 * (including the spec body). Mirrors GET /:slug/projects/:id/spec/
 * revisions/:revId.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getProjectSpecRevision } from '../../projects-data';

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
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    projectId: z.string().min(1),
    revId: z.number().int().positive(),
  }),
  // Declarative precondition (adopt-event-rules-engines requires:-half): the
  // former in-handler `if (!slug) throw` guard, lifted.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.harnessSlug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: 'projects:spec_revision — slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // Non-empty by the `harness-slug` precondition above.
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
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
