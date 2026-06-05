/**
 * plugins:runtime_status — read the in-process plugin host's status
 * (loaded plugins, registered actions, mounted api routes, etc.).
 *
 * Mirrors GET /api/plugins/runtime/status (without the `?reset=1`
 * test-mode side effect — that's UI-only diagnostic and shouldn't
 * leak to agents).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pluginHostStatus } from '../../plugin-host-runtime';

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
  name: 'plugins:runtime_status',
  profile: 'engineer',
  guidance: {
    when: 'You need to know which plugins are loaded + healthy in the current operator process (per-harness or workspace-level).',
    notWhen: 'For the plugin CATALOG (everything installable), use the marketplace endpoints. plugins:runtime_status is the runtime view.',
  },
  description: 'Read the plugin host runtime status (loaded plugins, registered actions, mounted api routes).',
  capability: 'plugins:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const status = await pluginHostStatus();
    return { content: [{ type: 'text', text: JSON.stringify(status) }] };
  },
});
