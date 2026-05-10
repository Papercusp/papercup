/**
 * roles:known — return the static well-known role-id allowlist.
 *
 * The list is the kernel set of role ids the orchestrator + scoper +
 * UI use as defaults; plugin-registered roles append on top of this.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getKnownRoles } from '@/lib/known-roles';

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
  name: 'roles:known',
  description: 'Static well-known role-id allowlist (kernel set; plugin-registered roles extend this).',
  capability: 'roles:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    return { content: [{ type: 'text', text: JSON.stringify({ roles: getKnownRoles() }) }] };
  },
});
