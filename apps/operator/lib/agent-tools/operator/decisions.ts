/**
 * operator:decisions — read recent rows from the operator_decisions
 * SQL view (workspace-scoped). Mirrors GET /api/agent-mcp/decisions.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

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
  name: 'operator:decisions',
  description: 'Read recent operator_decisions rows for the active workspace (id, ts, actor, action, target, details).',
  capability: 'operator:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const limit = args.limit ?? 50;
    const workspaceId = activeWorkspaceId();
    const rows = await withWorkspace(workspaceId, async (tx) => {
      return await tx<
        Array<{ id: string; ts: number; actor: string; action: string; target: string; details: unknown }>
      >`
        SELECT id, ts, actor, action, target, details
          FROM harness_shared.operator_decisions
         ORDER BY ts DESC
         LIMIT ${limit}
      `;
    });
    return { content: [{ type: 'text', text: JSON.stringify({ decisions: rows }) }] };
  },
});
