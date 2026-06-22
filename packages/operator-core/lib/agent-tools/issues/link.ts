/**
 * issues:link — create a polymorphic edge from one OR many issues to another object
 * (Linkable, engineer-issues-2026-06-03, D-006). 'blocks' is the UNIFORM blocking
 * edge for BOTH plan_item and feature targets (coord_links rel='blocks' — NOT
 * features.blocked_by, which is a separate feature→feature dep). The plan-side
 * (getBlockingIssuesForPlan) + feature-side (getBlockedFeatures) projections make
 * an open blocking issue render the target non-actionable: plan items flip to
 * effectiveStatus='blocked' in plans:get/list/items, and features carry a
 * blockedByIssues annotation in harness:list_features. A FEATURE target ref must be
 * harness-qualified ('<harness>#<feature_id>') — a feature's identity is (harness, id),
 * so a bare 'F-NNN' would mis-attribute a block to the same id in another project.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): link ONE inline
 * ({ id, targetKind, targetRef, rel?, unlink? }) or MANY heterogeneous
 * (items:[{ id, targetKind, targetRef, rel?, unlink? }]) → { ok, results:[{ ok, id,
 * rel?, target?, linked? | error }], counts }. (No homogeneous `ids` form — the
 * target fields are per-item.) Each result self-describes its id; one not-found /
 * unqualified-ref item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, linkIssue, unlinkIssue } from '../../issues-engineer';
import { isQualifiedFeatureRef } from '../../issue-blocks-merge';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  targetKind: z.enum(['plan_item', 'feature', 'plan', 'issue']),
  targetRef: z.string().min(1),
  rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']).optional(),
  unlink: z.boolean().optional(),
});

export default defineTool({
  name: 'issues:link',
  profile: 'engineer',
  description:
    "Link one OR many issues to another object — e.g. this issue blocks a plan item or a feature. rel = blocks | relates | duplicates | fixes. target = a {kind, ref} like {plan_item, '<plan-slug>#P-003'} or {feature, '<harness>#F-012'} (a feature ref MUST be harness-qualified — bare 'F-012' is rejected). Pass unlink:true to remove. Single: { id, targetKind, targetRef, rel?, unlink? }. Many heterogeneous: items:[{ id, targetKind, targetRef, rel?, unlink? }]. Returns { ok, results:[{ ok, id, rel?, target?, linked? | error }], counts } — correlate by id; one bad item never fails the rest.",
  guidance: {
    when: 'One or more issues block specific work (a plan item / feature) — link so that work is shown blocked until the issue closes; or relate/dedup issues. A feature ref is harness-qualified: "<harness>#<feature_id>" (e.g. "papercup#F-12"). Link several at once via items:[…].',
    notWhen: 'Tagging it to a topic area — issues:tag.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-link shorthand: the issue id (use with the target fields)'),
      targetKind: z.enum(['plan_item', 'feature', 'plan', 'issue']).optional(),
      targetRef: z.string().min(1).optional(),
      rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']).optional(),
      unlink: z.boolean().optional(),
      items: z.array(itemSpec).min(1).max(200).optional().describe('link many issues at once — each { id, targetKind, targetRef, rel?, unlink? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.targetKind) && Boolean(a.targetRef)), {
      message: 'pass { id, targetKind, targetRef } for one, or items:[{ id, targetKind, targetRef }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : [{ id: args.id as string, targetKind: args.targetKind!, targetRef: args.targetRef as string, rel: args.rel, unlink: args.unlink }];
    const env = await runBulk(
      list,
      async (it) => {
        const issue = await getIssue(it.id);
        if (!issue) return { ok: false as const, id: it.id, error: 'issue not found' };
        // A feature block-ref must be harness-qualified ('<harness>#<feature_id>') so it's
        // unique across projects — else getBlockedFeatures keys on a bare id that no reader
        // (which looks up featureRef(harness, id)) ever matches → a silent no-op.
        if (it.targetKind === 'feature' && !isQualifiedFeatureRef(it.targetRef)) {
          return { ok: false as const, id: it.id, error: `feature ref must be harness-qualified '<harness>#<feature_id>' (got '${it.targetRef}')` };
        }
        const dst = { kind: it.targetKind, ref: it.targetRef };
        const rel = it.rel ?? 'blocks';
        if (it.unlink) await unlinkIssue(it.id, dst, rel);
        else await linkIssue(it.id, dst, rel, ident.ownerId);
        return { ok: true as const, id: it.id, rel, target: dst, linked: !it.unlink };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
