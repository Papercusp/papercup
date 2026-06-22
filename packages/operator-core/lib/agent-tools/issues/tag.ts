/**
 * issues:tag — add/remove topic tags on one OR many issues (Taggable,
 * engineer-issues-2026-06-03). Tagging routes the issue to that topic's
 * subscribers.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): tag ONE inline
 * ({ id, add?, remove? }), MANY with the SAME add/remove sets (ids:[…] +
 * add?/remove?), or MANY heterogeneous (items:[{ id, add?, remove? }]) → { ok,
 * results:[{ ok, id, topics? | error }], counts }. Each result self-describes its
 * id; one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, tagIssue, untagIssue, getIssueDetail } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

const TOPICS = z.array(z.string().min(1)).max(8);

export default defineTool({
  name: 'issues:tag',
  profile: 'engineer',
  description:
    "Add or remove topic tags on one OR many issues. Tagging routes an issue to everyone subscribed to that topic — the main way an issue reaches the right people. Single: { id, add?, remove? }. Many same tags: { ids:[…], add?, remove? }. Many heterogeneous: items:[{ id, add?, remove? }]. topics:list to see/create topics. Returns { ok, results:[{ ok, id, topics? | error }], counts } — correlate by id; a not-found item never fails the rest.",
  guidance: {
    when: 'One or more issues belong to a relevance area (e.g. zero-cache, federation) so the people following that area should see them. Tag several at once via ids:[…] or items:[…].',
    notWhen: 'The topic does not exist yet — topics:create it first (prefer an existing one).',
    chaining: 'topics:list → issues:tag { add:[topic] }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-tag shorthand: the issue id'),
      add: TOPICS.optional().describe('topics to add to the inline id / every id in `ids`'),
      remove: TOPICS.optional().describe('topics to remove from the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('tag MANY issues with the same add/remove sets (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), add: TOPICS.optional(), remove: TOPICS.optional() }))
        .min(1)
        .max(200)
        .optional()
        .describe('tag many issues at once — each { id, add?, remove? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ id: it.id, add: it.add ?? args.add, remove: it.remove ?? args.remove }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, add: args.add, remove: args.remove }))
        : [{ id: args.id as string, add: args.add, remove: args.remove }];
    const env = await runBulk(
      list,
      async (it) => {
        const issue = await getIssue(it.id);
        if (!issue) return { ok: false as const, id: it.id, error: 'issue not found' };
        for (const t of it.add ?? []) await tagIssue(it.id, t, ident.ownerId);
        for (const t of it.remove ?? []) await untagIssue(it.id, t);
        const detail = await getIssueDetail(it.id);
        return { ok: true as const, id: it.id, topics: detail?.topics ?? [] };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
