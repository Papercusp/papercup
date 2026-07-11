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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { ackDelivery, cancelAwait } from '../../events/await/store';
import { cancelComposedTree } from '../../events/await/compose-store';
import { bulkContent, runBulk } from '../_bulk';

const cancelItemSchema = z
  .object({
    await_id: z.number().int().positive().optional().describe('The id events:await returned — retract the subscription.'),
    delivery_id: z.number().int().positive().optional().describe('A pending/parked wake delivery id — acknowledge it as received.'),
    root_id: z.number().int().positive().optional().describe('A composed await TREE root id (from events:status) — cancel the whole tree.'),
  })
  .refine((a) => a.await_id != null || a.delivery_id != null || a.root_id != null, {
    message: 'pass await_id, delivery_id, and/or root_id',
  });

type CancelItem = {
  await_id?: number;
  delivery_id?: number;
  root_id?: number;
};

export default defineTool({
  name: 'events:cancel',
  description:
    'Cancel one of your active events:await registrations (await_id — you will not be woken), cancel a whole composed await TREE by its root_id (cascades to every leaf + node), or ACK a pending/parked wake delivery you already saw via the inbox nudge (delivery_id — you will not be resumed for it). Pass at least one.',
  guidance: {
    when: 'The thing you were waiting on no longer matters (cancel the await), or a parked wake reached you in-turn via the inbox and you handled it (ack the delivery so the system does not also resume you).',
    notWhen: 'A fired await needs no cancel (one-shot — it already cleared). You cannot cancel or ack a peer’s.',
    chaining: 'events:status to find the await_id / delivery_id → events:cancel.',
    seeAlso: [
      'events:status (find the await_id / delivery_id to cancel)',
      'events:await (re-arm a wait after cancelling)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      await_id: z.number().int().positive().optional().describe('The id events:await returned — retract the subscription.'),
      await_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('await registrations to cancel'),
      delivery_id: z.number().int().positive().optional().describe('A pending/parked wake delivery id (from events:status or the inbox nudge) — acknowledge it as received.'),
      delivery_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('parked wake deliveries to acknowledge'),
      root_id: z.number().int().positive().optional().describe('A composed await TREE root id (from events:status) — cancel the whole tree (cascades to every leaf + node).'),
      root_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('composed await trees to cancel'),
      items: z.array(cancelItemSchema).min(1).max(200).optional().describe('mixed await/delivery/tree cancel or ack operations'),
    })
    .refine(
      (a) =>
        a.await_id != null ||
        a.delivery_id != null ||
        a.root_id != null ||
        (a.await_ids?.length ?? 0) > 0 ||
        (a.delivery_ids?.length ?? 0) > 0 ||
        (a.root_ids?.length ?? 0) > 0 ||
        (a.items?.length ?? 0) > 0,
      {
        message: 'pass await_id/delivery_id/root_id, *_ids, or items',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const items: CancelItem[] = [
      ...(args.await_id != null || args.delivery_id != null || args.root_id != null
        ? [{ await_id: args.await_id, delivery_id: args.delivery_id, root_id: args.root_id }]
        : []),
      ...(args.await_ids ?? []).map((await_id): CancelItem => ({ await_id })),
      ...(args.delivery_ids ?? []).map((delivery_id): CancelItem => ({ delivery_id })),
      ...(args.root_ids ?? []).map((root_id): CancelItem => ({ root_id })),
      ...(args.items ?? []),
    ];
    const env = await runBulk(
      items,
      async (item) => {
        const out: Record<string, unknown> = { ok: true };
        if (item.await_id != null) {
          const cancelled = await cancelAwait({
            awaitId: item.await_id,
            subscriberId: identity.ownerId,
          });
          out.await_id = item.await_id;
          out.cancelled = cancelled;
          if (!cancelled) out.ok = false;
        }
        if (item.root_id != null) {
          const cancelled = await cancelComposedTree({ rootId: item.root_id, subscriberId: identity.ownerId });
          out.root_id = item.root_id;
          out.cancelled = cancelled;
          if (!cancelled) out.ok = false;
        }
        if (item.delivery_id != null) {
          const acked = await ackDelivery({ deliveryId: item.delivery_id, subscriberId: identity.ownerId });
          out.delivery_id = item.delivery_id;
          out.acked = acked;
          if (!acked && item.await_id == null && item.root_id == null) out.ok = false;
        }
        if (out.ok !== true) out.error = 'not_found_or_not_yours_or_already_settled';
        return out as { ok: boolean; await_id?: number; delivery_id?: number; root_id?: number; error?: string };
      },
      { keyOf: (item) => ({ ...(item.await_id != null ? { await_id: item.await_id } : {}), ...(item.delivery_id != null ? { delivery_id: item.delivery_id } : {}), ...(item.root_id != null ? { root_id: item.root_id } : {}) }) },
    );
    return bulkContent(env);
  },
});
