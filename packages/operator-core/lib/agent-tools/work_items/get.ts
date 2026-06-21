/**
 * work_items:get — resolve one OR many work-items by id across kinds
 * (unify-work-items; bulk-standardized per bulk-endpoint-standardization-2026-06-21).
 * Searches both kind-tables (ids are disjoint across families). Returns the
 * unified work-item shape incl. kind, lifecycle state, assignee, parent.
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids`
 * for several; the result is `{ ok, results:[{ ok, id, workItem?, error? }], counts }`
 * — each result self-describes its id, so a not-found item never poisons the rest
 * and the agent correlates by id (not array position).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, getWorkItemDetail } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'work_items:get',
  profile: 'engineer',
  description:
    'Fetch one OR many work-items by id (WI-/F-/EI-…) across every kind in ONE call — pass `id` for one or `ids` for several (1–100). Pass `harness` to disambiguate a feature id that may repeat across harnesses. Returns { ok, results:[{ ok, id, workItem?, error? }], counts } — correlate each result by its id, not by position; a missing id comes back as that item\'s { ok:false } without failing the rest.',
  guidance: {
    when: 'You have one or more work-item ids and need their full state (kind, lifecycle, assignee, parent). Pass every id you need at once via `ids` instead of calling per id.',
    notWhen: 'Browsing or filtering the queue → work_items:list / work_items:search (they already return many rows).',
    chaining: 'work_items:list → work_items:get { ids:[…] } for detail on the ones you care about.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to fetch (1–100)'),
      harness: z.string().max(80).optional(),
      detail: z.boolean().optional().describe('also return topics, thread posts (comments), and outgoing links'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const workItem = args.detail
          ? await getWorkItemDetail(id, args.harness)
          : await getWorkItem(id, args.harness);
        return workItem
          ? { ok: true as const, id, workItem }
          : { ok: false as const, id, error: `work_item '${id}' not found` };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
