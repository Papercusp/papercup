/**
 * work_items:link — Linkable (D-003). Creates a coord_links edge from this
 * work-item to a target. Blocking is the uniform `rel='blocks'` edge and works
 * ACROSS kinds (a bug can block a feature) — the substrate keys on (kind, ref),
 * not the physical table. Target is another work-item (by id) or an explicit
 * coord ObjectRef (e.g. a plan_item: { target_kind:'plan_item', target_ref:'<plan>#<item>' }).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): create ONE edge inline
 * or MANY (items:[{ id, rel, target_id|target_kind+target_ref, remove? }]) — a natural
 * fan-out (one source → many targets) → { ok, results:[{ ok, id, rel, dst? | error }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { linkWorkItem, unlinkWorkItem, resolveWorkItemRef } from '../../work-items';
import { guardFeatureBlockEdgeAcyclic } from '../../dbos/feature-blockers-edges';
import type { ObjectRef } from '@papercusp/coordination/capabilities';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1).describe('the source work-item id'),
  rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']),
  target_id: z.string().max(120).optional().describe('a target work-item id (resolved to its coord ref)'),
  target_harness: z.string().max(80).optional().describe('harness for a feature target_id (disambiguation)'),
  target_kind: z.string().max(40).optional().describe('explicit coord ObjectRef kind (e.g. plan_item) — use with target_ref'),
  target_ref: z.string().max(160).optional().describe('explicit coord ObjectRef ref — use with target_kind'),
  harness: z.string().max(80).optional().describe('harness for the source id (feature disambiguation)'),
  remove: z.boolean().optional(),
});

export default defineTool({
  name: 'work_items:link',
  profile: 'engineer',
  description:
    "Link one OR many work-items to targets (rel: blocks | relates | duplicates | fixes) — single inline { id, rel, target_id } or items:[{ id, rel, target_id | target_kind+target_ref, remove? }] (a source can fan out to many targets in one call). Blocking works across kinds. Pass remove:true to unlink. Returns { ok, results:[{ ok, id, rel, dst? | error }], counts }.",
  guidance: {
    when: 'You discovered one or more dependencies/relationships: a work-item blocks/relates-to/duplicates/fixes other work-items or plan items. Create several edges at once via items:[…].',
    chaining: 'work_items:get both sides → work_items:link { rel:"blocks", target_id } (or items:[…]).',
    seeAlso: [
      'work_items:get (inspect both endpoints before linking)',
      'work_items:subscribe (follow an item a dependency now points at)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the source work-item id'),
      rel: z.enum(['blocks', 'relates', 'duplicates', 'fixes']).optional().describe('single shorthand: the relationship'),
      target_id: z.string().max(120).optional(),
      target_harness: z.string().max(80).optional(),
      target_kind: z.string().max(40).optional(),
      target_ref: z.string().max(160).optional(),
      harness: z.string().max(80).optional().describe('default harness for the source id / items that omit one'),
      remove: z.boolean().optional(),
      items: z.array(itemSpec).min(1).max(100).optional().describe('create many edges at once'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.rel)), {
      message: 'pass { id, rel, target… } for one, or items:[…] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [{
          id: args.id as string,
          rel: args.rel as 'blocks' | 'relates' | 'duplicates' | 'fixes',
          target_id: args.target_id,
          target_harness: args.target_harness,
          target_kind: args.target_kind,
          target_ref: args.target_ref,
          harness: args.harness,
          remove: args.remove,
        }];
    const env = await runBulk(
      items,
      async (it) => {
        let dst: ObjectRef | null = null;
        if (it.target_id) {
          dst = await resolveWorkItemRef(it.target_id, it.target_harness);
          if (!dst) return { ok: false as const, id: it.id, rel: it.rel, error: `target work_item '${it.target_id}' not found` };
        } else if (it.target_kind && it.target_ref) {
          dst = { kind: it.target_kind, ref: it.target_ref };
        } else {
          return { ok: false as const, id: it.id, rel: it.rel, error: 'pass target_id, or target_kind + target_ref' };
        }
        const harness = it.harness ?? args.harness;
        // Acyclicity (P-003, F4): a feature→feature `blocks` edge that closes a cycle silently
        // deadlocks the scheduler frontier. The link tools write a raw coord_links edge (bypassing
        // syncFeatureBlockEdges' replace-semantics guard), so reject the cycle-closing edge here.
        // The coord_links convention is src=blocker → dst=blocked, so the SOURCE work-item is the
        // blocker and `dst` is the blocked feature.
        if (!it.remove && it.rel === 'blocks') {
          const srcRef = await resolveWorkItemRef(it.id, harness);
          if (srcRef) {
            const cycleErr = await guardFeatureBlockEdgeAcyclic(srcRef.ref, dst.ref);
            if (cycleErr) return { ok: false as const, id: it.id, rel: it.rel, error: cycleErr };
          }
        }
        const res = it.remove
          ? await unlinkWorkItem(it.id, dst, it.rel, { harness })
          : await linkWorkItem(it.id, dst, it.rel, { harness, by: ident.ownerId });
        return 'error' in res ? { ok: false as const, id: it.id, rel: it.rel, error: res.error } : { ok: true as const, id: it.id, rel: it.rel, dst };
      },
      { keyOf: (it) => ({ id: it.id, rel: it.rel }) },
    );
    return bulkContent(env);
  },
});
