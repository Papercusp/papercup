/**
 * issues:subscribe — follow one OR many issues (object subscription, Subscribable,
 * engineer-issues-2026-06-03). Their updates inject into your inbox. To follow a
 * whole AREA, subscribe the topic (topics:subscribe) instead.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): subscribe ONE inline
 * ({ id, mode?, unsubscribe? }), MANY with the SAME mode/unsubscribe (ids:[…] +
 * mode?/unsubscribe?), or MANY heterogeneous (items:[{ id, mode?, unsubscribe? }])
 * → { ok, results:[{ ok, id, subscribed? | error }], counts }. Each result
 * self-describes its id; one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, subscribeIssue, unsubscribeIssue } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

const MODE = z.enum(['full', 'digest', 'mention']);

export default defineTool({
  name: 'issues:subscribe',
  profile: 'engineer',
  description:
    'Follow one OR many specific issues so their comments/updates/resolution inject into your inbox. mode = full | digest | mention. Pass unsubscribe:true to stop. Single: { id, mode?, unsubscribe? }. Many: { ids:[…], mode?, unsubscribe? } or items:[{ id, mode?, unsubscribe? }]. Returns { ok, results:[{ ok, id, subscribed? | error }], counts } — correlate by id; a not-found item never fails the rest. (To follow an area, use topics:subscribe.)',
  guidance: {
    when: 'You care about one or more specific issues (you reported them, depend on them, or can contribute) and want their updates pushed to you. Subscribe several at once via ids:[…] or items:[…].',
    notWhen: 'You want everything in an area — topics:subscribe is the scalable unit.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-subscribe shorthand: the issue id'),
      mode: MODE.optional().describe('applies to the inline id / every id in `ids`'),
      unsubscribe: z.boolean().optional().describe('stop following; applies to the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('subscribe MANY issues with the same mode/unsubscribe (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), mode: MODE.optional(), unsubscribe: z.boolean().optional() }))
        .min(1)
        .max(200)
        .optional()
        .describe('subscribe many issues at once — each { id, mode?, unsubscribe? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ id: it.id, mode: it.mode ?? args.mode, unsubscribe: it.unsubscribe ?? args.unsubscribe }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, mode: args.mode, unsubscribe: args.unsubscribe }))
        : [{ id: args.id as string, mode: args.mode, unsubscribe: args.unsubscribe }];
    const env = await runBulk(
      list,
      async (it) => {
        const issue = await getIssue(it.id);
        if (!issue) return { ok: false as const, id: it.id, error: 'issue not found' };
        if (it.unsubscribe) await unsubscribeIssue(ident.ownerId, it.id);
        else await subscribeIssue(ident.ownerId, it.id, it.mode ?? 'full');
        return { ok: true as const, id: it.id, subscribed: !it.unsubscribe };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
