/**
 * issues:get — one OR many issues in full: fields + topics + comment thread +
 * outgoing links (engineer-issues-2026-06-03, Phase 1; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids`
 * for several; the result is `{ ok, results:[{ ok, id, issue?, error? }], counts }`
 * — each result self-describes its id, so a not-found item never poisons the rest
 * and the agent correlates by id (not array position).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssueDetail } from '../../issues-engineer';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'issues:get',
  profile: 'engineer',
  description:
    'Read one OR many engineer issues in full — fields, topic tags, the comment thread, and its links — in ONE call. Pass `id` for one or `ids` for several (1–100). Returns { ok, results:[{ ok, id, issue?, error? }], counts } — correlate each result by its id, not by position; a missing id comes back as that item\'s { ok:false } without failing the rest.',
  guidance: {
    when: 'You have one or more issue ids (from issues:list/search) and want their detail before claiming, commenting, or fixing. Pass every id you need at once via `ids` instead of calling per id.',
    notWhen: 'Scanning many — use issues:list.',
    chaining: 'issues:list → issues:get { ids:[…] } → issues:claim / issues:comment / issues:close.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single issue id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('issue ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const issue = await getIssueDetail(id);
        return issue
          ? { ok: true as const, id, issue }
          : { ok: false as const, id, error: 'issue not found' };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
