/**
 * coord:watermark — read the caller's last-read pointers.
 *
 * agent-coordination-architecture-v2 §7.2. The OMP turn-start
 * extension calls this, then passes `messages_since_ts` to
 * `coord:inbox` so only genuinely-new entries are surfaced.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { readWatermark } from '../watermarks';

export default defineTool({
  name: 'coord:watermark',
  description:
    "Read your coordination watermark — the last-read ISO timestamps for messages / escalations / plan-events plus the subscription notify msg_ids already surfaced. Pass `messages_since_ts` to coord:inbox to see only what is new since your last turn.",
  guidance: {
    when: 'Turn start — the OMP coordination extension calls this to scope the inbox to new entries.',
    notWhen: 'Routine reads — coord:inbox without a watermark returns the full inbox.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const wm = await readWatermark(identity.ownerId);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ owner_id: identity.ownerId, watermark: wm }),
        },
      ],
    };
  },
});
