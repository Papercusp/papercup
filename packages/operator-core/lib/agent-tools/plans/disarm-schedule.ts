/**
 * plans:disarm-schedule — stop a scheduled plan from firing (pause).
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 *
 * Sets schedule_active=false and deactivates the plan's routine. The authored schedule
 * columns are kept, so re-arming (plans:arm-schedule) is one call. Same `schedule-arm`
 * autonomy category as arming.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow } from './source';
import { disarmPlanSchedule } from '../../harness/routines/arm-plan-schedule';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (the scheduled template) to disarm/pause.'),
});

export default defineTool({
  name: 'plans:disarm-schedule',
  description:
    'Disarm (pause) a scheduled plan so it stops firing runs — sets schedule_active=false + deactivates its routine. The authored schedule is kept; plans:arm-schedule re-arms it.',
  guidance: {
    when: 'Pausing a scheduled plan so it stops firing, without discarding its schedule.',
    notWhen: 'Permanently removing the schedule — use plans:set-schedule { schedule: null }.',
    chaining: 'plans:disarm-schedule (pause) ↔ plans:arm-schedule (resume).',
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
    await disarmPlanSchedule({ workspaceId: plan.workspaceId, harnessSlug: plan.harnessSlug, templateSlug: args.slug });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, slug: args.slug }) }] };
  },
});
