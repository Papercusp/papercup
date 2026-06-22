/**
 * issues:close — set an issue's lifecycle to resolved/closed, or reopen it
 * (Lifecycle, engineer-issues-2026-06-03). A resolution notifies even
 * mention-mode subscribers (D-006).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): close ONE inline
 * ({ id, state? }), MANY to the SAME state (ids:[…] + state?), or MANY
 * heterogeneous (items:[{ id, state? }]) → { ok, results:[{ ok, id, issue? |
 * error }], counts }. Each result self-describes its id; one not-found item never
 * fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setIssueState } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

const STATE = z.enum(['resolved', 'closed', 'open']);

export default defineTool({
  name: 'issues:close',
  profile: 'engineer',
  description:
    "Set one OR many issues' lifecycle state: resolved (fixed/answered), closed (won't-fix / no longer relevant), or open (reopen). Single: { id, state? }. Many same state: { ids:[…], state? }. Many heterogeneous: items:[{ id, state? }]. Resolving notifies all subscribers, including mention-mode. Returns { ok, results:[{ ok, id, issue? | error }], counts } — correlate by id; a not-found item never fails the rest.",
  guidance: {
    when: 'An issue is fixed (resolved) or is being dropped without a fix (closed). Reopen with state=open if it recurs. Close several at once via ids:[…]+state or items:[…].',
    notWhen: 'Promoting it to a tracked fix feature — issues:promote (which keeps it open/fixing until the feature lands).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-close shorthand: the issue id'),
      state: STATE.optional().describe('default resolved; applies to the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('close MANY issues to the same `state` (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), state: STATE.optional() }))
        .min(1)
        .max(200)
        .optional()
        .describe('close many issues at once — each { id, state? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ id: it.id, state: it.state ?? args.state }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, state: args.state }))
        : [{ id: args.id as string, state: args.state }];
    const env = await runBulk(
      list,
      async (it) => {
        const issue = await setIssueState(it.id, it.state ?? 'resolved', ident.ownerId);
        return issue
          ? { ok: true as const, id: it.id, issue: { id: issue.id, state: issue.state } }
          : { ok: false as const, id: it.id, error: 'issue not found' };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
