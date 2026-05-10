/**
 * hooks:known — return the static well-known hook-event allowlist.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getKnownHooks } from '@/lib/known-hooks';

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
  name: 'hooks:known',
  description: 'Static well-known hook-event allowlist (kernel set; plugin-registered hooks extend this).',
  capability: 'roles:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    return { content: [{ type: 'text', text: JSON.stringify({ hooks: getKnownHooks() }) }] };
  },
});
