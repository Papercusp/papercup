/**
 * operator:scanner_reset — wipe the workspace's persistent scanner
 * session so the next scan starts a fresh Claude conversation.
 *
 * Useful after major workspace shifts (new harness scaffolded, big
 * directive batch dispatched, scanner started looping on stale
 * context). No-op when OPERATOR_SCANNER_RESUME is unset.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  isScannerResumeEnabled,
  resetScannerSession,
} from '../../operator-scanner-session';

export default defineTool({
  name: 'operator:scanner_reset',
  profile: 'engineer',
  description: 'Wipe the workspace scanner session so the next scan starts a fresh Claude conversation.',
  capability: 'operator:write',
  guidance: {
    when: `Reset the scanner's state machine (cooldown, queues). Use when diagnostics show the scanner is stuck.`,
    notWhen: `Don't reset speculatively — only when a scan has visibly failed to fire for >1 cycle.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({}),
  async handler() {
    await resetScannerSession();
    const enabled = isScannerResumeEnabled();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            enabled,
            note: enabled
              ? 'Scanner session cleared. Next scan starts fresh.'
              : 'Scanner-resume is disabled (set OPERATOR_SCANNER_RESUME=1 to enable). Reset is a no-op until then.',
          }),
        },
      ],
    };
  },
});
