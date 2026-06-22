/**
 * work_items:tag — Taggable (D-003). Add/remove a topic tag (coord_links rel='tagged')
 * so the work-item routes to that area's subscribers.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): tag ONE item inline
 * ({ id, topic, remove? }), MANY with the SAME topic (ids:[…] + topic), or MANY
 * heterogeneous (items:[{ id, topic, harness?, remove? }]) → { ok, results:[{ ok,
 * id, topic? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The rationale-reproject reaction fires per item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { tagWorkItem, untagWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  topic: z.string().min(1).max(80),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  remove: z.boolean().optional().describe('untag instead of tag'),
});

export default defineTool({
  name: 'work_items:tag',
  profile: 'engineer',
  description:
    'Tag one OR many work-items with a topic (or untag with remove:true) — routes the item to that topic\'s subscribers. Single: { id, topic }. Many same topic: { ids:[…], topic }. Many heterogeneous: items:[{ id, topic, harness?, remove? }]. Returns { ok, results:[{ ok, id, topic? | error }], counts } — correlate by id; a not-found item never fails the rest.',
  guidance: {
    when: 'You want a work-item visible to agents following an area (topics:list to see topics). Tag several at once via ids:[…]+topic or items:[…].',
    chaining: 'topics:list → work_items:tag { topic } (or { ids, topic }).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-tag shorthand: the work-item id (use with `topic`)'),
      topic: z.string().min(1).max(80).optional().describe('the topic slug applied to the inline id / every id in `ids`'),
      remove: z.boolean().optional().describe('untag instead of tag (applies to the inline id / every id in `ids`)'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('tag MANY items with the same `topic` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('tag many work-items at once — each { id, topic, harness?, remove? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.topic) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, topic } for one, { ids:[…], topic } for many of the same topic, or items:[{ id, topic }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, topic: args.topic as string, harness: args.harness, remove: args.remove }))
        : [{ id: args.id as string, topic: args.topic as string, harness: args.harness, remove: args.remove }];
    const env = await runBulk(
      list,
      async (it) => {
        const opts = { harness: it.harness ?? args.harness };
        const res = it.remove
          ? await untagWorkItem(it.id, it.topic, opts)
          : await tagWorkItem(it.id, it.topic, { ...opts, by: ident.ownerId });
        return 'error' in res
          ? { ok: false as const, id: it.id, error: res.error }
          : { ok: true as const, id: it.id, topic: it.topic };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
