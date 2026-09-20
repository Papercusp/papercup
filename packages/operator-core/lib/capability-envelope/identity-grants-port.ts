/**
 * P-005: identity grants narrow the existing role envelope at the shared kernel
 * seat. Receipts come from the control anchor/launch record, never tool args.
 * Mutable policy is read again for every preflight AND enforce invocation.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  loadBlueprintFromFile,
  layerSourceDocument,
  BlueprintSourceDocumentSchema,
  replayAgentSpecification,
  type ResolvedAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import {
  listAllProjectedTools,
  resolveMcpName,
  type KernelContextState,
  type KernelEnforcementRequest,
  type KernelEnforcementResult,
  type KernelExecutionRevision,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  getPotCapabilityProviderBinding,
  parseCapabilityClassRef,
  type PotCapabilityProviderBindingRow,
} from '../capability-class-registry-store';
import type { CapabilityEnvelopeOverrides } from '../capability-envelope-overrides';
import type { HarnessRegistry } from '../harness-registry';
import { readOperatorState } from '../operator-state-pg';
import { systemDistinctId } from '../flag-distinct-id';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { potSlugsForHarnesses } from '../memory/hive-scope';
import { identityGrantToolFailure, resolveIdentityGrantEnvelope, type IdentityGrantFailure } from './blueprint-envelopes';
import { ROLE_ENVELOPES, type RoleEnvelope } from './policy';
import type { CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';

export interface IdentityGrantPolicy {
  policyRevision: string;
  potSlug: string;
  bindings: readonly PotCapabilityProviderBindingRow[];
  ceilings: readonly RoleEnvelope[];
  tools: ReadonlyMap<string, readonly string[]>;
  protectedAdditions: readonly string[];
}

interface PolicyInput {
  workspaceId: string;
  harnessSlug: string;
  role?: string;
  classRefs: readonly string[];
}

type PolicyReader = (input: PolicyInput) => Promise<IdentityGrantPolicy>;

interface IdentityGrantKernelState extends KernelContextState {
  /** Set only when the control anchor's adv_sessions join found no row. */
  identityLaunchRecordMissing?: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Exact receipt selection; do not select a newer desired artifact for execution. */
export function appliedIdentityArtifact(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
): ResolvedAgentSpecification | null {
  const record = object(raw);
  if (!record || !revision) return null;
  const receipts = [record, ...(Array.isArray(record.identityHistory) ? record.identityHistory : [])];
  const receipt = receipts.map(object).find((entry) =>
    entry?.specificationRevision === revision.specificationRevision &&
    entry?.stateRevision === revision.stateRevision);
  if (!receipt?.specificationArtifact) return null;
  const artifact = replayAgentSpecification(receipt.specificationArtifact);
  return artifact.specificationRevision === revision.specificationRevision ? artifact : null;
}

