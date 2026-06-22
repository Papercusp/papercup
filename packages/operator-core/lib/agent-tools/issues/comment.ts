/**
 * issues:comment — append a note to an issue's comment thread (Threadable,
 * engineer-issues-2026-06-03). Notifies the issue's subscribers.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): comment on ONE
 * inline ({ id, body }), MANY with the SAME body (ids:[…] + body), or MANY
 * heterogeneous (items:[{ id, body }]) → { ok, results:[{ ok, id, post? |
 * error }], counts }. Each result self-describes its id; one not-found item never
 * fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { commentIssue } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

const BODY = z.string().min(1).max(8000);

export default defineTool({
  name: 'issues:comment',
  profile: 'engineer',
  description:
    "Add a note to one OR many issues' comment threads. Subscribers are notified. Single: { id, body }. Many same body: { ids:[…], body }. Many heterogeneous: items:[{ id, body }]. Use for investigation findings, repro details, or a status update. Returns { ok, results:[{ ok, id, post? | error }], counts } — correlate by id; a not-found item never fails the rest.",
  guidance: {
    when: 'You have something to add to an existing issue — a repro, a root-cause finding, a decision, or progress. Comment on several at once via ids:[…]+body or items:[…].',
    notWhen: 'Editing the issue itself (issues:update) or resolving it (issues:close).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-comment shorthand: the issue id (use with `body`)'),
      body: BODY.optional().describe('the comment posted to the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('comment the same `body` on MANY issues (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), body: BODY }))
        .min(1)
        .max(200)
        .optional()
        .describe('comment many issues at once — each { id, body }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.body) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, body } for one, { ids:[…], body } for many of the same body, or items:[{ id, body }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, body: args.body as string }))
        : [{ id: args.id as string, body: args.body as string }];
    const env = await runBulk(
      list,
      async (it) => {
        const post = await commentIssue(it.id, it.body, ident.ownerId);
        return post
          ? { ok: true as const, id: it.id, post: { id: post.id, created_ts: post.created_ts } }
          : { ok: false as const, id: it.id, error: 'issue not found' };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
