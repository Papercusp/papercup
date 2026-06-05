/**
 * autoloop:control — pause or resume the in-process autoloop ticker.
 *
 * Process-local: only affects the operator process the tool is called
 * against. Pause clears the global timer + flag; resume calls
 * startAutoLoopOnce() (idempotent — if already running, no-op).
 *
 * Operator-only: pausing the autoloop affects every harness in the
 * workspace, so it's not a per-spawn decision.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { startAutoLoopOnce, stopAutoLoop } from '../../autoloop';

export default defineTool({
  name: 'autoloop:control',
  profile: 'engineer',
  guidance: {
    when: 'User says "pause the autoloop", "turn it on", "stop autopilot". Toggles enabled/paused for a harness.',
    notWhen: 'For PAUSING all of the operator (silence-mode-style), use the operator-pause flag in operator-internal tools — autoloop is per-harness, operator pause is global.',
  },
  description: 'Pause or resume the operator-process autoloop ticker (process-local; affects every harness in the workspace).',
  capability: 'autoloop:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    op: z.enum(['pause', 'resume']),
  }),
  async handler(args) {
    if (args.op === 'pause') {
      stopAutoLoop();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, op: 'pause' }) }] };
    }
    startAutoLoopOnce();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, op: 'resume' }) }] };
  },
});
