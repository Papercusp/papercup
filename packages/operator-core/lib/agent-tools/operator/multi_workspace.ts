/**
 * operator:multi_workspace — read-only aggregation of every other
 * workspace's last-scan snapshot. The active workspace is omitted.
 * Cards arrive with workspaceId + workspaceName so a panel can route
 * a click into the correct workspace switch.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { readMultiWorkspaceSnapshot } from '../../operator-multi-workspace';

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
  profile: 'engineer',
  // P-062 Phase 4: aggregates every OTHER workspace's snapshot — inherently
  // cross-workspace, so it must never be RLS-scoped to the caller's workspace.
  crossWorkspace: true,
  description: 'Aggregation of every other workspace\'s last-scan snapshot (active workspace omitted).',
  capability: 'operator:read',
  guidance: {
    when: `List workspaces the operator can switch between — used by the workspace switcher.`,
    notWhen: `For the CURRENT workspace's harnesses, use \`harness:list\`. multi_workspace is the workspace enumerator.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const snapshot = await readMultiWorkspaceSnapshot(activeWorkspaceId());
    return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
  },
});
