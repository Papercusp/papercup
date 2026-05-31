/**
 * plans:get — full parsed structure for one plan.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns frontmatter, ## Now, items (with both storedStatus AND
 * effectiveStatus), decisions, and raw prose. Resolves both
 * docs/plans/ and docs/plans/archive/ — archived doesn't make a plan
 * unreachable.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { readPlanBySlug } from './source';
import { ctxToPlanSourceOpts, resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveStatus } from './effective-status';
import { hashPlanContent } from './content-hash';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { ensureHarnessPlanAssertionsTable } from '../../ensure-schema';
import { computePlanItemTestStatus, type PlanItemTestStatus } from '../../harness-test-rollup';

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
  harness: harnessArg,
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename without .md). Resolves both docs/plans/ and docs/plans/archive/.'),
});

export default defineTool({
  name: 'plans:get',
  description:
    'Fetch the full parsed structure of one plan by slug: frontmatter, ## Now (state + next), items with effectiveStatus, decisions. Resolves archived plans too.',
  guidance: {
    when: 'You have a slug from plans:list and need the plan contents.',
    notWhen:
      "You don't know the slug — call plans:list first. Item-only queries across plans should use plans:items.",
    chaining: 'plans:list → plans:get { slug } → optionally plans:items for cross-plan picks.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const result = await readPlanBySlug(args.slug, opts);
    if (!result) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
        isError: true,
      };
    }

    const { parsed, archived } = result;
    ctxAny.metadata?.({ slug: args.slug, archived, legacy: parsed.isLegacy });

    if (parsed.isLegacy) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              slug: parsed.slug,
              archived,
              legacy: true,
              prose: parsed.prose,
              raw: parsed.raw,
              contentHash: hashPlanContent(parsed.raw),
              filename: parsed.filename,
            }),
          },
        ],
      };
    }

    const resolved = resolveEffectiveStatus(parsed);

    // P-006: Build a map of plan-item-id → { featureId, status } so the UI
    // can show live feature status badges next to each P-NNN item.
    const harnessSlug = resolveCtxHarnessSlug(sctx) ?? 'papercup';
    let linkedFeatures: Record<string, { featureId: string; status: string; harnessSlug: string }> = {};
    try {
      const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
        return tx<{ feature_id: string; status: string; source_plan_item_ids: string[] | null; harness_slug: string }[]>`
          SELECT feature_id, status, source_plan_item_ids, harness_slug
            FROM harness_shared.harness_features_consolidated
           WHERE workspace_id   = ${DEFAULT_WORKSPACE_ID}
             AND source_plan_slug = ${args.slug}
             AND source_plan_item_ids IS NOT NULL
        `;
      });
      for (const row of rows) {
        for (const itemId of row.source_plan_item_ids ?? []) {
          linkedFeatures[itemId] = { featureId: row.feature_id, status: row.status, harnessSlug: row.harness_slug };
        }
      }
    } catch {
      // Non-fatal — UI degrades to no badges.
    }

    // P-083: per-plan-item test coverage (the plan↔test rollup, through the
    // VAL). Mirrors linkedFeatures — computed server-side, decorated client-
    // side by decoratePlanItemTestBadges. Skips the tests query when the plan
    // has no inline-VAL assertions. Non-fatal.
    let planItemTests: Record<string, PlanItemTestStatus> = {};
    try {
      await ensureHarnessPlanAssertionsTable();
      planItemTests = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
        const assertions = await tx<{ val_id: string; item_id: string; requires_test: boolean }[]>`
          SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
           WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug} AND plan_slug = ${args.slug}
        `;
        if (assertions.length === 0) return {};
        const testRows = await tx<{ status: string; payload: { coversVALs?: unknown } }[]>`
          SELECT status, payload FROM harness_shared.harness_tests
           WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug}
        `;
        return computePlanItemTestStatus(
          assertions,
          testRows.map((r) => ({
            status: r.status,
            coversVALs: Array.isArray(r.payload?.coversVALs)
              ? (r.payload.coversVALs as unknown[]).filter((v): v is string => typeof v === 'string')
              : [],
          })),
        );
      });
    } catch {
      // Non-fatal — UI degrades to no coverage badges.
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: parsed.frontmatter.slug ?? parsed.slug,
            archived,
            legacy: false,
            frontmatter: parsed.frontmatter,
            now: parsed.now,
            items: resolved.items,
            decisions: parsed.decisions,
            missingRefs: resolved.missingRefs,
            cycleMembers: resolved.cycleMembers,
            prose: parsed.prose,
            raw: parsed.raw,
            contentHash: hashPlanContent(parsed.raw),
            linkedFeatures,
            planItemTests,
          }),
        },
      ],
    };
  },
});
