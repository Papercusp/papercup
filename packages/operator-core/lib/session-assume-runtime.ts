/** Trusted composition over the existing launch policy, receipt ledger,
 * caller recovery and resume reservation. No public argument can supply these
 * ports, an authorization reference, an environment or a runtime witness. */
import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity, isTransportOnlyIdentity } from './agent-tools/coordination/identity';
import { resolveResumeTarget } from './agent-launch-core';
import { inspectBlindReviewResumeTarget } from './blind-review-session-bindings';
import { readSessionConfinement } from './capability-envelope/session-confinement-store';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { createAssumeCallerAdapters, type AssumeCallerHostFence } from './session-assume-caller';
import { createAssumeCustodyAdapters } from './session-assume-custody';
import { readAssumeCaller, readAssumeTarget } from './session-assume-preparation';
import { createAssumeReceiptStore } from './session-assume-store';
import type { AssumeActor, AssumePreparation, AssumePreparationDeps, AssumeRequest, AssumeTransitionDeps } from './session-assume';

interface AssumeAuthorizationPorts {
  confinement: typeof readSessionConfinement;
  resolve: typeof resolveResumeTarget;
  inspect: typeof inspectBlindReviewResumeTarget;
  envelope(ctx: UnifiedToolContext, request: AssumeRequest): Promise<boolean>;
}

const authorizationPorts: AssumeAuthorizationPorts = {
  confinement: readSessionConfinement, resolve: resolveResumeTarget, inspect: inspectBlindReviewResumeTarget,
  async envelope(ctx, request) {
    const { PROJECTED_DEPS } = await import('./projected-tool-deps');
    if (!PROJECTED_DEPS.checkCapabilityEnvelope) return false;
    for (const toolName of ['session:assume', 'capability:launch-agent']) {
      const verdict = await PROJECTED_DEPS.checkCapabilityEnvelope({ toolName,
        capabilities: ['capability:terminal'], ctx, args: request });
      if (verdict && verdict.decision !== 'allow') return false;
    }
    return true;
  },
};

/** The ctx is transport-owned. Administrative host metadata alone is not a
 * grant: require the authenticated principal and the same bypass/capability
 * policy that admits the administrative launch door, then reread confinement
 * on every preparation/commit. Restricted reviewers remain recruiter-owned. */
export function createAssumeAuthorizer(
  ctx: UnifiedToolContext, request: AssumeRequest, ports: AssumeAuthorizationPorts = authorizationPorts,
): AssumePreparationDeps['authorize'] {
  return async (actor: AssumeActor, targetRole?: string) => {
    try {
      const identity = resolveAgentIdentity(ctx);
      const principal = ctx.principal;
      if (!ctx.isSuperuser || ctx.gateBypass?.role !== true || ctx.gateBypass?.capability !== true ||
          !principal || principal.kind !== 'system' || principal.trust !== 'trusted' ||
          !principal.authMethod || !['bearer-token', 'spawn-url', 'process-internal'].includes(principal.authMethod) ||
          principal.workspaceId !== actor.workspaceId || identity.workspaceId !== actor.workspaceId ||
          identity.ownerId !== actor.ownerId || isTransportOnlyIdentity(identity.ownerId) ||
          principal.allowedTools && (!principal.allowedTools.has('session:assume') ||
            !principal.allowedTools.has('capability:launch-agent'))) return null;
      // Read restrictions before target context: preparation must not become a
      // way to inspect a reviewer's hidden conversation or frozen assignment.
      const [callerPolicy, targetPolicy, target] = await Promise.all([
        ports.confinement(actor.ownerId, actor.workspaceId),
        ports.confinement(request.targetOwnerId, actor.workspaceId),
        ports.resolve({ agentId: request.targetOwnerId }),
      ]);
      if (callerPolicy || targetPolicy || !target.ok || target.ownerId !== request.targetOwnerId ||
          target.workspaceId !== actor.workspaceId || targetRole !== undefined && (target.role ?? 'su') !== targetRole) return null;
      const reviewer = await ports.inspect({ workspaceId: actor.workspaceId,
        reviewerOwnerId: request.targetOwnerId, advSessionId: target.advSessionId });
      if (reviewer.binding || reviewer.recruiterLaunch || !await ports.envelope(ctx, request)) return null;
      // synthesizeTransportPrincipal deliberately gives superusers an empty
      // capability set; the host's explicit capability bypass is their grant.
      const proof = { actor, principal: { slug: principal.slug, kind: principal.kind,
        authMethod: principal.authMethod, trust: principal.trust,
        capabilities: [...principal.capabilities].sort(), allowedTools: principal.allowedTools ? [...principal.allowedTools].sort() : null },
        targetOwnerId: target.ownerId, targetRole: target.role ?? 'su', binding: target.binding };
      return `launch-envelope:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`;
    } catch { return null; }
  };
}

/** Read the existing signing secret without creating it: preview has no writes.
 * Missing/corrupt configuration is unavailable, never a new random token key. */
export async function createAssumePreparationDeps(
  ctx: UnifiedToolContext, request: AssumeRequest,
): Promise<AssumePreparationDeps> {
  const { sql } = getOrgPg();
  const [row] = await sql<Array<{ value_b64: string }>>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key' LIMIT 1
  `;
  if (!row) throw new Error('assume-signing-key-unavailable');
  return { now: Date.now, secret: decodeOperatorSecretKey(row.value_b64, 'spawn-signing-key'),
    authorize: createAssumeAuthorizer(ctx, request), caller: readAssumeCaller,
    target: value => readAssumeTarget(value, ctx.workspaceId ?? '') };
}

/** P-002 supplies the exact managed host port. This factory cannot fall back
 * to another window, an unguarded CLI or an environment-only identity change. */
export function createAssumeTransitionDeps(plan: AssumePreparation,
  host: AssumeCallerHostFence & Pick<AssumeTransitionDeps, 'handoff'>): AssumeTransitionDeps {
  return { now: Date.now, ...createAssumeReceiptStore(plan), ...createAssumeCustodyAdapters(plan),
    ...createAssumeCallerAdapters(host), handoff: (value, recovery) => host.handoff(value, recovery) };
}
