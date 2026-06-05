/**
 * hooks:known — return the static well-known hook-event allowlist.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getKnownHooks } from '../../known-hooks';

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
  profile: 'engineer',
  guidance: {
    when: 'Static enum of supported hook event names — use to validate an event string before firing or registering for it.',
    notWhen: 'For PENDING events queued up, use `pending_events:list`. For firing an event, use `plugins:fire_event`.',
  },
  description: 'Static well-known hook-event allowlist (kernel set; plugin-registered hooks extend this).',
  capability: 'roles:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    return { content: [{ type: 'text', text: JSON.stringify({ hooks: getKnownHooks() }) }] };
  },
});
