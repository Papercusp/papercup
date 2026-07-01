/**
 * topics:subscribe — follow a topic; its updates get injected into your context.
 *
 * Delivery mode (D-006 — the noise control) is mandatory tiering:
 *   full    — every update (default; use for areas you're actively in)
 *   digest  — a coalesced count + one-line (use for high-churn areas)
 *   mention — only when @-addressed or on resolution (the quiet floor)
 * Optional ttl_sec auto-drops the subscription (a refactor you'll finish soon).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): subscribe to ONE
 * inline ({ topic, mode?, ttl_sec? }), MANY with the SAME mode/ttl
 * (topics:[…] + mode?/ttl_sec?), or MANY heterogeneous (items:[{ topic, mode?,
 * ttl_sec? }]) → { ok, results:[{ ok, topic, subscription? | error }], counts }.
 * Each result self-describes its topic; one failure never fails the rest;
 * correlate by topic, not array position.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { subscribeTopic } from '../topics';
import { runBulk, bulkContent } from '../../_bulk';

const MODE = z.enum(['full', 'digest', 'mention']);
const itemSpec = z.object({
  topic: z.string().min(1),
  mode: MODE.optional().describe('per-item delivery mode (else the batch `mode` default)'),
  ttl_sec: z.number().int().positive().optional().describe('per-item TTL (else the batch `ttl_sec` default)'),
});

export default defineTool({
  name: 'topics:subscribe',
  description:
    'Subscribe to one OR many topics so their updates are injected into your inbox — the named sugar for watch(topic,{wake:false}). mode = full | digest | mention (D-006 noise tiering). Subscribe to the built-in `new_topic` to learn of new topics as they appear. Idempotent — re-subscribing updates the mode/TTL. Single: { topic, mode?, ttl_sec? }. Many same mode: { topics:[…], mode?, ttl_sec? }. Many heterogeneous: items:[{ topic, mode?, ttl_sec? }]. Returns { ok, results:[{ ok, topic, subscription? | error }], counts } — correlate by topic, not position; one failure never fails the rest.',
  guidance: {
    when: 'A topic in topics:list is relevant to your current work and you want its updates pushed to you. Pick digest for high-churn areas, mention to stay quiet. Subscribe to several at once via topics:[…] or items:[…].',
    notWhen: 'You only need a one-time look — just topics:list. To follow a specific object (one thread/issue), that is the object’s own subscribe, not a topic.',
    chaining: 'topics:list → topics:subscribe; topics:unsubscribe to stop.',
    seeAlso: [
      'topics:unsubscribe (stop following)',
      'topics:feed (read the topic you subscribed to)',
      'topics:list (find topics to follow)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      topic: z.string().min(1).optional().describe('single-subscribe shorthand: the topic slug'),
      mode: MODE.optional().describe('delivery mode applied to the inline topic / every topic in `topics`'),
      ttl_sec: z.number().int().positive().optional().describe('TTL applied to the inline topic / every topic in `topics`'),
      topics: z.array(z.string().min(1)).min(1).max(200).optional().describe('subscribe to MANY topics with the same `mode`/`ttl_sec` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('subscribe to many topics at once — each { topic, mode?, ttl_sec? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.topics?.length ?? 0) > 0 || Boolean(a.topic), {
      message: 'pass { topic } for one, { topics:[…] } for many of the same mode, or items:[{ topic }] for many',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ topic: it.topic, mode: it.mode ?? args.mode, ttl_sec: it.ttl_sec ?? args.ttl_sec }))
      : args.topics?.length
        ? args.topics.map((topic) => ({ topic, mode: args.mode, ttl_sec: args.ttl_sec }))
        : [{ topic: args.topic as string, mode: args.mode, ttl_sec: args.ttl_sec }];
    const env = await runBulk(
      list,
      async (it) => {
        const sub = await subscribeTopic(identity, it.topic, { mode: it.mode, ttl_sec: it.ttl_sec });
        return {
          ok: true as const,
          topic: it.topic,
          subscription: { topic: sub.target_ref, mode: sub.delivery_mode, expires_ts: sub.expires_ts },
        };
      },
      { keyOf: (it) => ({ topic: it.topic }) },
    );
    return bulkContent(env);
  },
});
