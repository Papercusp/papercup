/**
 * autoloop:status — read autoloop_state rows for a harness slug.
 *
 * Returns null when no rows exist (autoloop hasn't fired for this
 * harness yet) so callers can distinguish "no data" from empty array.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getAutoLoopState } from '../../autoloop';

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
  name: 'autoloop:status',
  profile: 'engineer',
  guidance: {
    when: 'User asks "is the autoloop running?", "is the harness on autopilot?". Reads enabled/paused state + recent tick info.',
    notWhen: 'For TURNING the autoloop on/off, use `autoloop:control`. For harness liveness in general, use `harness:health`.',
    chaining: 'Pair with `autoloop:control` if the user wants to change state.',
  },
  description: 'Read autoloop_state rows (last_fired_at, last_status, consecutive_errors) for a harness slug.',
  capability: 'autoloop:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) {
      throw new Error('autoloop:status — harness slug required (passed or in spawn ctx)');
    }
    const rows = await getAutoLoopState(slug);
    return {
      content: [{ type: 'text', text: JSON.stringify({ harnessSlug: slug, rows }) }],
    };
  },
});
