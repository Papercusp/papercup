/**
 * pot:create — stand up a new local hive (hive-tool-namespace-2026-06-08 P-004,
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
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { DeploymentConfigSchema } from '../../deployment/config-schema';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:create',
  profile: 'engineer',
  description:
    "Stand up a NEW local pot (root-only): provision a home harness running the hive (kind:'hive') blueprint, stamp it harness_kind:'hive', and optionally wake the Mug. Composes the harness-provision primitives + pot:wake, transactional with rollback. NOT callable from a cup/parented agent — pots are peers, never nested. Cloud placement is a separate step (deploy:hive).",
  guidance: {
    when: 'Standing up a NEW local pot (its home harness + Mug) in one call. Operator/user only.',
    notWhen:
      'Deploying an EXISTING pot to a cloud frame — deploy:hive. A plain non-pot harness — harness:create. From a cup — not allowed (spin a kind:harness subharness instead).',
    chaining:
      'pot:get { slug } to inspect; pot:declare-wake to set the cadence; deploy:hive to place it on a Swarm; pot:dissolve to tear it down.',
    seeAlso: [
      'pot:create_from_repo (onboard a GitHub repo as a pot instead)',
      'pot:start (boot the new pot into autonomous operation)',
      'pot:dissolve (tear it down)',
    ],
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
      .describe('Unique pot home-harness slug.'),
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
      .describe('Wake the Mug after N seconds (0 = now). Omit ⇒ create idle; wake later with pot:wake / pot:declare-wake.'),
    kickoff: softText(LIMITS.ANNOTATION).optional().describe('Kickoff context for the first wake. Auto-truncated to 2000 chars if longer.'),
    blueprintId: z
      .string()
      .max(120)
      .optional()
      .describe(
        "The kind:'hive' blueprint to run — default 'hive' (the coding pot); 'work' for a non-coding pot (judge-accepted, artifacts output, topic affinity). Resolved local→installed→built-in; blueprint:catalog lists the pot blueprints.",
      ),
    learningPack: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Learning pack to seed into the pot's shared memory (learning-packs P-005). Omit ⇒ the default pack (papercusp-default); 'none' ⇒ seed nothing. learning_packs:list enumerates the available packs.",
      ),
    repoRemote: z
      .enum(['auto', 'local-only'])
      .optional()
      .describe(
        "Fresh coding-pot repo remote policy (per-hive-git-and-release-gate). 'auto' (default) ⇒ create a PRIVATE GitHub remote + push when git creds are present (gh auth), else local-only. 'local-only' ⇒ never create a remote (the local staging→main gate still runs). Ignored when cloning/linking an existing repo.",
      ),
    repoOwner: z
      .string()
      .max(120)
      .optional()
      .describe('gh owner/org for the auto-created remote (default = the authenticated GitHub login).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (D-002): hives are peers, never nested.
    // Caller-DX (watchdog P-007b): an MCP client connecting without a resolvable
    // session identity (no uiClientId / Mcp-Session-Id / ?client=) made
    // resolveAgentIdentity THROW an opaque `missing uiClientId`, which surfaced as a
    // raw tool error. Catch it and return a structured, actionable error in the same
    // shape as the root-only guard below — the security invariant (attributable
    // coordination writes) is preserved; only the message is made legible.
    let actor: AgentIdentity;
    try {
      actor = resolveAgentIdentity(ctx);
    } catch (err) {
      return text({
        ok: false,
        error: 'identity_unresolved',
        message:
          'pot:create could not attribute the caller — the MCP client is missing a session identity ' +
          '(uiClientId / Mcp-Session-Id / ?client=). Re-run install-standalone-mcp.sh to mint a ?client= id ' +
          '(superuser), or connect with a power-user / principal session. pot:create is operator/user-only.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_create_root_only',
        message:
          'pot:create cannot be called from a cup (a spawned/parented agent). Pots are peers, never nested — spin a kind:harness subharness instead. Only the operator/user creates a pot.',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );
    const { createHiveHarness } = await import('./_create');
    const { resolveHive } = await import('./_resolve');

    const res = await createHiveHarness({
      slug: args.slug,
      workspaceId,
      parentDir: args.parentDir,
      deployment: args.deployment,
      wakeInSeconds: args.wakeInSeconds,
      kickoff: clampText(args.kickoff, LIMITS.ANNOTATION),
      blueprintId: args.blueprintId ?? undefined,
      // 'none' ⇒ null (seed nothing); omit ⇒ undefined (default pack).
      learningPack: args.learningPack === 'none' ? null : args.learningPack ?? undefined,
      repoRemote: args.repoRemote ?? undefined,
      repoOwner: args.repoOwner ?? undefined,
    });
    if (!res.ok) return text({ ...res });

    const hive = await resolveHive(args.slug, workspaceId);
    return text({
      ok: true,
      slug: res.slug,
      path: res.path,
      waked: res.waked,
      ...(res.seededLearnings ? { seededLearnings: res.seededLearnings } : {}),
      ...(res.repoInit ? { repoInit: res.repoInit } : {}),
      hive,
    });
  },
});
