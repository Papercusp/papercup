/**
 * operator:nudge — dedup-arbitrate a spoken voice nudge.
 *
 * Returns `{ fired: true }` when the nudge should be spoken (and
 * persists the timestamp). Returns `{ fired: false }` when the
 * per-kind dedup window is still active. Same logic as the legacy
 * /api/agent-mcp/operator-nudge route.
 *
 * Per-kind windows: budget 30 min, breaker 10 min, pause 5 min.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { maybeFireNudge, type NudgeKind } from '@/lib/voice-nudges';

const ALLOWED_KINDS = ['budget', 'breaker', 'pause'] as const;

export default defineTool({
  name: 'operator:nudge',
  description: 'Arbitrate a spoken nudge — returns { fired } indicating whether the per-kind dedup window allows speaking now.',
  capability: 'operator:write',
  requirePrincipal: false,
  roles: ['operator', 'architect'],
  rolesQuota: {
    architect: { perRun: 30 },
    operator: { perRun: 100 },
  },
  args: z.object({
    kind: z.enum(ALLOWED_KINDS),
  }),
  async handler(args) {
    const fired = await maybeFireNudge(args.kind as NudgeKind);
    return {
      content: [{ type: 'text', text: JSON.stringify({ fired, kind: args.kind }) }],
    };
  },
});
