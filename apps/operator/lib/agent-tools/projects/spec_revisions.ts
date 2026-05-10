/**
 * projects:spec_revisions — list spec-revision history for a project.
 *
 * Mirrors GET /:slug/projects/:id/spec/revisions. Read-only. Returns
 * up to 100 revision summaries newest-first; pass `revId` to fetch
 * one full revision body via projects:spec_revision instead.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listProjectSpecRevisions } from '@/lib/projects-data';

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
  name: 'projects:spec_revisions',
  description: 'List spec-revision summaries for a project (newest-first; full spec body lives on projects:spec_revision).',
  capability: 'projects:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    projectId: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) throw new Error('projects:spec_revisions — slug required');
    const revisions = await listProjectSpecRevisions(slug, args.projectId, args.limit);
    return {
      content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, projectId: args.projectId, revisions }) }],
    };
  },
});