/** Reads existing stores; missing or failed policy reads must reach the caller. */
export const readIdentityGrantPolicy: PolicyReader = async (input) => {
  const registry = await readOperatorState<HarnessRegistry>('harness_registry', input.workspaceId, { fresh: true });
  const harness = registry?.projects.find((entry) => entry.slug === input.harnessSlug);
  if (!harness || !registry) throw new Error('identity harness is not registered');
  const potSlug = potSlugsForHarnesses(registry.projects, [harness.slug])[0] ?? harness.slug;
  const pot = registry.projects.find((entry) => entry.slug === potSlug);
  if (!pot) throw new Error('identity pot is not registered');
  // This is the current administrator-selected POT, not the installed identity.
  // Bypass blueprintRoleEnvelopes' best-effort mtime cache on this authority read.
  const loaded = loadBlueprintFromFile(join(pot.path, '.papercusp', 'blueprint.yaml'),
    operatorResolveExtends({ localDirs: [join(pot.path, '.papercusp', 'blueprints')] }));
  const ownLayer = loaded.layers.at(-1);
  if (!ownLayer) throw new Error('administrator pot source is unavailable');
  // A remote identity can contribute worker-role configuration too. Its
  // inherited value cannot count as independent administrator authorization.
  const ownSource = BlueprintSourceDocumentSchema.parse(layerSourceDocument(ownLayer));
  const roles = ownSource.fleet?.workerRoles ?? [];
  // A library install may omit a role only for an unambiguous single-role pot.
  // The installed package never supplies the administrator role selection.
  const role = input.role ?? (roles.length === 1 ? roles[0].id : null);
  if (!role) throw new Error('identity grant target role is ambiguous');
  const potRole = roles.find((entry) => entry.id === role);
  if (potRole?.capabilities === undefined) throw new Error('administrator pot has no explicit role capability ceiling');
  const overridesEnabled = await getFlag(FLAGS.CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId());
  const overrides = overridesEnabled
    ? await readOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes', input.workspaceId, { fresh: true }) ?? {}
    : {};
  const ceilings: RoleEnvelope[] = [overrides.roleEnvelopes?.[role] ?? ROLE_ENVELOPES[role] ?? {}];
  ceilings.push({ allowCapabilities: potRole.capabilities });
  const bindings: PotCapabilityProviderBindingRow[] = [];
  for (const classRef of input.classRefs) {
    const parsed = parseCapabilityClassRef(classRef);
    if (!parsed) throw new Error(`invalid capability class ${classRef}`);
    const binding = await getPotCapabilityProviderBinding(getOrgPg().sql, {
      workspaceId: input.workspaceId, potSlug, classId: parsed.id, classVersion: parsed.version,
    });
    if (binding) bindings.push(binding);
  }
  const tools = new Map<string, readonly string[]>();
  for (const tool of listAllProjectedTools()) {
    if (tool.expose.mcp) tools.set(tool.expose.mcp.name, tool.capabilities);
  }
  const protectedAdditions = overrides.protectedAdditions ?? [];
  const policyRevision = createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId, potSlug, ceilings, protectedAdditions,
    bindings, tools: [...tools].sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
  return { policyRevision, potSlug, bindings, ceilings, tools, protectedAdditions };
};

/** Validate resolved choices BEFORE installing packages or writing pot bindings. */
export async function validateIdentityInstallGrants(
  input: {
    workspaceId: string;
    potSlug: string;
    role?: string;
    resolution: CapabilityGrantResolutionVerdict;
  },
  readPolicy: PolicyReader = readIdentityGrantPolicy,
): Promise<readonly IdentityGrantFailure[]> {
  const failure = (cause: IdentityGrantFailure['cause'], classRef: string | null, toolName?: string): IdentityGrantFailure => ({
    code: 'capability_unsatisfied', cause, classRef, ...(toolName ? { toolName } : {}),
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
  });
  const classRefs = input.resolution.requirements.map((entry) => entry.classRef);
  if (!input.resolution.ok) return [failure('provider-unbound', classRefs[0] ?? null)];
  let policy: IdentityGrantPolicy;
  try {
    policy = await readPolicy({
      workspaceId: input.workspaceId, harnessSlug: input.potSlug, role: input.role, classRefs,
    });
  } catch {
    return [failure('policy-unavailable', classRefs[0] ?? null)];
  }
  if (policy.potSlug !== input.potSlug || !policy.policyRevision || !policy.ceilings.length) {
    return [failure('policy-unavailable', classRefs[0] ?? null)];
  }
  const failures: IdentityGrantFailure[] = [];
  for (const requirement of input.resolution.requirements) {
    if (requirement.optional && requirement.state === 'absent') continue;
    const selected = requirement.selection;
    const provider = requirement.binding ?? requirement.candidates?.find((candidate) =>
      candidate.providerPackage === selected?.providerPackage && candidate.providerVersion === selected?.providerVersion);
    if (!provider || provider.classRef !== requirement.classRef || provider.status !== 'active' ||
        provider.conformanceStatus !== 'passed') {
      failures.push(failure('provider-unbound', requirement.classRef));
      continue;
    }
    const current = policy.bindings.find((binding) => binding.classRef === requirement.classRef);
    if (requirement.binding && (!current ||
        current.providerPackage !== provider.providerPackage || current.providerVersion !== provider.providerVersion ||
        current.conformanceRunId !== provider.conformanceRunId || current.registryRevision !== provider.registryRevision ||
        Object.keys(current.verbBindings).length !== Object.keys(provider.verbBindings).length ||
        Object.entries(current.verbBindings).some(([verb, name]) => provider.verbBindings[verb] !== name))) {
      failures.push(failure('provider-changed', requirement.classRef));
      continue;
    }
    if (!requirement.binding && current) {
      failures.push(failure('provider-changed', requirement.classRef));
      continue;
    }
    for (const toolName of new Set(Object.values(provider.verbBindings))) {
      const cause = identityGrantToolFailure({ ...policy, toolName });
      if (cause) failures.push(failure(cause, requirement.classRef, toolName));
    }
  }
  return failures;
}

