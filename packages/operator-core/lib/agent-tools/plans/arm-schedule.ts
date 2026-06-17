/**
 * plans:arm-schedule — arm a scheduled plan so it starts firing runs on its cadence.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 *
 * Authoring (plans:set-schedule) does NOT arm; this does — it materializes the plan's
 * routine (which fires system:plan-run on the computed next_fire_at) and sets
 * schedule_active. Autonomy-gated: the capability→category map classifies this as the
 * `schedule-arm` category (D-017, seeded never-auto), so the Queen's dispatch gate
 * escalates an autonomous arm to the owner until that category graduates; the owner arms
 * directly.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getPlanRow } from './source';
import { armPlanSchedule } from '../../harness/routines/arm-plan-schedule';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (the scheduled template) to arm.'),
});

function errOut(code: string, slug: string, detail?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, slug, ...(detail ? { detail } : {}) }) }],
    isError: true,
  };
}

export default defineTool({
  name: 'plans:arm-schedule',
  description:
    'Arm a scheduled plan so it starts firing runs on its cadence (materializes its routine + sets schedule_active). Authoring (plans:set-schedule) does not arm; this does. Autonomy-gated (schedule-arm category): the Queen escalates unless graduated; the owner arms directly.',
  guidance: {
    when: 'Activating a plan you already scheduled (plans:set-schedule) so it begins firing runs.',
    notWhen: 'Authoring/editing the cadence (plans:set-schedule). Firing one run by hand (plans:run-now).',
    chaining: 'plans:set-schedule → plans:arm-schedule → the routine fires system:plan-run on cadence. plans:disarm-schedule stops it.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (!(await getFlag(FLAGS.SCHEDULED_PLANS, 'system'))) {
      return errOut('feature_disabled', args.slug, 'the papercusp-scheduled-plans flag is off');
    }
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const plan = await getPlanRow(args.slug, opts);
    if (!plan) return errOut('not_found', args.slug);
    if (!plan.schedule && !plan.scheduledAt) {
      return errOut('not_scheduled', args.slug, 'author a schedule with plans:set-schedule first');
    }
    const res = await armPlanSchedule({
      workspaceId: plan.workspaceId,
      harnessSlug: plan.harnessSlug,
      templateSlug: args.slug,
      schedule: plan.schedule,
      scheduledAt: plan.scheduledAt,
      concurrency: plan.schedule?.concurrency,
    });
    if (!res.ok) return errOut(res.reason, args.slug);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, slug: args.slug, routineId: res.routineId, nextFireAt: res.nextFireAt }),
        },
      ],
    };
  },
});
