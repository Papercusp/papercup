/**
 * work_items:comment — Threadable (D-003). Append a comment to a work-item's thread
 * (creates the thread on first post) and fan out to its subscribers. Dispatches by
 * kind: issue-family rides issues-engineer.commentIssue; feature-family threads on
 * the feature ObjectRef.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): comment on ONE item
 * inline ({ id, body }) or MANY in one call (items:[{ id, body, harness? }]) →
 * { ok, results:[{ ok, id, post? | error }], counts }. Each result self-describes its
 * id; one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { commentWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  body: z.string().min(1).max(8000),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

export default defineTool({
  name: 'work_items:comment',
  profile: 'engineer',
  description:
    'Comment on one OR many work-items (any kind) in one call. Single: { id, body }. Many: items:[{ id, body, harness? }]. Appends to each item\'s thread (created on first comment) and notifies its subscribers. Returns { ok, results:[{ ok, id, post? | error }], counts } — correlate by id; a not-found item never fails the rest.',
  guidance: {
    when: 'You have an update, finding, or question to post on one or more work-items. Comment on several at once via items:[…] instead of one call each.',
    notWhen: 'A contextual aside not tied to a work-item → coord:send. A structured completion → work_items:complete.',
    chaining: 'work_items:get → work_items:comment; work_items:subscribe to follow the thread.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-comment shorthand: the work-item id (use with `body`)'),
      body: z.string().min(1).max(8000).optional().describe('single-comment shorthand: the comment text (use with `id`)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('comment on many work-items at once — each { id, body, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.body)), {
      message: 'pass { id, body } for one, or items:[{ id, body }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [{ id: args.id as string, body: args.body as string, harness: args.harness }];
    const env = await runBulk(
      items,
      async (it) => {
        const post = await commentWorkItem(it.id, it.body, ident.ownerId, { harness: it.harness ?? args.harness });
        return post ? { ok: true as const, id: it.id, post } : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
