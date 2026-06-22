/**
 * issues:promote — mint an F-FIX feature from one OR many issues so the harness
 * pipeline fixes them (engineer-issues-2026-06-03, Phase 4). Reuses the pipeline's
 * mintFixFeatureRow; records the linked feature on each issue.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): promote ONE inline
 * ({ id, harness? }), MANY into the SAME harness (ids:[…] + harness?), or MANY
 * heterogeneous (items:[{ id, harness? }]) → { ok, results:[{ ok, id, issue?,
 * feature? | error }], counts }. Each result self-describes its id; one failure
 * (already-promoted, unknown harness, …) never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { promoteIssue } from '../../issues-engineer';
import { runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'issues:promote',
  profile: 'engineer',
  description:
    'Promote one OR many issues into F-FIX features so the harness pipeline fixes them. A harness-scoped issue mints into its harness; an operator-scope issue needs a target harness. Single: { id, harness? }. Many same harness: { ids:[…], harness? }. Many heterogeneous: items:[{ id, harness? }]. Records the linked feature; the issue stays open until the fix lands. Returns { ok, results:[{ ok, id, issue?, feature? | error }], counts } — correlate by id; one failure never fails the rest.',
  guidance: {
    when: 'An issue is a real defect that should be FIXED by the pipeline (not just tracked or answered) — promote it to mint + link the fix feature. Promote several at once via ids:[…]+harness or items:[…].',
    notWhen: 'A question/discussion (resolve it), a nit you would not spend a feature on, or an issue already linked to a feature.',
    chaining: 'issues:get → issues:promote { harness } → the F-FIX feature dispatches in that harness; issues:close when it lands.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-promote shorthand: the issue id'),
      harness: z.string().optional().describe('target harness slug — required for operator-scope issues; applies to the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('promote MANY issues into the same `harness` (homogeneous)'),
      items: z
        .array(z.object({ id: z.string().min(1), harness: z.string().optional() }))
        .min(1)
        .max(200)
        .optional()
        .describe('promote many issues at once — each { id, harness? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ id: it.id, harness: it.harness ?? args.harness }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, harness: args.harness }))
        : [{ id: args.id as string, harness: args.harness }];
    const env = await runBulk(
      list,
      async (it) => {
        const res = await promoteIssue(it.id, { harness: it.harness, actor: ident.ownerId });
        return 'error' in res
          ? { ok: false as const, id: it.id, error: res.error }
          : { ok: true as const, id: it.id, issue: { id: res.issue.id, linkedFeatureId: res.issue.linkedFeatureId }, feature: res.feature };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
