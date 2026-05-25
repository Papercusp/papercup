/**
 * plans:list — summary of all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns one row per plan: slug, title, status, updated, item counts
 * by effectiveStatus, the `## Now` next-action line.
 *
 * Hides archive/ by default. Legacy plans (no/malformed frontmatter)
 * surface with status: 'unknown' and no item counts.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listPlanFiles, readPlanBySlug } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolveEffectiveStatus } from './effective-status';
import { ITEM_STATUSES, PLAN_STATUSES } from './parser';

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
  status: z
    .enum([...PLAN_STATUSES, 'unknown'] as [string, ...string[]])
    .optional()
    .describe('Filter by plan-level status. "unknown" returns legacy plans only.'),
  includeArchived: z
    .boolean()
    .optional()
    .describe('Include plans under docs/plans/archive/. Default false.'),
  includeLegacy: z
    .boolean()
    .optional()
    .describe('Include plans without valid frontmatter. Default true.'),
});

type ListRow = {
  slug: string;
  title: string | null;
  status: string;
  updated: string | null;
  owner: string | null;
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Partial<Record<(typeof ITEM_STATUSES)[number] | 'unknown', number>> | null;
  nextAction: string | null;
  /**
   * Resolved harness slug per
   * `plans-newbutton-and-subharness-scope-2026-05-25` P-022 / D-009.
   * Populated from `resolveHarnessPlansDir`'s output so callers don't
   * re-walk the registry. Always present (the resolver always picks
   * SOME harness, falling back to the workspace primary).
   */
  harness: string;
};

export default defineTool({
  name: 'plans:list',
  description:
    'List SU plans under apps/operator/docs/plans/. One row per plan with title, status, item counts by effectiveStatus, and the ## Now next-action line. Legacy plans (no frontmatter) surface as status="unknown".',
  guidance: {
    when: 'You need a directory of plans — "what plans exist", "what plans are active", or the entry point before plans:get.',
    notWhen:
      'You already know the plan slug and want full contents — call plans:get directly.',
    chaining:
      'plans:list → plans:get { slug } (full plan) or plans:items { actionable: true } (pickable items across plans).',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const includeArchived = args.includeArchived === true;
    const includeLegacy = args.includeLegacy !== false;

    const opts = await ctxToPlanSourceOpts(ctx);
    const entries = await listPlanFiles(opts);
    const filtered = includeArchived ? entries : entries.filter((e) => !e.archived);

    const rows: ListRow[] = [];
    for (const entry of filtered) {
      const result = await readPlanBySlug(entry.slug, opts);
      if (!result) continue;
      const { parsed, archived } = result;

      if (parsed.isLegacy && !includeLegacy) continue;

      let itemCounts: ListRow['itemCounts'] = null;
      if (!parsed.isLegacy) {
        const { items } = resolveEffectiveStatus(parsed);
        const counts: Record<string, number> = {};
        for (const it of items) {
          counts[it.effectiveStatus] = (counts[it.effectiveStatus] ?? 0) + 1;
        }
        itemCounts = counts;
      }

      const status = parsed.frontmatter.status ?? (parsed.isLegacy ? 'unknown' : 'draft');

      if (args.status && status !== args.status) continue;

      rows.push({
        slug: parsed.frontmatter.slug ?? parsed.slug,
        title: parsed.frontmatter.title ?? null,
        status,
        updated: parsed.frontmatter.updated ?? null,
        owner: parsed.frontmatter.owner ?? null,
        archived,
        isLegacy: parsed.isLegacy,
        itemCounts,
        nextAction: parsed.now?.next ?? null,
        harness: opts.harnessSlug,
      });
    }

    ctxAny.metadata?.({ count: rows.length, includeArchived, includeLegacy });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ plans: rows }) }],
    };
  },
});
