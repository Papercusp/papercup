/**
 * deploy:hive / deploy:teardown_hive — deploy a Hive (a grouping of harnesses) to
 * a Swarm (cloud fleet) and tear it down (`cloud-deployment-layer-2026-06-06`
 * P-016/P-017). Thin MCP surface over `lib/deployment/hive-deploy.ts`. Queen
 * placement is a parameter (local|dedicated|colocated — decision-agnostic, D-008).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { DeploymentConfigSchema } from '../../deployment/config-schema';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

const hiveSpecArgs = z.object({
  hiveId: z.string().min(1).describe('Pot id (the grouping)'),
  members: z.array(z.string().min(1)).describe('Member harness slugs to deploy onto the Swarm'),
  swarm: DeploymentConfigSchema.describe('The cloud target for execution frames (e.g. {target:"latitude",region:"NYC",size:"m4-metal-small"}). Set desktop:true (or {displays,geometry}) for GUI-capable frames — one Xvfb display per agent slot.'),
  queen: z
    .object({
      placement: z.enum(['local', 'dedicated', 'colocated']).default('local'),
      deployment: DeploymentConfigSchema.optional(),
    })
    .optional(),
  budget: z.object({ perFrameUsdCap: z.number().positive().optional(), idleReaperMinutes: z.number().positive().optional() }).optional(),
  workspace: z.string().min(1).optional(),
});

export default defineTool({
  name: 'deploy:hive',
  description:
    "Deploy a pot (grouping of harnesses) to a Swarm (cloud fleet): place the Mug (local|dedicated|colocated) and deploy each member harness's execution to a frame. Per-member failures are reported, not fatal. Returns {ok, result}.",
  guidance: {
    when: 'Running a whole group of harnesses in the cloud — full-auto laptop-optional, or just to scale out execution across frames.',
    notWhen: 'A single harness — deploy:harness. Tearing one down — deploy:teardown_hive.',
    chaining: 'deploy:hive { hiveId, members, swarm } → deploy:teardown_hive when done.',
    seeAlso: [
      'deploy:teardown_hive (tear down the deployed pot when done)',
      'deploy:status (check deployment state)',
      'pot:get (the pot being deployed)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: hiveSpecArgs,
  async handler(args) {
    const { deployHive, defaultHiveDeployDeps } = await import('../../deployment/hive-deploy');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const result = await deployHive(args, ws, defaultHiveDeployDeps((lvl, m) => console.log(`[${lvl}] ${m}`)));
      return ok({ result });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const deployTeardownHiveTool = defineTool({
  name: 'deploy:teardown_hive',
  description:
    'Tear down a pot — DESTROY every member execution frame + the Mug control frame (ends all billing). Pass the same hiveId + members + queen placement used to deploy. Returns {ok, destroyed, failed}.',
  guidance: {
    when: 'Done with a deployed pot (or to stop all its billing). Frames are cattle — destroy + redeploy is the model.',
    seeAlso: [
      'deploy:hive (re-deploy the pot)',
      'pot:dissolve (permanently tear down the pot itself, not just its deployment)',
      'deploy:status (confirm what is deployed)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: hiveSpecArgs,
  async handler(args) {
    const { teardownHive, defaultHiveDeployDeps } = await import('../../deployment/hive-deploy');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const r = await teardownHive(args, ws, defaultHiveDeployDeps((lvl, m) => console.log(`[${lvl}] ${m}`)));
      return ok({ ...r });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});
