/**
 * events:cancel — retract one of YOUR active awaits, or ACK one of your
 * pending/parked wake deliveries (await-event-primitive-2026-06-05 P-003,
 * D-007).
 *
 * Subscriber-scoped both ways: you can only cancel/ack your own (a peer's
 * await is their wait, not yours to kill).
 *
 * The ack half exists because the parked path delivers the wake reason via
 * your coord inbox while you are still awake — if you act on it in-turn, ack
 * the delivery so the pump does not also resume you later (a wake = a turn;
 * an acked wake never burns one).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { ackDelivery, cancelAwait } from '../../events/await/store';

const SU_ROLES = [
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
  name: 'events:cancel',
  description:
    'Cancel one of your active events:await registrations (await_id — you will not be woken), or ACK a pending/parked wake delivery you already saw via the inbox nudge (delivery_id — you will not be resumed for it). Pass at least one.',
  guidance: {
    when: 'The thing you were waiting on no longer matters (cancel the await), or a parked wake reached you in-turn via the inbox and you handled it (ack the delivery so the system does not also resume you).',
    notWhen: 'A fired await needs no cancel (one-shot — it already cleared). You cannot cancel or ack a peer’s.',
    chaining: 'events:status to find the await_id / delivery_id → events:cancel.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      await_id: z.number().int().positive().optional().describe('The id events:await returned — retract the subscription.'),
      delivery_id: z.number().int().positive().optional().describe('A pending/parked wake delivery id (from events:status or the inbox nudge) — acknowledge it as received.'),
    })
    .refine((a) => a.await_id != null || a.delivery_id != null, {
      message: 'pass await_id and/or delivery_id',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const out: Record<string, unknown> = { ok: true };
    if (args.await_id != null) {
      const cancelled = await cancelAwait({
        awaitId: args.await_id,
        subscriberId: identity.ownerId,
        workspaceId: identity.workspaceId ?? undefined,
      });
      out.await_id = args.await_id;
      out.cancelled = cancelled;
      if (!cancelled) out.ok = false;
    }
    if (args.delivery_id != null) {
      const acked = await ackDelivery({ deliveryId: args.delivery_id, subscriberId: identity.ownerId });
      out.delivery_id = args.delivery_id;
      out.acked = acked;
      if (!acked && args.await_id == null) out.ok = false;
    }
    if (out.ok !== true) out.reason = 'not_found_or_not_yours_or_already_settled';
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
    };
  },
});
