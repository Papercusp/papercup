/**
 * topics:feed — read everything tagged a topic, across issues / conversations /
 * features / plans: the whole work-stream of an area (integration-adoption-
 * 2026-06-03, Capstone P1; substrate D-001 cross-object index).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): read ONE inline
 * ({ topic }) or MANY (topics:[…] / items:[{ topic }]) →
 * { ok, results:[{ ok, topic, count, items | error }], counts }. Each result
 * self-describes its topic and carries that topic's own feed; one topic that
 * fails to read never fails the rest; correlate by topic, not array position.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { topicFeed } from '../../../topics-feed';
import { mergeIds, runBulk, bulkContent } from '../../_bulk';

export default defineTool({
  name: 'topics:feed',
  description:
    'Read everything tagged with one OR many topics — across issues, conversations, features, and plans — the whole work-stream of an area. Each item carries its title + current state. Single: { topic }. Many: { topics:[…] } or items:[{ topic }]. Returns { ok, results:[{ ok, topic, count, items | error }], counts } — correlate by topic, not position; a topic that fails to read never fails the rest.',
  guidance: {
    when: 'To understand all current work in a relevance area before you start in it, or to see what is happening with e.g. `zero-cache` across every object kind. Read several areas at once via topics:[…].',
    notWhen: 'You want messages waiting for you (coord:inbox) or just the list of topics (topics:list).',
    chaining: 'topics:list → topics:feed { topic } → work_items:get / conversations:get on an item.',
    seeAlso: [
      'topics:list (browse topics first)',
      'work_items:get (drill into an item from the feed)',
      'conversations:get (drill into a conversation from the feed)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      topic: z.string().min(1).optional().describe('single-read shorthand: the topic slug'),
      topics: z.array(z.string().min(1)).min(1).max(100).optional().describe('read MANY topic feeds at once (homogeneous)'),
      items: z
        .array(z.object({ topic: z.string().min(1) }))
        .min(1)
        .max(100)
        .optional()
        .describe('read many topic feeds at once — each { topic }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.topics?.length ?? 0) > 0 || Boolean(a.topic), {
      message: 'pass { topic } for one, or { topics:[…] } / items:[{ topic }] for many',
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const topics = mergeIds(args.topic, [
      ...(args.topics ?? []),
      ...(args.items?.map((it) => it.topic) ?? []),
    ]);
    const env = await runBulk(
      topics,
      async (topic) => {
        const items = await topicFeed(topic);
        return { ok: true as const, topic, count: items.length, items };
      },
      { keyOf: (topic) => ({ topic }) },
    );
    return bulkContent(env);
  },
});
