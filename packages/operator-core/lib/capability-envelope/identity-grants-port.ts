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
import { pinModuleState } from '@papercusp/module-singleton';
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
// The door's identity lives in a module with no imports, so the kernel resolver's
// catch can reach it when THIS module is what failed to load. Importing the same
// constants here keeps one source of truth rather than a second copy to drift.
import { RECOVERY_DOOR_TOOL, RECOVERY_DOOR_DISPATCH_WRAPPER, isRecoveryDoorCall } from './recovery-door';
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
  /** Database-owned row identity/version, never supplied by the tool caller. */
  identityLaunchRecordVersion?: { sessionId: string; rowVersion: string };
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

/**
 * The verdict `checkIdentityGrantKernel` reaches about a launch record, as a
 * value instead of a control-flow side effect.
 *
 * WI-10002060 — WHY THIS IS EXTRACTED. A standing sweep has to find sessions
 * this gate would wedge, and the obvious way to write one is a jsonb predicate
 * comparing `control_state->activation->applied` with `launch_spec`. Every
 * attempt at that has been wrong IN BOTH DIRECTIONS, because the gate's
 * question is not a revision comparison:
 *   - `appliedIdentityArtifact` above searches `record` AND `record
 *     .identityHistory` for a receipt matching BOTH revisions, so a record
 *     whose top-level revision differs can still resolve. SQL that compares
 *     only the top level over-reports it as wedged.
 *   - the `current`-fallback below admits a case no jsonb predicate expresses
 *     at all.
 * So the detector imports THIS, and the gate below is its only other caller.
 * Keep it that way: a second paraphrase of this decision is the defect.
 */
export type IdentityArtifactResolution =
  | {
      kind: 'stale-artifact';
      reason: 'replay-failed' | 'record-revision-mismatch' | 'receipt-missing' | 'grants-asymmetric';
    }
  | { kind: 'ungoverned' }
  | { kind: 'governed'; artifact: ResolvedAgentSpecification; current: ResolvedAgentSpecification };

