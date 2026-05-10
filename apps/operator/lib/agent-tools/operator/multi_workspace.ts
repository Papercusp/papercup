/**
 * operator:multi_workspace — read-only aggregation of every other
 * workspace's last-scan snapshot. The active workspace is omitted.
 * Cards arrive with workspaceId + workspaceName so a panel can route
 * a click into the correct workspace switch.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readMultiWorkspaceSnapshot } from '@/lib/operator-multi-workspace';

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
  name: 'operator:multi_workspace',
  description: 'Aggregation of every other workspace\'s last-scan snapshot (active workspace omitted).',
  capability: 'operator:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const snapshot = await readMultiWorkspaceSnapshot(activeWorkspaceId());
    return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
  },
});
