/**
 * operator:scans_list — recent operator scans for the active workspace.
 *
 * Single tool that supersedes `?id=`, `?q=`, and bare list semantics
 * of GET /api/agent-mcp/operator-scans:
 *   - { id }          → fetch one scan by id (full suggestions)
 *   - { query }       → ILIKE search across summary/request/suggestions
 *   - { limit? }      → most-recent N scans
 *
 * Returns `{ scan }` for id lookups, `{ scans }` for list/search —
 * mirrors the legacy route's response shape so registry-defs callers
 * (lib/commands/defs/scans.ts) can switch URL with no shape changes.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  getOperatorScan,
  listOperatorScans,
  searchOperatorScans,
} from '../../operator-scans';

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
  name: 'operator:scans_list',
  profile: 'engineer',
  description: 'List recent operator scans, search by ILIKE, or fetch one by id. Mirrors the agent-mcp/operator-scans route.',
  capability: 'operator:read',
  guidance: {
    when: `List past operator scans — summaries only (id, ts, summary, error). Use to find a scan id.`,
    notWhen: `For ONE scan's full body, use the scans_get tool. For LIVE scanning state, use \`operator:last_scan\` or \`operator:trigger_state\`.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    id: z.number().int().optional(),
    query: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async handler(args) {
    const workspaceId = activeWorkspaceId();
    if (typeof args.id === 'number') {
      const scan = await getOperatorScan({ workspaceId, id: args.id });
      return { content: [{ type: 'text', text: JSON.stringify({ scan }) }] };
    }
    const limit = args.limit ?? (args.query ? 10 : 20);
    try {
      const scans = args.query
        ? await searchOperatorScans({ workspaceId, query: args.query, limit })
        : await listOperatorScans({ workspaceId, limit });
      return { content: [{ type: 'text', text: JSON.stringify({ scans }) }] };
    } catch (e) {
      // Same fallback as the legacy route — table may not exist yet on
      // first call before any scan has run.
      const msg = e instanceof Error ? e.message : String(e);
      if (/relation .*operator_scans.* does not exist/i.test(msg)) {
        return { content: [{ type: 'text', text: JSON.stringify({ scans: [] }) }] };
      }
      throw e;
    }
  },
});
