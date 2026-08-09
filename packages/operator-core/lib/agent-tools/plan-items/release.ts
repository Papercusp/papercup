/**
 * plan_items:release — drop the live claim on a plan item (keeps the assignment).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ plan, item, claim_id? }), MANY in the SAME plan ({ plan, itemIds:[…] }), or
 * MANY heterogeneous (items:[{ plan, item, harness?, claim_id? }]) → { ok,
 * results:[{ ok, plan, item, released? | note }], counts }. Each result
 * self-describes its { plan, item }; holding no claim on one item is a polite
 * ok:false note that never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { getClaim, releaseClaim } from '../../plan-items/claims';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import {
  buildDispatchHandle,
  type DispatchCandidate,
  type DispatchHandleResult,
} from '../coordination/dispatch-handle';

interface ReleaseSpecItem {
  plan: string;
  item: string;
  harness?: string;
  claim_id?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the item)'),
});

export default defineTool({
  name: 'plan_items:release',
  description:
    'Drop your live claim on one OR many plan items so each returns to your assignee status (if assigned) or the pool (if pulled). Does NOT clear the assignment — the item stays yours by name; you just stop holding it. claim_id is optional (resolved from your current claim). Single: { plan, item, claim_id? }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, harness?, claim_id? }]. Returns { ok, results:[{ ok, plan, item, released? | note }], counts } — correlate by { plan, item }; holding no claim on one item never fails the rest.',
  guidance: {
    when: 'You finished (or are pausing) work on item(s) you claimed and want to free the live grip. Release several at once via itemIds:[…] or items:[…].',
    notWhen: 'You want to give up the item entirely — also plan_items:unassign it.',
    chaining: 'plan_items:claim → … → plan_items:release { harness, plan, item }.',
    seeAlso: [
      'plan_items:claim (claim another item next)',
      'plan_items:status (see what is left)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-release shorthand: the plan-item id (P-NNN)'),
      claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the inline item)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('release MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many plan items at once — each { plan, item, harness?, claim_id? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const list: ReleaseSpecItem[] = args.items?.length
      ? args.items.map((it) => ({ plan: it.plan, item: it.item, harness: it.harness ?? args.harness, claim_id: it.claim_id }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({ plan: args.plan as string, item, harness: args.harness }))
        : [{ plan: args.plan as string, item: args.item as string, harness: args.harness, claim_id: args.claim_id }];
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        let claimId = it.claim_id;
        if (!claimId) {
          const current = await getClaim(workspaceId, harnessSlug, it.plan, it.item);
          if (!current || current.owner !== id.ownerId) {
            return { ok: false, plan: it.plan, item: it.item, released: false, note: 'you hold no claim on this item' };
          }
          claimId = current.claimId;
        }
        const released = await releaseClaim(workspaceId, harnessSlug, it.plan, it.item, claimId, id.ownerId);
        return { ok: true, plan: it.plan, item: it.item, released };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );

    // ── P-012 (coordination-spec-adoption-2026-08-03): the second dispatch
    // handle site. Releasing a plan lane is the exact moment a peer could take
    // it, and this surface natively speaks dispatch's shape — (plan, P-NNN).
    //
    // NB the plan item named work_items:release for this. That is the WRONG
    // surface and would have shipped a broken handle: coord:dispatch's `items`
    // are PLAN items, work_items:release releases WORK items, and the two are
    // linked only through a plan_item_stamp relation — so a handle there needs a
    // per-row join on a bulk write path, or it ships a target with no items,
    // which is precisely the "bare wake that reads as a hand-off" shape
    // dispatch-handle.ts exists to refuse. plan_items:release is the sibling
    // that already holds the lane.
    //
    // Fail-soft BY CONTRACT: this is an affordance on a WRITE that has already
    // committed. A presence hiccup must degrade to no handle, never to a failed
    // release.
    const releasedLane = env.results.filter(
      (r): r is BulkItemResult & { plan: string; item: string } =>
        Boolean((r as { ok?: boolean }).ok) && Boolean((r as { released?: boolean }).released),
    );
    let dispatch: DispatchHandleResult = null;
    if (releasedLane.length > 0) {
      try {
        // Dynamic import: presence-snapshot pulls the whole wakeability layer, and
        // a static import here would drag it into every plan-items caller
        // (EI-19281789650149592 is the same trap in coupling-divergence-stamp).
        const { resolvePresenceScope, assemblePresenceSnapshot } = await import(
          '../coordination/presence-snapshot'
        );
        const scope = await resolvePresenceScope(
          ctx as { workspaceId?: string | null; harnessSlug?: string | null } | undefined,
        );
        const snap = await assemblePresenceSnapshot(scope);
        const peers = (snap.active ?? []) as unknown as DispatchCandidate[];
        dispatch = buildDispatchHandle(
          {
            planSlug: releasedLane[0].plan,
            items: releasedLane.map((r) => r.item),
            harness: args.harness ?? null,
            note: `Releasing ${releasedLane[0].plan} ${releasedLane.map((r) => r.item).join(', ')} — the lane is free and the item bodies are inlined below. Claim and continue.`,
          },
          peers ?? [],
          { selfOwnerId: id.ownerId },
        );
      } catch {
        dispatch = null;
      }
    }

    const out = bulkContent(env);
    return dispatch ? { ...out, data: { ...(out as { data?: object }).data, dispatch } } : out;
  },
});
