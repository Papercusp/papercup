/**
 * operator:trigger_state — read the workspace's trigger-state
 * fingerprint (background scanner uses this to decide when to re-scan).
 *
 * Read-only; cached 1s per process via the underlying lib.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { fingerprint, readTriggerState } from '../../operator-trigger-state';

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
  name: 'operator:trigger_state',
  profile: 'engineer',
  description: 'Read the workspace trigger-state fingerprint + raw state (used by background scanner to decide rescans).',
  capability: 'operator:read',
  guidance: {
    when: `Read scanner trigger state — when the next scan fires, what's pending.`,
    notWhen: `For LIVE scan results, use \`operator:last_scan\` or \`operator:scans_list\`.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const state = await readTriggerState();
    return { content: [{ type: 'text', text: JSON.stringify({ fingerprint: fingerprint(state), state }) }] };
  },
});
