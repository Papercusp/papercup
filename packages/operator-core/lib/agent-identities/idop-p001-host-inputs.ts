import type { captureIdopP001HostPermissionPorts, captureIdopP001KernelPermissionPorts } from './idop-p001-baseline';
import { getServingHostIdentity } from '../serving-host-identity';

// Bind the comparison capture to the readers installed on the serving host.
// These entry points are internal. Their callers supply the original context or
// kernel request and retain responsibility for authenticating its provenance.
export async function captureIdopP001ServingEnvelopeInputs(
  options: Parameters<typeof captureIdopP001HostPermissionPorts>[0],
) {
  const [capture, confinement, identity, modes, overrides, flags] = await Promise.all([
    import('./idop-p001-baseline'), import('../capability-envelope/session-confinement-port'),
    import('../agent-tools/coordination/identity'), import('../modes/store'),
    import('../capability-envelope-overrides'), import('@papercusp/flags/server'),
  ]);
  return capture.captureIdopP001HostPermissionPorts(options, {
    ...confinement.getSessionConfinementReadPorts(),
    audit: { resolveIdentity: identity.resolveAgentIdentity, readModes: modes.getModes },
    roleOverrides: overrides.envelopeRoleOverrides,
    protectedAdditions: overrides.envelopeProtectedAdditions,
    readFlagAttestation: flags.getFlagAttestation,
  });
}

type KernelCapture = Parameters<typeof captureIdopP001KernelPermissionPorts>[0];

export async function captureIdopP001ServingKernelInputs(
  options: Pick<KernelCapture, 'workspaceId' | 'requests'> & Partial<Pick<KernelCapture, 'convergence'>>,
) {
  const [capture, kernel, identity, grants, plan, apps, organization, mcp] = await Promise.all([
    import('./idop-p001-baseline'), import('../projected-tool-deps'),
    import('../agent-tools/coordination/identity'), import('../capability-envelope/identity-grants-port'),
    import('../agent-tools/plans/plan-execution-guard'), import('../connected-apps/enforce'),
    import('../governance-policy/enforce'), import('@papercusp/agent-mcp'),
  ]);
  const toolNames = new Set<string>();
  const appTokens = new Map<string, Set<string>>();
  for (const { request } of options.requests) {
    toolNames.add(request.toolName);
    const app = apps.appPrincipalRefOfSlug(request.ctx.principal?.slug);
    if (!app) continue;
    const tokens = appTokens.get(app.appId) ?? new Set<string>();
    if (app.tokenId) tokens.add(app.tokenId);
    appTokens.set(app.appId, tokens);
  }
  return capture.captureIdopP001KernelPermissionPorts({
    workspaceId: options.workspaceId,
    requests: options.requests,
    policyInputs: [],
    operationClaims: [],
    toolNames: [...toolNames],
    apps: [...appTokens].map(([appId, tokens]) => ({ appId, tokenIds: [...tokens] })),
    convergence: options.convergence ?? [],
    captureIdentityDependencies: true,
  }, {
    inner: {
      readState: kernel.readControlAnchorKernelState,
      resolveIdentity: identity.resolveAgentIdentity,
      readPolicy: grants.readIdentityGrantPolicy,
      readOperationEffectClaim: grants.readCurrentOperationEffectClaim,
      resolveTool: mcp.resolveMcpName,
      runtime: { pid: process.pid, processId: getServingHostIdentity().processId },
      plan: {
        readBindings: plan.readExecutionPlanBindings,
        resolveGoal: plan.readExecutionPlanGoal,
        checkPlan: plan.checkExecutionPlan,
      },
    },
    app: apps.getAppKeyScopeReadPorts(),
    organization: organization.getInheritedPolicyReadPorts(),
  });
}
