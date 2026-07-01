/**
 * plans:pause — suspend orchestrator feature-picking for a plan without losing started state.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * Sets op_status='paused' on the plan's harness_shared.harness_plans row
 * (the operational columns folded in from the retired harness_plan_status
 * table — plans-pg-canonical-migration-2026-06-03).
 * The plan's in-flight features are NOT cancelled — any running worker
 * turn finishes, but no new features are picked until the plan is
 * re-started via plans:start.
 *
 * Pausing a plan that was never started returns { notStarted: true }.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  slug: z.string().min(1).optional().describe('Plan slug to pause.'),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to pause in one call.'),
  harness: harnessArg,
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

export default defineTool({
  name: 'plans:pause',
  description:
    "Suspend orchestrator feature-picking for a plan. In-flight worker turns finish; no new features are picked until plans:start is called again. Returns { notStarted: true } if the plan was never started (op_status is null).",
  guidance: {
    when: "User pauses work on a plan from the UI, or an agent needs to suspend a plan without marking it done.",
    notWhen:
      'The plan is done — use plans:set-run-status for run lifecycle. To mark the whole plan complete, update the frontmatter status to shipped.',
    chaining: 'plans:list to find the slug, then plans:pause { slug }. Resume with plans:start.',
    seeAlso: [
      'plans:start (resume / start a paused plan)',
      'plans:set-priority (reorder instead of pausing)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const now = new Date().toISOString();
        // op_status is null until a plan has been started — so a pause that matches
        // no started/paused/done op_status means "never started" (the row exists as
        // the plan itself, but it was never operationally started).
        const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
          return tx<{ op_status: string; op_updated_at: string }[]>`
            UPDATE harness_shared.harness_plans
               SET op_status = 'paused', op_updated_at = ${now}
             WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
               AND harness_slug  = ${harnessSlug}
               AND plan_slug     = ${slug}
               AND op_status IS NOT NULL
            RETURNING op_status, op_updated_at
          `;
        });
        ctxAny.metadata?.({ slug, harnessSlug });
        if (rows.length === 0) {
          return {
            ok: true as const,
            slug,
            harnessSlug,
            notStarted: true,
            message: 'plan has no started/paused row — call plans:start first',
          };
        }
        return { ok: true as const, slug, harnessSlug, status: 'paused', updatedAt: rows[0].op_updated_at };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
