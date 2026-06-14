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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  listPlanIndexRows,
  getPlanContentsBySlugs,
  resolveHarnessPlansDir,
  type PlanIndexRow,
} from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatusForItems } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';
import {
  IMPORTANCE_LEVELS,
  ITEM_STATUSES,
  PLAN_STATUSES,
  parsePlan,
  type Importance,
  type ItemStatus,
  type PlanItem,
} from './parser';
import { reconcileStartStatus } from './plan-start-state';

/** Cap for the multi-harness arg per P-021 — keeps IN-style fan-out bounded. */
const HARNESS_SLUGS_MAX = 64;

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
   *  trigger skips no-op bumps, mig 211). Falls back to the authored
   *  frontmatter date if the timestamp is ever absent. */
  updated: string | null;
  created: string | null;
  owner: string | null;
  /** P-015 free-text initiative grouping label (frontmatter-derived), or null. */
  initiative: string | null;
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
  agentRoles: [...SU_ROLES],
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
      /** 'scout' when the plan was routed by the Scout loop (ledger-derived) — the Create-tab origin filter. */
      origin: 'scout' | null;
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

    // Scout provenance: one batched ledger read (scout_routed_ideas is the
    // canonical record of what the Scout loop routed — frontmatter need not be
    // parsed, and pre-stamp plans are covered retroactively). Workspace-free by
    // design (see readScoutPlanRefs — in-dispatch ALS is 'default'). Non-fatal.
    let scoutPlanRefs = new Set<string>();
    try {
      const { readScoutPlanRefs } = await import('../../scout/routed-ledger');
      scoutPlanRefs = await readScoutPlanRefs();
    } catch (err) {
      // Non-fatal — origin degrades to null. Logged because a silent miss here
      // cost a live debugging session (2026-06-11): the Create tab's scout
      // filter quietly matches nothing when this read breaks.
      // eslint-disable-next-line no-console
      console.warn('[plans:list] scout-provenance read failed — origin omitted:', err instanceof Error ? err.message : err);
    }

    for (const harnessSlug of perHarness) {
      // Index-only read (audit P-042 — EI-98/EI-174/EI-175): every field this
      // row needs lives in the harness_plans projection columns, so the
      // content blobs never leave PG and nothing is parsed per request. The
      // archived filter runs in SQL.
      const rows = await listPlanIndexRows({ harnessSlug, includeArchived });

      // Targeted fallback for projection-gap rows (non-legacy with an empty
      // Stage-3 items index — e.g. a federated remote row whose projection
      // didn't fill): ONE batched content fetch for just those slugs, parsed
      // below. Best-effort — on failure their counts degrade to {}.
      const gapSlugs = rows
        .filter((r) => !r.isLegacy && r.items.length === 0)
        .map((r) => r.planSlug);
      let gapContents = new Map<string, string>();
      if (gapSlugs.length > 0) {
        try {
          gapContents = await getPlanContentsBySlugs(gapSlugs, { harnessSlug });
        } catch {
          /* counts for gap rows degrade to {} */
        }
      }

      const itemsForRow = (row: PlanIndexRow): PlanItem[] => {
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
        const content = gapContents.get(row.planSlug);
        return content ? parsePlan(content).items : [];
      };

      for (const row of rows) {
        if (row.isLegacy && !includeLegacy) continue;

        const slug = row.planSlug;

        let itemCounts: ListRow['itemCounts'] = null;
        let maxImportance: Importance | null = null;
        if (!row.isLegacy) {
          const { items } = applyPlanItemBlocks(
            resolveEffectiveStatusForItems(itemsForRow(row)).items,
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

        // No projected status (incl. legacy/unparseable plans) → 'draft'.
        const status = row.status ?? 'draft';
        if (args.status && status !== args.status) continue;

        const dedupKey = `${harnessSlug}:${slug}`;
        if (seenRowKeys.has(dedupKey)) continue;
        seenRowKeys.add(dedupKey);

        augmentedRows.push({
          slug,
          title: row.title,
          status,
          updated: isoOrNull(row.updatedAt) ?? row.updated ?? null,
          created: row.created,
          owner: row.owner,
          initiative: row.initiative,
          archived: row.archived,
          isLegacy: row.isLegacy,
          itemCounts,
          nextAction: row.nowNext,
          harness: harnessSlug,
          // Self-heal the started/terminal invariant on read: a terminal plan
          // (shipped/superseded) can never be operationally started/paused.
          startStatus: reconcileStartStatus(row.opStatus, status),
          priority: row.opPriority,
          maxImportance,
          origin: scoutPlanRefs.has(`plan:${slug}`) ? ('scout' as const) : null,
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
