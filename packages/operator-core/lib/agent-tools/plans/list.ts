/**
 * plans:list — summary of all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns one row per plan: slug, title, status, updated, item counts
 * by effectiveStatus, the `## Now` next-action line.
 *
 * Hides archive/ by default. Legacy plans (no/malformed frontmatter)
 * surface with status: 'draft' (the isLegacy flag marks them) and no
 * item counts.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readAllPlans, resolveHarnessPlansDir } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatus } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';
import { IMPORTANCE_LEVELS, ITEM_STATUSES, PLAN_STATUSES, type Importance } from './parser';
import { reconcileStartStatus } from './plan-start-state';

/** Cap for the multi-harness arg per P-021 — keeps IN-style fan-out bounded. */
const HARNESS_SLUGS_MAX = 64;

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
    .enum([...PLAN_STATUSES] as [string, ...string[]])
    .optional()
    .describe('Filter by plan-level status. Legacy plans (no frontmatter) report status "draft"; use includeLegacy + the isLegacy flag to find them.'),
  includeArchived: z
    .boolean()
    .optional()
    .describe('Include plans under docs/plans/archive/. Default false.'),
  includeLegacy: z
    .boolean()
    .optional()
    .describe('Include plans without valid frontmatter. Default true.'),
  /**
   * P-029: explicit multi-harness fan-out. When set, ignore the ctx
   * harness and walk each named harness's `docs/plans/` dir, returning
   * the union. Use for sub-harness scope (e.g. `papercup` + its
   * registered submodules). De-dupes by `slug:harness` since plan
   * slugs are unique within a harness but can repeat across them.
   * Capped at 64 entries.
   *
   * Accepts a single string OR an array of strings so HTTP callers
   * can pass either `?harness_slugs=foo` or
   * `?harness_slugs=foo&harness_slugs=bar` without a 400. The
   * dispatcher's bodyFromSearchParams only collapses repeated keys
   * into arrays; a single occurrence arrives as a bare string.
   */
  harness_slugs: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().min(1)).max(HARNESS_SLUGS_MAX, { message: `harness_slugs capped at ${HARNESS_SLUGS_MAX}` }))
    .optional()
    .describe('Optional explicit fan-out across multiple harnesses (overrides ctx harness).'),
  harness: harnessArg,
});

type ListRow = {
  slug: string;
  title: string | null;
  status: string;
  /** Last REAL activity — the PG `updated_at` write timestamp (ISO; the
   *  trigger skips no-op bumps, mig 209). Falls back to the authored
   *  frontmatter date if the timestamp is ever absent. */
  updated: string | null;
  created: string | null;
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
  /** Importance of the hottest OPEN item (done/dropped excluded), null
   *  when nothing is open. Missing `importance:` keyword = 'normal'. */
  maxImportance: Importance | null;
};

/** Most → least urgent rank, per IMPORTANCE_LEVELS order. */
const IMPORTANCE_RANK = Object.fromEntries(
  IMPORTANCE_LEVELS.map((level, i) => [level, i]),
) as Record<Importance, number>;

/** PG timestamps arrive as Date (node-postgres) or string depending on
 *  pool config — normalize to ISO; null when absent/unparseable. */
