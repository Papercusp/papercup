/**
 * plan_items:claim — take the live, leased grip on a plan item (Phase 1/2).
 *
 * Enforces the policy: an ASSIGNED item may only be claimed by its assignee-NAME
 * (so adopt that name first); an UNASSIGNED item is a pool pull (gated by work-group
 * membership when the plan has a work-group). The lease's liveness mode is resolved
 * from the harness (LOCAL=availability / SHARED=activity) unless forced.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ plan, item, … }), MANY in the SAME plan ({ plan, itemIds:[…] }), or MANY
 * heterogeneous (items:[{ plan, item, intent?, mode?, ttl_sec?, harness? }]) →
 * { ok, results:[{ ok, plan, item, result, convertStatus?, workItem? }], counts }.
 * Each result self-describes its { plan, item } and carries that item's claim
 * envelope; a refused/conflicted claim is that item's ok:false WITHOUT failing the
 * rest (top-level ok = "the batch ran", counts.failed is the truth). The per-item
 * `result` is the SAME claim/convert payload the single call always returned.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { claimPlanItem } from '../../plan-items/liveness';
import { convertPlanItem } from '../../plan-items/convert';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import type { LivenessMode } from '../../plan-items/claims';

interface ClaimSpecItem {
  plan: string;
  item: string;
  harness?: string;
  intent?: string;
  mode?: LivenessMode;
  ttl_sec?: number;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  intent: z.string().max(400).optional().describe('one line on what you are doing'),
  mode: z.enum(['availability', 'activity']).optional().describe('force the liveness mode'),
  ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds'),
});

export default defineTool({
  name: 'plan_items:claim',
  description:
    'Take the live, heartbeat-leased grip on one OR many plan items — what you call when you actually START them. Refused per item if it is assigned to a different agent-name, or unassigned in a plan whose work-group you have not joined. Single: { plan, item }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, intent?, mode?, ttl_sec?, harness? }]. Returns { ok, results:[{ ok, plan, item, result (claim with claim_id + lease expiry), convertStatus?, workItem? }], counts } — correlate by { plan, item }; a refused/conflicted claim is that item\'s ok:false without failing the rest. Keep a claim alive with plan_items:heartbeat, drop it with plan_items:release.',
  guidance: {
    when: 'You are about to begin work on item(s) (yours via assignment, or pulled from the pool). Claim several at once via itemIds:[…] or items:[…].',
    notWhen: 'You only want to mark intent for later without starting — that is assignment, not a claim. Renewing an existing claim — that is plan_items:heartbeat.',
    chaining: 'plan_items:claim { harness, plan, item } → work → plan_items:heartbeat (per turn) → plan_items:release when done.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-claim shorthand: the plan-item id (P-NNN)'),
      intent: z.string().max(400).optional().describe('one line on what you are doing (the inline item / every id in `itemIds`)'),
      mode: z.enum(['availability', 'activity']).optional().describe('force the liveness mode (default: resolved from the harness — LOCAL=availability, SHARED=activity); the inline item / itemIds'),
      ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds (default 1200 availability / 1800 activity); the inline item / itemIds'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('claim MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('claim many plan items at once — each { plan, item, intent?, mode?, ttl_sec?, harness? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const ownerUser = bestEffortOwnerUser(ctx);
    // work-queue-completeness Phase A (ENFORCEMENT): when the auto-convert flag is ON,
    // a claim is no longer a bare lease — it mints (or idempotently resumes) a tracked
    // work_item via convertPlanItem (policy-checked lease → resume-or-mint → claim →
    // back-link). Because convertPlanItem re-runs claimPlanItem and is idempotent, this
    // is safe in the same spot a bare claim happened. Fail-safe to OFF on a flag-IO error
    // (today's bare-claim behavior). Read ONCE for the whole batch (SYNC at the tool
    // layer, like convert.ts does for COMPILED_BRIEFS — keeps the core flag-mock-free).
    const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);

    const list: ClaimSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          harness: it.harness ?? args.harness,
          intent: it.intent ?? args.intent,
          mode: it.mode ?? args.mode,
          ttl_sec: it.ttl_sec ?? args.ttl_sec,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({ plan: args.plan as string, item, harness: args.harness, intent: args.intent, mode: args.mode, ttl_sec: args.ttl_sec }))
        : [{ plan: args.plan as string, item: args.item as string, harness: args.harness, intent: args.intent, mode: args.mode, ttl_sec: args.ttl_sec }];

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        const ownerName = await resolveAdoptedName(workspaceId, id.ownerId);

        if (autoConvert) {
          const conv = await convertPlanItem({
            workspaceId,
            harnessSlug,
            planSlug: it.plan,
            itemId: it.item,
            owner: id.ownerId,
            ownerLabel: id.ownerLabel,
            ownerName,
            ownerUser,
            intent: it.intent,
            livenessMode: it.mode,
            ttlSec: it.ttl_sec,
          });
          // Re-shape into the same { ok, result } envelope today's callers read, plus the
          // minted/resumed workItem. A refused/conflict convert maps back to the same
          // claim-shaped failure the bare path returns (its embedded `claim` payload).
          if (conv.status === 'converted' || conv.status === 'resumed') {
            return {
              ok: true,
              plan: it.plan,
              item: it.item,
              result: { status: 'claimed', claim: conv.claim, mode: conv.mode, viaAssignment: conv.viaAssignment },
              convertStatus: conv.status,
              workItem: { id: conv.workItem.id, kind: conv.workItem.kind, harness: conv.workItem.harness ?? null },
            };
          }
          return { ok: false, plan: it.plan, item: it.item, result: conv };
        }

        const result = await claimPlanItem({
          workspaceId,
          harnessSlug,
          planSlug: it.plan,
          itemId: it.item,
          owner: id.ownerId,
          ownerLabel: id.ownerLabel,
          ownerName,
          ownerUser,
          intent: it.intent,
          livenessMode: it.mode,
          ttlSec: it.ttl_sec,
        });
        return { ok: result.status === 'claimed', plan: it.plan, item: it.item, result };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
