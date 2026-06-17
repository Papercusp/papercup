/**
 * plans:run-now — fire one run of a scheduled plan immediately (a manual run),
 * independent of its cadence.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-014).
 *
 * Mints an instance plan + plan_runs row (trigger='manual') + run-scoped work items —
 * exactly like a scheduled fire (runScheduledPlanFire), just triggered by hand. Works
 * whether or not the plan's schedule is armed.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow } from './source';
import { runScheduledPlanFire } from '../../harness/routines/plan-run-action';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (the template) to run once now.'),
});

export default defineTool({
  name: 'plans:run-now',
  description:
    'Fire one run of a scheduled plan immediately (a manual run), independent of its cadence — mints an instance plan + plan_runs row + run-scoped work items, like a scheduled fire.',
  guidance: {
    when: 'Manually triggering a run of a scheduled plan now — testing the schedule, or an out-of-band run.',
    notWhen:
      'Changing the cadence (plans:set-schedule). Launching a plan as an interactive chat session (plans:launch).',
    chaining: 'plans:set-schedule (author) → plans:run-now (fire one) → plans:runs (inspect the runs).',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const plan = await getPlanRow(args.slug, opts);
    if (!plan) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
        isError: true,
      };
    }
    const { sql } = getOrgPg();
    const res = await runScheduledPlanFire(sql, {
      installSlug: plan.harnessSlug,
      workspaceId: plan.workspaceId,
      templateSlug: args.slug,
      trigger: 'manual',
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(res ? { ok: true, ...res } : { error: 'run_failed', slug: args.slug }),
        },
      ],
      ...(res ? {} : { isError: true }),
    };
  },
});
