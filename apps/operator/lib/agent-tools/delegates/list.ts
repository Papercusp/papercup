/**
 * delegates:list — fetch one delegate by id, search by ILIKE, or list
 * by status. Mirrors GET /api/agent-mcp/delegates with a single
 * discriminator. Degrades to an empty list when the underlying tables
 * haven't been migrated.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  getDelegate,
  listDelegates,
  searchDelegates,
} from '@/lib/delegates';

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
  name: 'delegates:list',
  description: 'List delegate sessions by status, search by ILIKE, or fetch one by id. Same shape as the legacy /api/agent-mcp/delegates GET.',
  capability: 'delegates:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    id: z.string().optional(),
    query: z.string().min(1).optional(),
    status: z.enum(['open', 'archived', 'all']).optional(),
    limit: z.number().int().positive().max(50).optional(),
  }),
  async handler(args) {
    const workspace = activeWorkspaceId();
    if (args.id) {
      const session = await getDelegate(workspace, args.id);
      return { content: [{ type: 'text', text: JSON.stringify({ session }) }] };
    }
    const limit = args.limit ?? 20;
    try {
      const sessions = args.query
        ? await searchDelegates({ workspace, query: args.query, limit })
        : await listDelegates({ workspace, status: args.status ?? 'open', limit });
      return { content: [{ type: 'text', text: JSON.stringify({ sessions }) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/relation .*(claude_sessions|delegates).* does not exist/i.test(msg)) {
        return { content: [{ type: 'text', text: JSON.stringify({ sessions: [] }) }] };
      }
      throw e;
    }
  },
});
