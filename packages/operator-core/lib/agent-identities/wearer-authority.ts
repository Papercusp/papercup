/**
 * The wearer authority shared by every host path that runs identity work as its
 * wearer (portable-identity-packages-2026-09-26 P-018; D-008, D-028, D-031):
 * async rule reactions, turn-start tool/recipe providers and template cell reads.
 *
 * A leaf on purpose: it imports no store and no dispatcher, so both the emit
 * path and the turn-start sink can load it statically.
 */
import { randomUUID } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { IdentityReactionCeiling } from '../capability-envelope/identity-grants-port';
import { PROTECTED_CAPABILITY_GLOBS, matchesAny } from '../capability-envelope/policy';

/**
 * The dispatcher role of a wearer whose launch record names none: an SU launch
 * record (`SuLaunchSpecRecord`) carries no `role`, and an SU session dispatches
 * as `su` — the same default the grant kernel applies (`ctx.role ?? 'su'`).
 * A record's `fleet.role` is fleet posture (leader/member), not a dispatcher role.
 */
export const SU_WEARER_ROLE = 'su';

/**
 * PURE (identity-system-everything-migration-2026-10-18 P-003, #D-017): the
 * dispatcher role identity work runs under for a wearer, read from the wearer's
 * identity-bearing launch record. A role launch (`bootstrap-role`) records the
 * role it launched, so a judge wearing an identity stack is judged against the
 * judge ceiling, never su's. A record without a role is an SU record.
 */
export function identityWearerRole(launchRecord: unknown): string {
  const role = launchRecord !== null && typeof launchRecord === 'object'
    ? (launchRecord as { role?: unknown }).role
    : undefined;
  return typeof role === 'string' && role.trim() ? role.trim() : SU_WEARER_ROLE;
}

/**
 * PURE (D-008): why the pot/role ceiling or the never-auto protected floor
 * refuses one capability, or null when both admit it. The floor applies
 * whatever the role: the role envelope exempts `su`, but identity work the
 * host runs for a wearer is automatic by definition.
 */
export function identityCeilingRefusal(
  capability: string,
  ceiling: Pick<IdentityReactionCeiling, 'ceilings' | 'protectedAdditions'>,
): string | null {
  if (matchesAny(capability, [...PROTECTED_CAPABILITY_GLOBS, ...ceiling.protectedAdditions])) {
    return `capability ${capability} is in the never-auto protected set`;
  }
  for (const envelope of ceiling.ceilings) {
    if (envelope.denyCapabilities && matchesAny(capability, envelope.denyCapabilities)) {
      return `capability ${capability} is denied by the pot/role ceiling`;
    }
    if (envelope.allowCapabilities && envelope.allowCapabilities.length > 0 &&
        !matchesAny(capability, envelope.allowCapabilities)) {
      return `capability ${capability} is outside the pot/role ceiling`;
    }
  }
  return null;
}

/**
 * PURE: the dispatcher context identity work runs under. The wearer is both
 * principal and coordination owner, so `resolveAgentIdentity` and the identity
 * grant kernel judge the wearer. There is no `gateBypass`: capability, role and
 * quota all apply, and quota is charged to the wearer: every dispatch gets its
 * own `runId`, so the window is the wearer's `quotaSubject` (D-032).
 */
export function wearerQuotaSubject(ownerId: string): string {
  return `wearer:${ownerId}`;
}

/** Grants = wearer ∩ declared needs ∩ pot/role ceiling; '*' in one set admits
 * whatever the others name. Shared by inspection and every wearer runtime. */
export function narrowIdentityCapabilities(
  wearer: ReadonlySet<string>, declaredNeeds: readonly string[], ceiling: ReadonlySet<string>,
): Set<string> {
  const sets = [wearer, new Set(declaredNeeds), ceiling];
  const candidates = new Set(sets.flatMap((set) => [...set]));
  return new Set([...candidates].filter((cap) => sets.every((set) => set.has(cap) || set.has('*'))));
}

type ValidatedWearerContext = UnifiedToolContext & {
  workspaceId: string;
  role: NonNullable<UnifiedToolContext['role']>;
  principal: NonNullable<UnifiedToolContext['principal']>;
};

/** Intersect current authority, declared needs and the live ceiling without
 * mutating the caller. Identity work always keeps normal gates and charges the
 * wearer across invocations, including template reads with fresh run ids. */
export function narrowWearerToolContext(input: {
  ownerId: string;
  context: UnifiedToolContext;
  declaredNeeds: readonly string[];
  capabilityCeiling: ReadonlySet<string>;
  signal: AbortSignal;
}): ValidatedWearerContext | null {
  const ctx = input.context;
  if (!input.ownerId || !ctx.principal || !ctx.workspaceId || !ctx.role ||
      ctx.principal.workspaceId !== ctx.workspaceId || input.signal.aborted || ctx.signal.aborted) return null;
  const capabilities = narrowIdentityCapabilities(
    ctx.principal.capabilities, input.declaredNeeds, input.capabilityCeiling,
  );
  return {
    ...ctx, gateBypass: undefined, isSuperuser: false,
    workspaceId: ctx.workspaceId, role: ctx.role,
    quotaSubject: wearerQuotaSubject(input.ownerId),
    signal: AbortSignal.any([input.signal, ctx.signal]),
    principal: { ...ctx.principal, capabilities },
  };
}

/** See {@link wearerQuotaSubject}. */
export function buildWearerToolContext(input: {
  workspaceId: string;
  ownerId: string;
  role: string;
  harnessSlug: string;
  capabilities: Iterable<string>;
  spawnId: string;
  signal?: AbortSignal;
}): UnifiedToolContext {
  return {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    role: input.role,
    featureId: null,
    chunkId: null,
    runId: randomUUID(),
    spawnId: input.spawnId,
    parentSpawnId: null,
    uiClientId: input.ownerId,
    quotaSubject: wearerQuotaSubject(input.ownerId),
    isSuperuser: false,
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: input.signal ?? new AbortController().signal,
    principal: {
      slug: input.ownerId,
      workspaceId: input.workspaceId,
      capabilities: new Set(input.capabilities),
    },
  };
}
