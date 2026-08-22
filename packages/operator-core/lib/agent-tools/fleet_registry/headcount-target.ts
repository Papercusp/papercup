/** fleet:headcount-target — persist a bounded fleet member target for the
 * background governor. The first wave still uses fleet:launch-on-plan; this
 * tool records the validated recipe that later routine ticks may top up. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet, setFleetHeadcountTarget, type FleetHeadcountConfig } from '../../agent-fleets-store';
import { FLEET_MAX_TARGET_MEMBERS } from '../../agent-config-constants';
import { resolveHarnessPlansDir, readPlanBySlug } from '../plans/source';
import { json, resolveFleetCaller } from './_shared';

export default defineTool({
  name: 'fleet:headcount-target',
  description:
    'Persist a bounded target member count and launch recipe for a fleet. The dark, routine-backed governor uses this recipe to top up missing headless members with duplicate suppression and exponential backoff.',
  guidance: {
    when: 'After a fleet:launch-on-plan wave, when the fleet should maintain a target member count across member death and operator restarts.',
    notWhen: 'For a one-off launch wave, use fleet:launch-on-plan. Clear the governor with target:null when the fleet should stop auto-top-up.',
  },
  capability: 'fleet:headcount-target',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('Existing fleet slug.'),
    target: z.number().int().min(1).max(FLEET_MAX_TARGET_MEMBERS).nullable().describe('Desired live member count, or null to disable the governor.'),
    harness: z.string().min(1).describe('Harness containing the plan.'),
    plan: z.string().min(1).describe('Plan whose work the top-up members should pull.'),
    agent: z.enum(['claude', 'omp', 'codex']).default('claude'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).max(40).optional(),
    account: z.string().min(1).optional(),
    headless: z.boolean().optional().describe('Persisted placement. Defaults true for background restoration.'),
    role: z.string().min(1).optional(),
    brief: z.string().min(1).max(4000).optional(),
    launchContext: z.string().min(1).optional(),
    contextSize: z.enum(['full', 'trimmed']).optional(),
    compactionLimit: z.number().int().min(20_000).max(900_000).optional(),
    carry: z.enum(['warm', 'cold']).optional(),
    extraArgs: z.array(z.string()).max(20).optional(),
  }),
  async handler(args, ctx) {
    const { workspaceId, ownerId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) return json({ ok: false, error: `no fleet '${args.fleet}' in this workspace` }, true);
    if (args.target == null) {
      await setFleetHeadcountTarget({ workspaceId, fleetSlug: args.fleet, target: null });
      return json({ ok: true, fleet: args.fleet, target: null, disabled: true, by: ownerId });
    }
    try {
      const resolved = await resolveHarnessPlansDir(args.harness, { workspaceId });
      const plan = await readPlanBySlug(args.plan, { harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
      if (!plan) return json({ ok: false, error: `plan '${args.plan}' was not found in harness '${args.harness}'` }, true);
    } catch (error) {
      return json({ ok: false, error: `could not validate plan: ${error instanceof Error ? error.message : String(error)}` }, true);
    }
    const config: FleetHeadcountConfig = {
      plan: args.plan,
      harness: args.harness,
      agent: args.agent,
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.account ? { account: args.account } : {}),
      headless: args.headless ?? true,
      ...(args.role ? { role: args.role } : {}),
      ...(args.brief ? { brief: args.brief } : {}),
      ...(args.launchContext ? { launchContext: args.launchContext } : {}),
      ...(args.contextSize ? { contextSize: args.contextSize } : {}),
      ...(args.compactionLimit ? { compactionLimit: args.compactionLimit } : {}),
      ...(args.carry ? { carry: args.carry } : {}),
      ...(args.extraArgs?.length ? { extraArgs: args.extraArgs } : {}),
    };
    await setFleetHeadcountTarget({ workspaceId, fleetSlug: args.fleet, target: args.target, config });
    return json({ ok: true, fleet: args.fleet, target: args.target, config, enabled: true, by: ownerId });
  },
});