function isoOrNull(ts: unknown): string | null {
  if (!ts) return null;
  const d = new Date(ts as string | number | Date);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export default defineTool({
  name: 'plans:list',
  description:
    'List SU plans under apps/operator/docs/plans/. One row per plan with title, status, item counts by effectiveStatus, and the ## Now next-action line. Legacy plans (no frontmatter) surface as status="draft" (flagged via isLegacy).',
  guidance: {
    when: 'You need a directory of plans — "what plans exist", "what plans are active", or the entry point before plans:get.',
    notWhen:
      'You already know the plan slug and want full contents — call plans:get directly.',
    chaining:
      'plans:list → plans:get { slug } (full plan) or plans:items { actionable: true } (pickable items across plans).',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const includeArchived = args.includeArchived === true;
    const includeLegacy = args.includeLegacy !== false;

    // P-029: build the list of harness slugs to read.
    // When `harness_slugs` is supplied, fan out across each (validated via
    // resolveHarnessPlansDir); otherwise fall through to the ctx-resolver's
    // single harness. Unknown slugs produce a warning entry instead of
    // throwing — caller may pass a stale registry snapshot from the client.
    const perHarness: string[] = [];
    const unknownHarnesses: string[] = [];
    if (args.harness_slugs && args.harness_slugs.length > 0) {
      const seen = new Set<string>();
      for (const slug of args.harness_slugs) {
        const trimmed = slug.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        try {
          const r = await resolveHarnessPlansDir(trimmed);
          if (!perHarness.includes(r.harnessSlug)) perHarness.push(r.harnessSlug);
        } catch {
          unknownHarnesses.push(trimmed);
        }
      }
    } else {
      const one = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      perHarness.push(one.harnessSlug);
    }

    type AugmentedRow = ListRow & {
      startStatus: 'started' | 'paused' | 'done' | null;
      priority: number | null;
    };
    const augmentedRows: AugmentedRow[] = [];
    const seenRowKeys = new Set<string>();

    // engineer-issues D-005: one batch read of every open issue-block across all
    // plans, so the per-plan itemCounts histogram below reflects items flipped to
    // `blocked` by an open engineer-issue. Hoisted out of the harness×plan loops.
    // Non-fatal — degrades to resolver-only counts on error.
    let allBlocked = new Map<string, string[]>();
    try {
      allBlocked = await getAllBlockedPlanItems();
    } catch {
      // Non-fatal — no issue-block overlay.
    }

    for (const harnessSlug of perHarness) {
      // One SQL read per harness: the canonical blob + op_* status + frontmatter
      // index all arrive in the same harness_plans row (op_status replaces the
      // old separate harness_plan_status join).
      const plans = await readAllPlans({ harnessSlug, includeArchived });
      for (const { parsed, archived, row } of plans) {
        if (parsed.isLegacy && !includeLegacy) continue;

        const slug = parsed.frontmatter.slug ?? parsed.slug;

        let itemCounts: ListRow['itemCounts'] = null;
        let maxImportance: Importance | null = null;
        if (!parsed.isLegacy) {
          const { items } = applyPlanItemBlocks(
            resolveEffectiveStatus(parsed).items,
            (id) => allBlocked.get(planItemRef(slug, id)),
          );
          const counts: Record<string, number> = {};
          for (const it of items) {
            counts[it.effectiveStatus] = (counts[it.effectiveStatus] ?? 0) + 1;
            // Hottest open item — a done/dropped urgent item shouldn't keep
            // the plan ranked "most urgent".
            if (it.effectiveStatus !== 'done' && it.effectiveStatus !== 'dropped') {
              const imp = it.importance ?? 'normal';
              if (maxImportance === null || IMPORTANCE_RANK[imp] < IMPORTANCE_RANK[maxImportance]) {
                maxImportance = imp;
              }
            }
          }
          itemCounts = counts;
        }

        // No frontmatter status (incl. legacy/unparseable plans) → 'draft'.
        const status = parsed.frontmatter.status ?? 'draft';
        if (args.status && status !== args.status) continue;

        const dedupKey = `${harnessSlug}:${slug}`;
        if (seenRowKeys.has(dedupKey)) continue;
        seenRowKeys.add(dedupKey);

        augmentedRows.push({
          slug,
          title: parsed.frontmatter.title ?? null,
          status,
          updated: isoOrNull(row.updatedAt) ?? parsed.frontmatter.updated ?? null,
          created: parsed.frontmatter.created ?? null,
          owner: parsed.frontmatter.owner ?? null,
          archived,
          isLegacy: parsed.isLegacy,
          itemCounts,
          nextAction: parsed.now?.next ?? null,
          harness: harnessSlug,
          // Self-heal the started/terminal invariant on read: a terminal plan
          // (shipped/superseded) can never be operationally started/paused.
          startStatus: reconcileStartStatus(row.opStatus, status),
          priority: row.opPriority,
          maxImportance,
        });
      }
    }

    ctxAny.metadata?.({
      count: augmentedRows.length,
      includeArchived,
      includeLegacy,
      harnessCount: perHarness.length,
      ...(unknownHarnesses.length > 0 && { unknownHarnesses }),
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ plans: augmentedRows }) }],
    };
  },
});
