/**
 * wiki:backlinks — find markdown references to a [[target]] across
 * the workspace. Same scanner as GET /api/wiki-backlinks.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { findWikiBacklinks } from '../../wiki-backlinks';

export default defineTool({
  name: 'wiki:backlinks',
  profile: 'engineer',
  guidance: {
    when: 'User asks "what links to X?", "where is `[[name]]` referenced?". Wiki-style backlink lookup across markdown files.',
    notWhen: 'For cross-resource full-text search, use `search:query`. For markdown TOC, use `harness:markdown_index`.',
  },
  description: 'Find markdown files that reference [[target]] across the workspace. Returns { target, harness, hits[] }.',
  capability: 'wiki:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    target: z.string().min(1),
    harness: z.string().optional(),
  }),
  async handler(args) {
    const result = await findWikiBacklinks(args.target, args.harness ?? null);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
