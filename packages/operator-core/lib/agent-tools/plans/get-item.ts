/**
 * plans:get-item — read ONE plan item (P-NNN) with its resolved effectiveStatus,
 * WITHOUT loading + parsing the whole plan (plan-templates-and-rubric-v2 P-003).
 *
 * The interface audit found no single-item read: to inspect one P-NNN you had to
 * plans:get the whole plan (+ scan it) or plans:items (cross/whole-plan). This
 * returns just the one item from the PG-canonical structured index (planItemsForRow
 * — a markdown parse only if the derived index is absent), with effectiveStatus +
 * the open-issue block overlay — exactly the resolution plans:items does, scoped to
 * a single id. Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow, planItemsForRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatusForItems } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  itemId: z
    .string()
    .regex(/^P-\d{3,}$/)
    .describe('The plan item id to read, e.g. "P-003".'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:get-item',
  description:
    'Read ONE plan item (P-NNN) — its text, storedStatus + resolved effectiveStatus, importance, phase, blockedBy, and any blocking engineer-issues — from the PG-canonical structured index, WITHOUT loading + parsing the whole plan. The single-item read the surface lacked (vs plans:get the whole doc, or plans:items cross-plan).',
  guidance: {
    when: 'Inspecting one specific P-NNN (its status / blockers / phase / importance) without pulling the whole plan. The targeted read between plans:items (many) and plans:get (the whole plan).',
    notWhen: 'You need the whole plan (Now / decisions / prose) — plans:get. Many items by status — plans:items.',
    chaining: 'plans:get-item { slug, itemId } → plans:set-status / plans:set-item-blocked-by / plans:set-item-phase to act on it.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  // overwatch reads plan items (read-only) to ground its nudges, like plans:items.
  agentRoles: [...SU_ROLES, 'overwatch'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const row = await getPlanRow(args.slug, opts);
    if (!row) return text({ error: 'not_found', slug: args.slug }, true);
    if (row.isLegacy) return text({ error: 'legacy_plan', slug: args.slug }, true);

    // Issue-block overlay (same as plans:items) so effectiveStatus reflects an open
    // blocking issue. Non-fatal — degrades to resolver-only on error.
    let allBlocked = new Map<string, string[]>();
    try {
      allBlocked = await getAllBlockedPlanItems();
    } catch {
      /* non-fatal — no issue-block overlay */
    }
    const { items, blockingIssues } = applyPlanItemBlocks(
      resolveEffectiveStatusForItems(planItemsForRow(row)).items,
      (id) => allBlocked.get(planItemRef(row.planSlug, id)),
    );

    const item = items.find((i) => i.id === args.itemId);
    if (!item) return text({ error: 'item_not_found', slug: args.slug, itemId: args.itemId }, true);

    return text({
      ok: true,
      plan: row.planSlug,
      archived: row.archived,
      item,
      ...(blockingIssues[item.id] ? { blockedByIssues: blockingIssues[item.id] } : {}),
    });
  },
});
