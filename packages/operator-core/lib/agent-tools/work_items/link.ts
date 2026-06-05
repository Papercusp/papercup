/**
 * work_items:link — Linkable (D-003). Creates a coord_links edge from this
 * work-item to a target. Blocking is the uniform `rel='blocks'` edge and works
 * ACROSS kinds (a bug can block a feature) — the substrate keys on (kind, ref),
 * not the physical table. Target is another work-item (by id) or an explicit
 * coord ObjectRef (e.g. a plan_item: { target_kind:'plan_item', target_ref:'<plan>#<item>' }).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { linkWorkItem, unlinkWorkItem, resolveWorkItemRef } from '../../work-items';
import type { ObjectRef } from '@papercusp/coordination/capabilities';

export default defineTool({
  name: 'work_items:link',
  profile: 'engineer',
  description: "Link this work-item to a target (rel: blocks | relates | duplicates | fixes). Blocking works across kinds. Target = another work-item (target_id) or an explicit coord ref (target_kind + target_ref, e.g. a plan_item). Pass remove:true to unlink.",
  guidance: {
    when: 'You discovered a dependency/relationship: this work-item blocks/relates-to/duplicates/fixes another work-item or plan item.',
    chaining: 'work_items:get both sides → work_items:link { rel:"blocks", target_id }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the source work-item id'),
    rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']),
    target_id: z.string().max(120).optional().describe('a target work-item id (resolved to its coord ref)'),
    target_harness: z.string().max(80).optional().describe('harness for a feature target_id (disambiguation)'),
    target_kind: z.string().max(40).optional().describe('explicit coord ObjectRef kind (e.g. plan_item) — use with target_ref'),
    target_ref: z.string().max(160).optional().describe('explicit coord ObjectRef ref — use with target_kind'),
    harness: z.string().max(80).optional().describe('harness for the source id (feature disambiguation)'),
    remove: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    let dst: ObjectRef | null = null;
    if (args.target_id) {
      dst = await resolveWorkItemRef(args.target_id, args.target_harness);
      if (!dst) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `target work_item '${args.target_id}' not found` }) }] };
    } else if (args.target_kind && args.target_ref) {
      dst = { kind: args.target_kind, ref: args.target_ref };
    } else {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'pass target_id, or target_kind + target_ref' }) }] };
    }
    const res = args.remove
      ? await unlinkWorkItem(args.id, dst, args.rel, { harness: args.harness })
      : await linkWorkItem(args.id, dst, args.rel, { harness: args.harness, by: ident.ownerId });
    return { content: [{ type: 'text' as const, text: JSON.stringify('error' in res ? { ok: false, error: res.error } : { ok: true, rel: args.rel, dst }) }] };
  },
});
