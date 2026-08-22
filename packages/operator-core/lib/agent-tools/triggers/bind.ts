import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createExternalTriggerBinding } from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:bind',
  profile: 'engineer',
  description:
    'Install a disarmed external-event binding from one source to one plan, with an optional payload filter and storm policy.',
  guidance: {
    when: 'Attach an existing external source event pattern (ext:<source>:<event>) to a plan. The new binding is installed but DISARMED.',
    notWhen:
      'To activate it use triggers:arm separately. For schedules use plans:set-schedule then plans:arm-schedule. For manual starts use plans:run-now.',
    chaining:
      'triggers:list → triggers:bind → inspect the returned disarmed binding → triggers:arm { bindingId, confirm:true }.',
    seeAlso: ['triggers:arm (activate the installed binding)', 'plans:set-schedule (time trigger)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sourceId: z.string().uuid(),
    harness: z.string().min(1).max(120).describe('target plan harness'),
    plan: z.string().min(1).max(200).describe('target plan slug'),
    eventPattern: z.string().min(5).max(500).describe('ext:<source>:<event> key or anchored glob'),
    filter: dataConditionSchema.optional().describe('payload condition using the shared rules vocabulary'),
    stormPolicy: z
      .object({
        maxRuns: z.number().int().positive().max(1_000_000).nullable().optional(),
        windowSeconds: z
          .number()
          .int()
          .positive()
          .max(31 * 24 * 60 * 60)
          .optional(),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    const binding = await createExternalTriggerBinding(sql, workspaceId, {
      sourceId: args.sourceId,
      planHarnessSlug: args.harness,
      planSlug: args.plan,
      eventPattern: args.eventPattern,
      eventFilter: args.filter as Record<string, unknown> | undefined,
      stormPolicy: args.stormPolicy,
      createdBy: actorId,
    });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, binding });
  },
});
