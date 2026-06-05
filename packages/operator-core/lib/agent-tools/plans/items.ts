/**
 * plans:items — item-level query across one or all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 *   actionable: true   → effectiveStatus === 'todo'
 *                        (stored todo with all blockers done)
 *   needsHuman: true   → storedStatus === 'needs-human'
 *                        (the human's inbox, §4.3)
 *   status: <token>    → filter by effectiveStatus (NOT storedStatus,
 *                        because the whole point of effectiveStatus
 *                        is it's the one callers should ask about)
 *
 * Legacy plans are excluded — they don't have parseable items.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listPlanRows, getPlanRow, type PlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatusForItems, type ResolvedItem } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';
import {
  ITEM_STATUSES,
  IMPORTANCE_LEVELS,
  parsePlan,
  type PlanItem,
  type ItemStatus,
  type Importance,
} from './parser';

/**
 * Resolve a plan row's items from the PG-canonical structured `items` index
 * (plans-pg-canonical-migration Stage 3) — no content-blob parse. Falls back to
 * parsing `content` only when the structured index is empty/absent (a federated
 * remote row whose projection didn't fill the derived columns, or a genuinely
 * itemless plan — the parse is cheap either way).
 */
function planItemsForRow(row: PlanRow): PlanItem[] {
  if (row.items.length > 0) {
    return row.items.map((i) => ({
      id: i.id,
      text: i.text,
      storedStatus: i.status as ItemStatus,
      importance: i.importance as Importance,
      blockedBy: i.blockedBy,
      decisionRefs: i.decisionRefs,
      phase: i.phase,
      lineNumber: 0,
      rawLine: '',
    }));
  }
  return parsePlan(row.content).items;
}

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict to one plan. Omit for cross-plan.'),
  status: z
    .enum([...ITEM_STATUSES] as [string, ...string[]])
    .optional()
    .describe('Filter by effectiveStatus.'),
  actionable: z
    .boolean()
    .optional()
    .describe('Return items pickable right now: effectiveStatus === "todo".'),
  needsHuman: z
    .boolean()
    .optional()
    .describe('Return items requiring a human decision (the human\'s inbox).'),
  includeArchived: z
    .boolean()
    .optional()
    .describe('Include items from plans under archive/. Default false.'),
  harness: harnessArg,
});

interface ItemRow {
  plan: string;
  archived: boolean;
  item: ResolvedItem;
  /** Open engineer-issue ids blocking this item (coord_links rel='blocks'), if any. */
  blockedByIssues?: string[];
}

export default defineTool({
  name: 'plans:items',
  description:
    'Cross-plan item query. actionable=true returns pickable items (effectiveStatus="todo"). needsHuman=true returns the human\'s inbox. status filters by effectiveStatus. Legacy plans excluded.',
  guidance: {
    when: 'You want to find items by status across all plans — "what can I pick up", "what needs the human", or filter one plan\'s items.',
    notWhen:
      'You want the full plan structure (Now block, decisions, prose) — use plans:get.',
    chaining:
      'plans:items { actionable: true } → plans:get { slug } for context on the picked item.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const includeArchived = args.includeArchived === true;

    // PG-canonical: read the structured rows (no content-blob parse for plans that
    // carry the derived `items` index — Stage 3); planItemsForRow falls back to a
    // parse only when the index is absent.
    let planRows: PlanRow[] = [];

    if (args.slug) {
      const one = await getPlanRow(args.slug, opts);
      if (!one) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
          isError: true,
        };
      }
      if (!one.archived || includeArchived) {
        planRows = [one];
      }
    } else {
      planRows = await listPlanRows({ includeArchived, ...opts });
    }

    const rows: ItemRow[] = [];

    // engineer-issues D-005: one batch read of every open issue-block across all
    // plans (keyed '<slug>#<item>'), hoisted out of the plan loop. Overlaying it
    // onto effectiveStatus BEFORE the filters below means an item blocked by an
    // open issue correctly drops out of `actionable` (no longer `todo`) and is
    // found by `status:'blocked'`. Non-fatal — degrades to resolver-only on error.
    let allBlocked = new Map<string, string[]>();
    try {
      allBlocked = await getAllBlockedPlanItems();
    } catch {
      // Non-fatal — no issue-block overlay.
    }

    for (const row of planRows) {
      if (row.isLegacy) continue;
      const { items: resolvedItems, blockingIssues } = applyPlanItemBlocks(
        resolveEffectiveStatusForItems(planItemsForRow(row)).items,
        (id) => allBlocked.get(planItemRef(row.planSlug, id)),
      );
      for (const item of resolvedItems) {
        if (args.actionable && item.effectiveStatus !== 'todo') continue;
        if (args.needsHuman && item.storedStatus !== 'needs-human') continue;
        if (args.status && item.effectiveStatus !== args.status) continue;
        rows.push({
          plan: row.planSlug,
          archived: row.archived,
          item,
          ...(blockingIssues[item.id] ? { blockedByIssues: blockingIssues[item.id] } : {}),
        });
      }
    }

    // Sort by importance (urgent→low); the array index in IMPORTANCE_LEVELS
    // is the rank. Array.sort is stable, so equal-importance rows keep their
    // collection order (≈ age within a plan) — the "then age" tiebreaker.
    const normalRank = IMPORTANCE_LEVELS.indexOf('normal');
    const impRank = (it: ResolvedItem): number => {
      const r = IMPORTANCE_LEVELS.indexOf(it.importance);
      return r === -1 ? normalRank : r;
    };
    rows.sort((a, b) => impRank(a.item) - impRank(b.item));

    ctxAny.metadata?.({
      count: rows.length,
      actionable: !!args.actionable,
      needsHuman: !!args.needsHuman,
      scope: args.slug ?? 'all',
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ items: rows }) }],
    };
  },
});
