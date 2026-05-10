/**
 * actions:recent — list recent long-running user-initiated actions for
 * a harness (replan, cleanup, snapshot).
 *
 * Calls listUserActions() in lib/user-actions-data.ts directly — same
 * function the GET /api/user-actions/:slug route projects. Shares the
 * same in-memory cache so MCP and HTTP polls coalesce.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { InvalidSlugError, listUserActions } from '@/lib/user-actions-data';

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
  name: 'actions:recent',
  description: 'List recent long-running user-initiated actions for a harness (replan, cleanup, snapshot).',
  capability: 'actions:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    try {
      const result = await listUserActions({ slug: args.slug, limit: args.limit });
      const actions = result.actions.slice(0, args.limit ?? 20);
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: actions.length, actions }) }],
      };
    } catch (err) {
      if (err instanceof InvalidSlugError) {
        return { content: [{ type: 'text', text: JSON.stringify({ count: 0, actions: [] }) }] };
      }
      throw err;
    }
  },
});
