/**
 * coord:inbox — read the caller's coordination inbox.
 *
 * Union scan of every agent's outbox in coord/messages/, filtered to
 * entries addressed to me (or to '*'). Sorted by ts ascending.
 * Forgiving of malformed lines.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { readInbox } from '../messages';
import { heartbeatPresence } from '../presence';
import { COORD_ROLES } from '../roles';

const COORD_KINDS = [
  'message',
  'ack',
  'subscribe',
  'unsubscribe',
  'notify',
  'handoff',
  'handoff_accepted',
  'escalation',
  'escalation_resolved',
  'contract',
  'plan_event',
] as const;

export default defineTool({
  name: 'coord:inbox',
  description:
    'Read your coordination inbox — messages, acks, notifies, handoffs etc. addressed to you (or broadcast). Optional `since_ts` filters strictly later than the given ISO timestamp; `kinds` narrows to specific entry kinds.',
  guidance: {
    when: 'At turn start (the OMP hook will do this for you once it ships); whenever you suspect another agent contacted you.',
    notWhen: 'For agent-presence ("who is active?") — use coord:presence. For file locks — use locks:queue.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    kinds: z.array(z.enum(COORD_KINDS)).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Piggyback liveness: reading your inbox IS a heartbeat. Keeps a fresh
    // coord:presence row for every active agent (the read hook runs every
    // tool call) without clobbering a declared intent. Best-effort, and run
    // concurrently with the read so it adds no latency.
    const [, entries] = await Promise.all([
      heartbeatPresence(identity).catch(() => {}),
      readInbox(identity.ownerId, { since_ts: args.since_ts, kinds: args.kinds }),
    ]);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ owner_id: identity.ownerId, entries }),
        },
      ],
    };
  },
});