export function resolveIdentityArtifact(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
): IdentityArtifactResolution {
  let artifact: ResolvedAgentSpecification | null;
  let current: ResolvedAgentSpecification | null;
  try {
    artifact = appliedIdentityArtifact(record, applied);
    current = record.specificationArtifact ? replayAgentSpecification(record.specificationArtifact) : null;
    if (current && current.specificationRevision !== record.specificationRevision) {
      return { kind: 'stale-artifact', reason: 'record-revision-mismatch' };
    }
  } catch {
    return { kind: 'stale-artifact', reason: 'replay-failed' };
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
  // likewise unaffected: the caller intersects `artifact` with `current`,
  // so any reduction expressed in the current specification still binds.
  if (
    !artifact && current && applied &&
    current.specificationRevision === applied.specificationRevision
  ) {
    artifact = current;
  }
  if (!artifact) {
    return applied || current?.configuration.grants
      ? { kind: 'stale-artifact', reason: 'receipt-missing' }
      : { kind: 'ungoverned' };
  }
  if (!artifact.configuration.grants && !current?.configuration.grants) return { kind: 'ungoverned' };
  // A removal or a new narrowing cannot wait for successful prompt delivery.
  // Never let a prepared broadening supply authority missing from the receipt.
  if (!artifact.configuration.grants || !current?.configuration.grants) {
    return { kind: 'stale-artifact', reason: 'grants-asymmetric' };
  }
  return { kind: 'governed', artifact, current };
}

// Replay verifies every package byte and canonical-hashes the full saved
// specification. The launch record is immutable between PostgreSQL row
// versions, so repeating that synchronous work at every tool preflight and
// dispatch stalls the operator event loop. PostgreSQL changes xmin on an
// UPDATE; the applied pair is a separate control-state input and belongs in
// the key as well. Policy is deliberately NOT cached here.
const IDENTITY_RESOLUTION_CACHE_TTL_MS = 5 * 60_000;
const IDENTITY_RESOLUTION_CACHE_MAX = 128;
const identityResolutionCache = pinModuleState('@papercusp/operator-core.identity-resolution-cache', () =>
  new Map<string, { validatedAt: number; resolution: IdentityArtifactResolution }>(),
);

function resolveIdentityArtifactForKernel(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityArtifactResolution {
  // Callers without a database-owned version retain the original replay path.
  if (!version?.sessionId || !version.rowVersion) return resolveIdentityArtifact(record, applied);
  const key = JSON.stringify([
    version.sessionId, version.rowVersion, record.workspaceId, record.harnessSlug,
    applied?.specificationRevision ?? null, applied?.stateRevision ?? null,
  ]);
  const now = Date.now();
  const cached = identityResolutionCache.get(key);
  if (cached && now - cached.validatedAt < IDENTITY_RESOLUTION_CACHE_TTL_MS) {
    identityResolutionCache.delete(key);
    identityResolutionCache.set(key, cached);
    return cached.resolution;
  }
  const resolution = resolveIdentityArtifact(record, applied);
  identityResolutionCache.delete(key);
  identityResolutionCache.set(key, { validatedAt: now, resolution });
  while (identityResolutionCache.size > IDENTITY_RESOLUTION_CACHE_MAX) {
    const oldest = identityResolutionCache.keys().next().value;
    if (oldest === undefined) break;
    identityResolutionCache.delete(oldest);
  }
  return resolution;
}

/**
 * May `revision` be ACKNOWLEDGED as the session's `applied` identity, given the
 * launch record the kernel selects for it? (EI-23703586803892464 /
 * EI-23886889674609842.)
 *
 * `acknowledgeControlTransition` is the only writer of `activation.applied`, and
 * it used to write `desired` whenever `prepared` matched — without asking whether
 * the record this gate judges could resolve it. When a sibling launch record
 * minted `desired` but the gate selected a different, live row, the
 * acknowledgement itself manufactured a `stale-artifact` denial of every tool,
 * the coord:orient recovery door included.
 *
 * The answer is this gate's own, not a revision comparison (see WI-10002060
 * above): an absent or malformed record cannot carry an acknowledged identity,
 * and otherwise anything short of `stale-artifact` is admissible.
 */
export function launchRecordAdmitsApplied(
  rawRecord: unknown,
  revision: KernelExecutionRevision,
): boolean {
  const record = object(rawRecord);
  if (!record) return false;
  return resolveIdentityArtifact(record, revision).kind !== 'stale-artifact';
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
const IDENTITY_RECOVERY_TOOL = RECOVERY_DOOR_TOOL;

/**
 * EI-23745120264597384: this gate's BREAK-GLASS contract, declared in code so a
 * test can enforce it instead of a reviewer having to notice.
 *
 * `causes` is the subset of {@link IdentityGrantFailure.cause} that is
 * SELF-SEALING. Each one means the identity plane cannot establish WHICH
 * specification is in force — precisely the condition
 * {@link IDENTITY_RECOVERY_TOOL} exists to clear. Denying the recovery verb
 * under one of them strands the session in the exact state it has a documented
 * cure for, and because both documented toolless fallbacks reach this same
 * server-side preflight, no change of client, port or transport can reopen it.
 *
 * Every OTHER cause is either a statement about authority (`outside-ceiling`,
 * `tool-unavailable`, `provider-*`) or about transient infrastructure
 * (`policy-unavailable`). Those are correct to enforce against every verb,
 * this one included: honouring a ceiling that genuinely excludes the recovery
 * verb is not self-sealing, because running the recovery verb would not clear
 * it. Keeping the set narrow is what makes this a door and not a hole.
 *
 * Enforced at a single chokepoint ({@link denyUnlessRecoveryDoor}) so adding a
 * cause here protects EVERY denial site at once; the companion test asserts the
 * implication across all of them rather than a hand-listed few.
 */
export const IDENTITY_BREAK_GLASS: {
  readonly tool: string;
  readonly causes: readonly IdentityGrantFailure['cause'][];
  /**
   * The single-target dispatch wrapper that forwards ONE named tool server-side.
   *
   * WI-10002028 shipped the door keyed on the tool name alone, and it could not
   * open on the path that actually bricks sessions: a TRIMMED su surface does not
   * carry {@link IDENTITY_RECOVERY_TOOL} in its seed, so the only way to reach the
   * recovery door is `tools:invoke { name: 'coord:orient' }`. The gate then sees
   * `tools:invoke`, the name comparison fails, and the door stays shut — measured
   * live 2026-09-20T10:43Z by su-56d0a9bd, whose own fix could not save them.
   *
   * Admitting the wrapper confers NOTHING on its own: `tools:invoke` forwards
   * through `ctx.dispatchTool`, so the inner tool runs its own full kernel
   * preflight and is gated exactly as a direct call. The outer denial therefore
   * protected nothing while making the brick permanent.
   */
  readonly dispatchWrapper: string;
} = {
  tool: IDENTITY_RECOVERY_TOOL,
  causes: ['stale-artifact', 'no-launch-record'],
  dispatchWrapper: RECOVERY_DOOR_DISPATCH_WRAPPER,
};

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
  return denyUnlessRecoveryDoor(request, 'stale-artifact', null, toolName, policyRevision);
}

/**
 * The one place this gate turns a cause into a denial.
 *
 * Routing EVERY denial site through here is the point: the recovery door used
 * to be opened by an explicit check sitting next to two of the six sites, which
 * left the others free to emit a self-sealing cause with the door shut. That is
 * not hypothetical — `denial(failure.cause, …)` on the envelope path forwards a
 * cause chosen at runtime, and {@link IdentityGrantFailure.cause} includes both
 * break-glass causes, so a producer returning one there bricked the session
 * while every hand-written test still passed. Centralising the decision means
 * the guarantee is a property of the gate rather than of whoever last added a
 * return statement.
 *
 * Authority is untouched: the door confers `applied: false` (no grants), and a
 * cause outside {@link IDENTITY_BREAK_GLASS.causes} still denies the recovery
 * verb exactly as before. Non-recovery tools keep their distinct diagnosis, so
 * operators are not sent chasing a revision mismatch that never existed.
 */
function denyUnlessRecoveryDoor(
  request: KernelEnforcementRequest,
  cause: IdentityGrantFailure['cause'],
  classRef: string | null,
  toolName: string = request.toolName,
  policyRevision?: string | null,
): KernelEnforcementResult {
  // Both the request's own name and the resolved MCP name are checked, and each
  // through the shared predicate — so the door opens whether the verb is named
  // directly or carried as the declared target of the single-target dispatch
  // wrapper. The wrapper route is not an edge case: on a TRIMMED surface it is
  // the ONLY route an affected session has to the door.
  const isRecoveryVerb =
    isRecoveryDoorCall(request.toolName, request.args) ||
    isRecoveryDoorCall(toolName, request.args);
  if (isRecoveryVerb && IDENTITY_BREAK_GLASS.causes.includes(cause)) {
    const diagnosis = cause === 'no-launch-record'
      ? 'identity launch record is missing'
      : 'identity artifact is unresolved';
    return {
      decision: 'allow',
      availability: 'available',
      applied: false,
      code: 'identity-recovery',
      reason: `${diagnosis}; ${IDENTITY_BREAK_GLASS.tool} is the recovery door`,
      ...(policyRevision !== undefined && policyRevision !== null ? { policyRevision } : {}),
    };
  }
  return denial(cause, classRef, toolName, policyRevision);
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
      return denyUnlessRecoveryDoor(
        request, 'no-launch-record', null, request.toolName, state.policyRevision,
      );
    }
    return applied ? staleArtifact(request) : null;
  }
  // The decision itself lives in `resolveIdentityArtifact` (above) so the
  // WI-10002060 sweep can ask the same question instead of paraphrasing it.
  // This call site is behaviour-identical to the body it replaced.
  const resolution = resolveIdentityArtifactForKernel(record, applied, state.identityLaunchRecordVersion);
  if (resolution.kind === 'stale-artifact') return staleArtifact(request);
  if (resolution.kind === 'ungoverned') return null;
  const { artifact, current } = resolution;
  const workspaceId = request.ctx.workspaceId ?? request.ctx.principal?.workspaceId;
  if (record.workspaceId !== workspaceId ||
      typeof record.harnessSlug !== 'string' || !record.harnessSlug) {
    return denyUnlessRecoveryDoor(request, 'policy-unavailable', null, request.toolName);
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
    return denyUnlessRecoveryDoor(
      request, 'policy-unavailable', classRefs[0] ?? null, request.toolName,
    );
  }
  const toolName = resolveMcpName(request.toolName)?.expose.mcp?.name ?? request.toolName;
  for (const specification of [artifact, current]) {
    const envelope = resolveIdentityGrantEnvelope({
      specification, appliedSpecificationRevision: specification.specificationRevision, ...policy,
    });
    if (!envelope.applied) return staleArtifact(request, toolName, policy.policyRevision);
    const failure = envelope.failures[0];
    // The runtime-chosen cause: `IdentityGrantFailure['cause']` spans both
    // break-glass causes, so this site can emit one. It must consult the
    // contract rather than deny unconditionally.
    if (failure) {
      return denyUnlessRecoveryDoor(
        request, failure.cause, failure.classRef, toolName, policy.policyRevision,
      );
    }
    if (!envelope.allowedTools.includes(toolName)) {
      return denyUnlessRecoveryDoor(
        request, 'outside-ceiling', classRefs[0] ?? null, toolName, policy.policyRevision,
      );
    }
  }
  return {
    decision: 'allow', availability: 'available', applied: true,
    policyRevision: policy.policyRevision, executionRevision: applied, revisionSource: 'applied',
  };
}
