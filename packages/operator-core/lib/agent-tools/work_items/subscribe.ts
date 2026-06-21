/**
 * work_items:subscribe — Subscribable (D-003). Follow a work-item to receive its
 * change fan-out (full | digest | mention).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): pass `id` for one or
 * `ids` for several (shared `mode`/`harness`) → { ok, results:[{ ok, id, error? }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { subscribeWorkItem } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'work_items:subscribe',
  profile: 'engineer',
  description:
    'Subscribe to one OR many work-items so their updates fan out to your inbox — pass `id` for one or `ids` for several (shared `mode`: full | digest | mention). Returns { ok, results:[{ ok, id, error? }], counts }.',
  guidance: {
    when: 'You want to follow one or more work-items you do not own (e.g. ones that block yours). Subscribe to several at once via `ids`.',
    chaining: 'work_items:get → work_items:subscribe.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to subscribe to (1–100)'),
      mode: z.enum(['full', 'digest', 'mention']).optional(),
      harness: z.string().max(80).optional(),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const res = await subscribeWorkItem(ident.ownerId, id, args.mode ?? 'full', { harness: args.harness });
        return 'error' in res ? { ok: false as const, id, error: res.error } : { ok: true as const, id };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
