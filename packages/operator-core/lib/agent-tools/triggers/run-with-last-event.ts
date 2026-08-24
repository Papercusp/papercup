import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { queueExternalTriggerLastEventTestRun } from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:run-with-last-event',
  profile: 'engineer',
  description:
    'Queue a distinct audited test run for one plan binding using its latest settled provider event. This may perform the workflow\'s configured provider write (for example a Gmail draft or Slack thread reply).',
  guidance: {
    when:
      'Testing an installed workflow against the last real event it received. Pass confirm:true after surfacing that the resulting plan may write back to the provider.',
    notWhen:
      'For a manual run with operator-supplied inputs use plans:run-now. This verb never re-ingests a provider event and is unavailable until the binding has settled event history.',
    chaining:
      'triggers:status → triggers:run-with-last-event { bindingId, confirm:true } → triggers:status or plans:runs.',
    seeAlso: ['triggers:status (inspect source and run history)', 'plans:runs (inspect the minted plan run)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    bindingId: z.string().uuid(),
    confirm: z.literal(true).describe(
      'Confirms that this test execution may perform the workflow\'s configured provider write.',
    ),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    const result = await queueExternalTriggerLastEventTestRun(sql, workspaceId, {
      bindingId: args.bindingId,
      requestedBy: actorId,
    });
    if (result.ok) await invalidateTriggers(workspaceId);
    return data(result);
  },
});
