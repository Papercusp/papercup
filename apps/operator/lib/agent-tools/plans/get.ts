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
import { withWorkspace } from '@restart/db-org';
import { readPlanBySlug } from './source';
import { ctxToPlanSourceOpts, resolveCtxHarnessSlug } from './_ctx-opts';
import { resolveEffectiveStatus } from './effective-status';
import { hashPlanContent } from './content-hash';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';

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
    const opts = await ctxToPlanSourceOpts(ctx);
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
    const harnessSlug = resolveCtxHarnessSlug(ctx) ?? 'papercup';
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
          }),
        },
      ],
    };
  },
});
