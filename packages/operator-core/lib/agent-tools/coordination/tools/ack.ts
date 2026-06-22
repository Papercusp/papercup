/**
 * coord:ack — acknowledge one OR many coord messages you received.
 *
 * Each ack is appended to the acker's OWN outbox (preserving the
 * one-writer-per-file invariant) with `related_msg_id` pointing at the original.
 * The sender sees it as a fresh inbox entry on their next coord:inbox.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): ack ONE inline
 * ({ msg_id }), MANY (msg_ids:[…]), or MANY heterogeneous (items:[{ msg_id }]) →
 * { ok, results:[{ ok, msg_id, ack_msg_id? + acked_from? | error }], counts }.
 * Each result self-describes its msg_id; an unknown msg_id never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { appendAck, readThread } from '../messages';
import { COORD_ROLES } from '../roles';
import { runBulk, bulkContent } from '../../_bulk';

const itemSpec = z.object({
  msg_id: z.string().min(1).describe('the coord msg_id to ack (alias: id)'),
  id: z.string().min(1).optional().describe('alias for msg_id'),
});

export default defineTool({
  name: 'coord:ack',
  description:
    'Acknowledge one OR many coord messages by msg_id. Posts a `kind: "ack"` entry in your outbox addressed back at each original sender, so they can see you received it. Single: { msg_id }. Many: { msg_ids:[…] } or items:[{ msg_id }]. Returns { ok, results:[{ ok, msg_id, ack_msg_id? + acked_from? | error }], counts } — correlate by msg_id; an unknown msg_id never fails the rest.',
  guidance: {
    when: 'After acting on (or deliberately not acting on) coord message(s) — closes the loop for the sender. Ack several at once via msg_ids:[…].',
    notWhen: 'For routine read-and-forget. Acks are most useful for hand-offs and questions where the sender is waiting.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      msg_id: z.string().min(1).optional().describe('single-ack shorthand: the coord msg_id'),
      id: z.string().min(1).optional().describe('alias for msg_id (single form)'),
      msg_ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('ack MANY messages at once'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('ack many messages at once — each { msg_id }'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (a.msg_ids?.length ?? 0) > 0 || Boolean(a.msg_id) || Boolean(a.id),
      { message: 'pass { msg_id } for one, or { msg_ids:[…] } / items:[{ msg_id }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ msg_id: it.msg_id ?? (it.id as string) }))
      : args.msg_ids?.length
        ? args.msg_ids.map((msg_id) => ({ msg_id }))
        : [{ msg_id: (args.msg_id ?? args.id) as string }];
    const env = await runBulk(
      list,
      async (it) => {
        // Find the original message (across all outboxes) so we can address the ack
        // back at its sender. Uses readThread — slightly wider than needed but it's
        // a single scan over a small directory.
        const thread = await readThread(it.msg_id);
        const target = thread.find((m) => m.msg_id === it.msg_id);
        if (!target) {
          return { ok: false as const, msg_id: it.msg_id, error: 'unknown_msg_id', detail: `no coord message with msg_id=${it.msg_id}` };
        }
        const acked = await appendAck(identity, it.msg_id, target.from);
        return { ok: true as const, msg_id: it.msg_id, ack_msg_id: acked.msg_id, acked: target.msg_id, acked_from: target.from };
      },
      { keyOf: (it) => ({ msg_id: it.msg_id }) },
    );
    return bulkContent(env);
  },
});
