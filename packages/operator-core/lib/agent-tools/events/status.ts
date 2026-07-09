/**
 * events:status — your active awaits + recent wake deliveries + the wake meter
 * (await-event-primitive-2026-06-05 P-003/P-005, D-007).
 *
 * The meter half is the cost-discipline window: every wake is a turn, so
 * per-agent wake counts (by status + channel, last 24h) make a wake-storm
 * visible immediately.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { listActiveAwaits, listRecentDeliveries, wakeMeter } from '../../events/await/store';

export default defineTool({
  name: 'events:status',
  description:
    'Inspect the await-event surface: your active awaits, your recent wake deliveries (with channel + status), and optionally the workspace wake meter (per-agent wake counts, last 24h — the wake-storm detector).',
  guidance: {
    when: 'Checking what you are (still) waiting on, whether a wake fired and via which channel, or whether the fleet is wake-storming (meter: true).',
    notWhen: 'Reading your message stream — that is coord:inbox. Following an area — topics:feed.',
    seeAlso: [
      'events:cancel (cancel an await you found here)',
      'events:await (arm a new wait)',
      'coord:inbox (your message stream, not the event registry)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    meter: z.boolean().optional().describe('Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [awaits, recent, meter] = await Promise.all([
      listActiveAwaits(identity.ownerId),
      listRecentDeliveries(identity.ownerId, 10),
      args.meter ? wakeMeter() : Promise.resolve(null),
    ]);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            active_awaits: awaits.map((a) => ({
              await_id: a.id,
              event: a.eventKey,
              policy: a.policy,
              note: a.note,
              expires_ts: a.expiresTs,
              on_timeout: a.timeoutBehavior,
              created_at: a.createdAt,
            })),
            recent_wakes: recent.map((d) => ({
              delivery_id: d.id,
              event: d.eventKey,
              status: d.status,
              channel: d.channel,
              attempts: d.attempts,
              last_error: d.lastError,
              created_at: d.createdAt,
              delivered_at: d.deliveredAt,
            })),
            ...(meter ? { meter } : {}),
          }),
        },
      ],
    };
  },
});
