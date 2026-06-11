/**
 * hive:create — stand up a new local hive (hive-tool-namespace-2026-06-08 P-004,
 * D-002/D-005).
 *
 * ROOT-ONLY: hives are peers, never nested. The tool refuses a parented/bee
 * caller up front (resolveAgentIdentity → source 'fleet-spawn'); the
 * `assertNotNestedHive` guard inside fireLaunchBlueprint is the runtime backstop.
 * The provisioning + initial wake live in `createHiveHarness` (transactional);
 * this is the guard + arg surface. Cloud placement is a separate step (deploy:hive).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { DeploymentConfigSchema } from '../../deployment/config-schema';
import { activeWorkspaceId } from '../../workspace-registry';
import { createHiveHarness } from './_create';
import { resolveHive } from './_resolve';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:create',
  profile: 'engineer',
  description:
    "Stand up a NEW local hive (root-only): provision a home harness running the hive (kind:'hive') blueprint, stamp it harness_kind:'hive', and optionally wake the Queen. Composes the harness-provision primitives + hive:wake, transactional with rollback. NOT callable from a bee/parented agent — hives are peers, never nested. Cloud placement is a separate step (deploy:hive).",
  guidance: {
    when: 'Standing up a NEW local hive (its home harness + Queen) in one call. Operator/user only.',
    notWhen:
      'Deploying an EXISTING hive to a cloud frame — deploy:hive. A plain non-hive harness — harness:create. From a bee — not allowed (spin a kind:harness subharness instead).',
    chaining:
      'hive:get { slug } to inspect; hive:declare-wake to set the cadence; deploy:hive to place it on a Swarm; hive:dissolve to tear it down.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .describe('Unique hive home-harness slug.'),
    parentDir: z.string().min(1).optional().describe('Parent dir for the home harness (default ~/.papercusp/hives).'),
    deployment: DeploymentConfigSchema.optional().describe(
      'Execution plane (default local). Cloud placement is usually a later deploy:hive step.',
    ),
    wakeInSeconds: z
      .number()
      .int()
      .min(0)
      .max(86_400)
      .optional()
      .describe('Wake the Queen after N seconds (0 = now). Omit ⇒ create idle; wake later with hive:wake / hive:declare-wake.'),
    kickoff: z.string().max(2000).optional().describe('Kickoff context for the first wake.'),
    learningPack: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Learning pack to seed into the hive's shared memory (learning-packs P-005). Omit ⇒ the default pack (papercusp-default); 'none' ⇒ seed nothing. learning_packs:list enumerates the available packs.",
      ),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (D-002): hives are peers, never nested.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_create_root_only',
        message:
          'hive:create cannot be called from a bee (a spawned/parented agent). Hives are peers, never nested — spin a kind:harness subharness instead. Only the operator/user creates a hive.',
      });
    }

    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const res = await createHiveHarness({
      slug: args.slug,
      workspaceId,
      parentDir: args.parentDir,
      deployment: args.deployment,
      wakeInSeconds: args.wakeInSeconds,
      kickoff: args.kickoff,
      // 'none' ⇒ null (seed nothing); omit ⇒ undefined (default pack).
      learningPack: args.learningPack === 'none' ? null : args.learningPack ?? undefined,
    });
    if (!res.ok) return text({ ...res });

    const hive = await resolveHive(args.slug, workspaceId);
    return text({
      ok: true,
      slug: res.slug,
      path: res.path,
      waked: res.waked,
      ...(res.seededLearnings ? { seededLearnings: res.seededLearnings } : {}),
      hive,
    });
  },
});
