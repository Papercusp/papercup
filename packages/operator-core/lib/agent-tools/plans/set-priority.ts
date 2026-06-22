/**
 * plans:set-priority — set the cross-plan dispatch priority for a
 * started plan (dbos-system-completion-2026-06-01 P-045/D-013).
 *
 * Writes `harness_shared.harness_plans.op_priority` (INTEGER, NULLable;
 * lower = dispatched first — the operational column folded in from the retired
 * harness_plan_status table, plans-pg-canonical-migration-2026-06-03).
 * The frontier groups the ready feature set by
 * plan and orders the groups by this column, so operators drag-to-reorder
 * started plans to control which plan's features the pipeline tackles next.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { bulkContent, runBulk } from '../_bulk';

const setPriorityItemSchema = z.object({
  slug: z.string().min(1).describe('Plan slug to prioritize.'),
  priority: z.number().int().nullable().describe(
    'Dispatch rank — lower = dispatched first. Pass null to clear (no explicit priority; uses started_at order).',
  ),
});

const argsSchema = setPriorityItemSchema.extend({
  harness: harnessArg,
  items: z.array(setPriorityItemSchema).min(1).max(200).optional().describe('plan priorities to set in one call'),
});

export default defineTool({
  name: 'plans:set-priority',
  description:
    'Set the cross-plan dispatch priority for a started plan. Lower = dispatched first. The drag-to-reorder UI calls this automatically; agents can also call it when explicit ordering matters.',
  guidance: {
    when: 'User drags a started plan to a new position in the Plans rail, or explicitly asks "do plan A before plan B".',
    notWhen: 'For pausing a plan, use plans:pause. For the run lifecycle, use plans:set-run-status.',
    chaining: 'plans:list to see started plans and their current priorities.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx) ?? operatorHomeHarnessSlug();
    const items = args.items ?? [{ slug: args.slug, priority: args.priority }];
    const env = await runBulk(
      items,
      async (item) => {
        const now = new Date().toISOString();
        await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
          return tx`
            UPDATE harness_shared.harness_plans
               SET op_priority  = ${item.priority},
                   op_updated_at = ${now}
             WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
               AND harness_slug = ${harnessSlug}
               AND plan_slug    = ${item.slug}
          `;
        });
        return { ok: true as const, slug: item.slug, harnessSlug, priority: item.priority };
      },
      { keyOf: (item) => ({ slug: item.slug }) },
    );
    return bulkContent(env);
  },
});
