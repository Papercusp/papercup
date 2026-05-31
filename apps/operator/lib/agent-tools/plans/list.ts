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
import { listPlanFiles, readPlanBySlug, resolveHarnessPlansDir } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatus } from './effective-status';
import { ITEM_STATUSES, PLAN_STATUSES } from './parser';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';

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

    // P-029: build the list of per-harness source-opts to walk.
    // When `harness_slugs` is supplied, fan out across each (resolving
    // its on-disk plans dir via resolveHarnessPlansDir); otherwise
    // fall through to the ctx-resolver's single harness. Unknown
    // slugs produce a warning entry instead of throwing — caller may
    // pass a stale registry snapshot from the client.
    const perHarnessOpts: Array<{ harnessSlug: string; plansDir: string; archiveDir: string }> = [];
    const unknownHarnesses: string[] = [];
    if (args.harness_slugs && args.harness_slugs.length > 0) {
      const seen = new Set<string>();
      for (const slug of args.harness_slugs) {
        const trimmed = slug.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        try {
          const r = await resolveHarnessPlansDir(trimmed);
          perHarnessOpts.push({
            harnessSlug: r.harnessSlug,
            plansDir: r.plans,
            archiveDir: r.archive,
          });
        } catch {
          unknownHarnesses.push(trimmed);
        }
      }
    } else {
      const one = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      perHarnessOpts.push({
        harnessSlug: one.harnessSlug,
        plansDir: one.plansDir ?? '',
        archiveDir: one.archiveDir ?? '',
      });
    }

    const rows: ListRow[] = [];
    const seenRowKeys = new Set<string>();
    for (const ho of perHarnessOpts) {
      const sourceOpts = ho.plansDir
        ? { plansDir: ho.plansDir, archiveDir: ho.archiveDir }
        : {};
      const entries = await listPlanFiles(sourceOpts);
      const filtered = includeArchived ? entries : entries.filter((e) => !e.archived);
      for (const entry of filtered) {
        const result = await readPlanBySlug(entry.slug, sourceOpts);
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

        // No frontmatter status (incl. legacy/unparseable plans) → 'draft'.
        // 'unknown' was retired as a status; the isLegacy flag still marks
        // frontmatter-less plans for callers that care.
        const status = parsed.frontmatter.status ?? 'draft';

        if (args.status && status !== args.status) continue;

        const slug = parsed.frontmatter.slug ?? parsed.slug;
        const dedupKey = `${ho.harnessSlug}:${slug}`;
        if (seenRowKeys.has(dedupKey)) continue;
        seenRowKeys.add(dedupKey);

        rows.push({
          slug,
          title: parsed.frontmatter.title ?? null,
          status,
          updated: parsed.frontmatter.updated ?? null,
          owner: parsed.frontmatter.owner ?? null,
          archived,
          isLegacy: parsed.isLegacy,
          itemCounts,
          nextAction: parsed.now?.next ?? null,
          harness: ho.harnessSlug,
        });
      }
    }

    ctxAny.metadata?.({
      count: rows.length,
      includeArchived,
      includeLegacy,
      harnessCount: perHarnessOpts.length,
      ...(unknownHarnesses.length > 0 && { unknownHarnesses }),
    });

    // Batch-load harness_plan_status for all slugs so Start/Pause UI
    // can derive button state without a separate fetch per plan.
    let startStatusMap: Map<string, string> = new Map();
    try {
      const slugSet = rows.map((r) => r.slug);
      if (slugSet.length > 0) {
        const harnessSlug = perHarnessOpts[0]?.harnessSlug ?? 'papercup';
        const statusRows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
          return tx<{ plan_slug: string; status: string }[]>`
            SELECT plan_slug, status
              FROM harness_shared.harness_plan_status
             WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
               AND harness_slug  = ${harnessSlug}
               AND plan_slug = ANY(${slugSet})
          `;
        });
        for (const sr of statusRows) {
          startStatusMap.set(sr.plan_slug, sr.status);
        }
      }
    } catch {
      // harness_plan_status may not exist yet on older installs — degrade gracefully
    }

    const augmentedRows = rows.map((r) => ({
      ...r,
      startStatus: (startStatusMap.get(r.slug) ?? null) as 'started' | 'paused' | 'done' | null,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ plans: augmentedRows }) }],
    };
  },
});
