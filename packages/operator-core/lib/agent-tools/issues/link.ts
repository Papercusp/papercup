/**
 * issues:link — create a polymorphic edge from an issue to another object
 * (Linkable, engineer-issues-2026-06-03, D-006). 'blocks' is the UNIFORM blocking
 * edge for BOTH plan_item and feature targets (coord_links rel='blocks' — NOT
 * features.blocked_by, which is a separate feature→feature dep). The plan-side
 * (getBlockingIssuesForPlan) + feature-side (getBlockedFeatures) projections make
 * an open blocking issue render the target non-actionable: plan items flip to
 * effectiveStatus='blocked' in plans:get/list/items, and features carry a
 * blockedByIssues annotation in harness:list_features. A FEATURE target ref must be
 * harness-qualified ('<harness>#<feature_id>') — a feature's identity is (harness, id),
 * so a bare 'F-NNN' would mis-attribute a block to the same id in another project.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, linkIssue, unlinkIssue } from '../../issues-engineer';
import { isQualifiedFeatureRef } from '../../issue-blocks-merge';

export default defineTool({
  name: 'issues:link',
  profile: 'engineer',
  description: "Link an issue to another object — e.g. this issue blocks a plan item or a feature. rel = blocks | relates | duplicates | fixes. target = a {kind, ref} like {plan_item, '<plan-slug>#P-003'} or {feature, '<harness>#F-012'} (a feature ref MUST be harness-qualified — bare 'F-012' is rejected). Pass unlink:true to remove.",
  guidance: {
    when: 'An issue blocks specific work (a plan item / feature) — link it so that work is shown blocked until the issue closes; or relate/dedup two issues. A feature ref is harness-qualified: "<harness>#<feature_id>" (e.g. "papercup#F-12").',
    notWhen: 'Tagging it to a topic area — issues:tag.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    targetKind: z.enum(['plan_item', 'feature', 'plan', 'issue']),
    targetRef: z.string().min(1),
    rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']).optional(),
    unlink: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await getIssue(args.id);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    // A feature block-ref must be harness-qualified ('<harness>#<feature_id>') so it's
    // unique across projects — else getBlockedFeatures keys on a bare id that no reader
    // (which looks up featureRef(harness, id)) ever matches → a silent no-op.
    if (args.targetKind === 'feature' && !isQualifiedFeatureRef(args.targetRef)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `feature ref must be harness-qualified '<harness>#<feature_id>' (got '${args.targetRef}')` }) }],
        isError: true,
      };
    }
    const dst = { kind: args.targetKind, ref: args.targetRef };
    const rel = args.rel ?? 'blocks';
    if (args.unlink) await unlinkIssue(args.id, dst, rel);
    else await linkIssue(args.id, dst, rel, id.ownerId);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, rel, target: dst, linked: !args.unlink }) }] };
  },
});
