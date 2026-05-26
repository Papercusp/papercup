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
import { listPlanFiles, readPlanBySlug, resolveHarnessPlansDir } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolveEffectiveStatus } from './effective-status';
import { ITEM_STATUSES, PLAN_STATUSES } from './parser';

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
      const one = await ctxToPlanSourceOpts(ctx);
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

        const status = parsed.frontmatter.status ?? (parsed.isLegacy ? 'unknown' : 'draft');

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

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ plans: rows }) }],
    };
  },
});
