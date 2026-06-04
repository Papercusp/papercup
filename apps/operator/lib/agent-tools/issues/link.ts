/**
 * issues:link — create a polymorphic edge from an issue to another object
 * (Linkable, engineer-issues-2026-06-03). The 'blocks' rel onto a plan_item or
 * feature is projected into plan reads (Phase 2) so an open blocking issue makes
 * that item non-actionable.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, linkIssue, unlinkIssue } from '@/lib/issues-engineer';

export default defineTool({
  name: 'issues:link',
  description: "Link an issue to another object — e.g. this issue blocks a plan item or a feature. rel = blocks | relates | duplicates | fixes. target = a {kind, ref} like {plan_item, '<plan-slug>#P-003'} or {feature, F-012}. Pass unlink:true to remove.",
  guidance: {
    when: 'An issue blocks specific work (a plan item / feature) — link it so that work is shown blocked until the issue closes; or relate/dedup two issues.',
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
    const dst = { kind: args.targetKind, ref: args.targetRef };
    const rel = args.rel ?? 'blocks';
    if (args.unlink) await unlinkIssue(args.id, dst, rel);
    else await linkIssue(args.id, dst, rel, id.ownerId);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, rel, target: dst, linked: !args.unlink }) }] };
  },
});