function denial(
  cause: IdentityGrantFailure['cause'],
  classRef: string | null,
  toolName: string,
  policyRevision?: string | null,
): KernelEnforcementResult {
  const failure: IdentityGrantFailure = {
    code: 'capability_unsatisfied', cause, classRef, toolName,
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
  };
  return {
    decision: 'deny', availability: 'available', applied: true,
    code: failure.code,
    reason: `Identity capability ${classRef ?? '(unresolved)'}: ${cause} (${toolName})`,
    policyRevision,
    obligations: { capabilityUnsatisfied: failure },
  };
}

/**
 * The identity plane's resync verb. `coord:orient({ afterCompaction: true })` is
 * the only caller of acknowledgeControlTransition (agent-tools/coordination/
 * tools/orient.ts), so it is the one verb that can converge a stranded
 * activation from inside the session that is stranded.
 */
const IDENTITY_RECOVERY_TOOL = 'coord:orient';

/**
 * WI-10002028: of every cause this port can raise, `stale-artifact` is the one
 * that is NOT a statement about the session's authority — it says the identity
 * plane cannot establish WHICH specification is in force. Refusing
 * {@link IDENTITY_RECOVERY_TOOL} on that basis makes the failure self-sealing:
 * every tool is denied, including the door the CTRL block's own `resync`
 * contract names, and BOTH documented toolless fallbacks reach this same
 * server-side preflight (scripts/mcp-call.mjs is a different transport, not a
 * different gate), so changing client, port or transport cannot open it.
 * Recovery then required an out-of-band sudo psql write.
 *
 * A recovery door must not ride the failure domain it recovers. This is not a
 * widening: the no-launch-record door above already admits the same verb on
 * strictly LESS identity evidence, so anyone able to corrupt a record into this
 * state could instead delete it and take the weaker door — gating on artifact
 * integrity protected nothing while bricking honest sessions. `applied: false`
 * confers no grants, so nothing reachable through this door can escalate, and
 * every other cause (outside-ceiling, policy-unavailable, a real capability
 * failure) still denies normally.
 */
function staleArtifact(
  request: KernelEnforcementRequest,
  toolName: string = request.toolName,
  policyRevision?: string | null,
): KernelEnforcementResult {
  if (request.toolName === IDENTITY_RECOVERY_TOOL || toolName === IDENTITY_RECOVERY_TOOL) {
    return {
      decision: 'allow',
      availability: 'available',
      applied: false,
      code: 'identity-recovery',
      reason: `identity artifact is unresolved; ${IDENTITY_RECOVERY_TOOL} is the recovery door`,
      ...(policyRevision !== undefined && policyRevision !== null ? { policyRevision } : {}),
    };
  }
  return denial('stale-artifact', null, toolName, policyRevision);
}

