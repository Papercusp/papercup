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
import { readAllPlans, readPlanBySlug } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolveEffectiveStatus, type ResolvedItem } from './effective-status';
import { ITEM_STATUSES } from './parser';

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
});

interface ItemRow {
  plan: string;
  archived: boolean;
  item: ResolvedItem;
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
  roles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const opts = await ctxToPlanSourceOpts(ctx);
    const includeArchived = args.includeArchived === true;

    let parsedPlans: Array<{ parsed: import('./parser').ParsedPlan; archived: boolean }> = [];

    if (args.slug) {
      const one = await readPlanBySlug(args.slug, opts);
      if (!one) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
          isError: true,
        };
      }
      if (!one.archived || includeArchived) {
        parsedPlans = [one];
      }
    } else {
      parsedPlans = await readAllPlans({ includeArchived, ...opts });
    }

    const rows: ItemRow[] = [];

    for (const { parsed, archived } of parsedPlans) {
      if (parsed.isLegacy) continue;
      const resolved = resolveEffectiveStatus(parsed);
      for (const item of resolved.items) {
        if (args.actionable && item.effectiveStatus !== 'todo') continue;
        if (args.needsHuman && item.storedStatus !== 'needs-human') continue;
        if (args.status && item.effectiveStatus !== args.status) continue;
        rows.push({
          plan: parsed.frontmatter.slug ?? parsed.slug,
          archived,
          item,
        });
      }
    }

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