export async function checkIdentityGrantKernel(
  request: KernelEnforcementRequest,
  state: IdentityGrantKernelState,
  rawRecord: unknown,
  readPolicy: PolicyReader = readIdentityGrantPolicy,
): Promise<KernelEnforcementResult | null> {
  const record = object(rawRecord);
  const applied = state.activation?.applied ?? state.appliedRevision;
  // No launch artifact is the legacy, non-opted-in path. An acknowledged
  // identity with a missing receipt is not legacy: fail closed.
  if (!record) {
    if (state.identityLaunchRecordMissing) {
      // coord:orient is the recovery verb named by the CTRL block. It is the
      // only tool allowed to run without the launch record; every other tool
      // receives a distinct diagnosis so operators do not chase a revision
      // mismatch that never existed.
      if (request.toolName === 'coord:orient') {
        return {
          decision: 'allow',
          availability: 'available',
          applied: false,
          code: 'identity-recovery',
          reason: 'identity launch record is missing; coord:orient is the recovery door',
          ...(state.policyRevision !== undefined ? { policyRevision: state.policyRevision } : {}),
        };
      }
      return denial('no-launch-record', null, request.toolName, state.policyRevision);
    }
    return applied ? staleArtifact(request) : null;
  }
  let artifact: ResolvedAgentSpecification | null;
  let current: ResolvedAgentSpecification | null;
  try {
    artifact = appliedIdentityArtifact(record, applied);
    current = record.specificationArtifact ? replayAgentSpecification(record.specificationArtifact) : null;
    if (current && current.specificationRevision !== record.specificationRevision) {
      return staleArtifact(request);
    }
  } catch {
    return staleArtifact(request);
  }
  // A control-only activation (e.g. re-registering an already-active mode)
  // advances the applied STATE revision without re-rendering the launch
  // artifact, so no receipt can ever carry the new stateRevision and the
  // session would be denied every tool for the rest of its life
  // (EI-23431478594488191). The immutable specification — and therefore
  // configuration.grants — is unchanged in that case, so the record's current
  // artifact IS the applied specification.
  //
  // WI-10002005: this deliberately does NOT require the pending activation to
  // have reached status 'applied'. A pending activation is a request about the
  // session's FUTURE authority; it must never RETRACT authority the host has
  // already acknowledged. Requiring 'applied' here did exactly that, and the
  // resulting denial is total and self-sealing: a `relaunch-with-carry` stack
  // mutation makes turn-start skip both markControlTransitionPrepared and
  // acknowledgeControlTransition (stack-binding-channel.ts sets
  // requiresFreshContext), leaving prepared:null/status:'desired' with no
  // throw and no failure record, and acknowledgeControlTransition's own WHERE
  // clause requires prepared = desired — so the row can never converge and
  // EVERY tool is refused for the life of the session, including the
  // coord:orient recovery door.
  //
  // The conjunct that actually enforces fail-closed is the specification
  // equality below, NOT the status: configuration.grants is a property of the
  // immutable specification, so a pending BROADENING necessarily carries a
  // different specificationRevision and still falls through to denial. What is
  // admitted here is only the case where the record's current specification is
  // byte-identical to the one already acknowledged in `applied` — i.e. where
  // granting changes nothing about the authority in force. Narrowing is
  // likewise unaffected: the loop below intersects `artifact` with `current`,
  // so any reduction expressed in the current specification still binds.
  if (
    !artifact && current && applied &&
    current.specificationRevision === applied.specificationRevision
  ) {
    artifact = current;
  }
  if (!artifact) {
    return applied || current?.configuration.grants
      ? staleArtifact(request) : null;
  }
  if (!artifact.configuration.grants && !current?.configuration.grants) return null;
  // A removal or a new narrowing cannot wait for successful prompt delivery.
  // Never let a prepared broadening supply authority missing from the receipt.
  if (!artifact.configuration.grants || !current?.configuration.grants) {
    return staleArtifact(request);
  }
  const workspaceId = request.ctx.workspaceId ?? request.ctx.principal?.workspaceId;
  if (record.workspaceId !== workspaceId ||
      typeof record.harnessSlug !== 'string' || !record.harnessSlug) {
    return denial('policy-unavailable', null, request.toolName);
  }
  const classRefs = [...new Set([artifact, current].flatMap((specification) => [
    ...(specification.configuration.grants?.requires ?? []),
    ...(specification.configuration.grants?.optional ?? []),
  ]))].sort();
  let policy: IdentityGrantPolicy;
  try {
    policy = await readPolicy({
      workspaceId: record.workspaceId as string, harnessSlug: record.harnessSlug,
      role: request.ctx.role ?? 'su', classRefs,
    });
  } catch {
    return denial('policy-unavailable', classRefs[0] ?? null, request.toolName);
  }
  const toolName = resolveMcpName(request.toolName)?.expose.mcp?.name ?? request.toolName;
  for (const specification of [artifact, current]) {
    const envelope = resolveIdentityGrantEnvelope({
      specification, appliedSpecificationRevision: specification.specificationRevision, ...policy,
    });
    if (!envelope.applied) return staleArtifact(request, toolName, policy.policyRevision);
    const failure = envelope.failures[0];
    if (failure) return denial(failure.cause, failure.classRef, toolName, policy.policyRevision);
    if (!envelope.allowedTools.includes(toolName)) {
      return denial('outside-ceiling', classRefs[0] ?? null, toolName, policy.policyRevision);
    }
  }
  return {
    decision: 'allow', availability: 'available', applied: true,
    policyRevision: policy.policyRevision, executionRevision: applied, revisionSource: 'applied',
  };
}
