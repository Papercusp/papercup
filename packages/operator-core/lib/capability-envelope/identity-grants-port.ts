/**
 * P-005: identity grants narrow the existing role envelope at the shared kernel
 * seat. Receipts come from the control anchor/launch record, never tool args.
 * Mutable policy is read again for every preflight AND enforce invocation.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import {
  loadBlueprintFromFile,
  layerSourceDocument,
  BlueprintSourceDocumentSchema,
  replayAgentSpecification,
  layerContentHash,
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
import { operatorResolveExtends, readBlueprintSourcePopulation } from '../blueprint/installed-blueprints';
import { potSlugsForHarnesses } from '../memory/hive-scope';
import { identityGrantToolFailure, resolveIdentityGrantEnvelope, type IdentityGrantFailure } from './blueprint-envelopes';
import { ROLE_ENVELOPES, type RoleEnvelope } from './policy';
import {
  identityRefusalContract, renderRefusalContract, shortRevision, type RefusalObservation,
} from './identity-refusal-contract';
// The door's identity lives in a module with no imports, so the kernel resolver's
// catch can reach it when THIS module is what failed to load. Importing the same
// constants here keeps one source of truth rather than a second copy to drift.
import { RECOVERY_DOOR_TOOL, RECOVERY_DOOR_DISPATCH_WRAPPER, isRecoveryDoorCall } from './recovery-door';
import { isLazyIdentityLaunchRecord } from './lazy-launch-record';
import type { CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';
import { grantProviderToolReach } from '../agent-identities/grant-provider-kinds';
import { isHookReleasedOperationContinuationCall } from '../released-operation-continuation-door';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { identityWearerRole } from '../agent-identities/wearer-authority';
import { narrowedLaunchSpecToAppliedPairSql } from './identity-receipt-narrowing';

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
  /** A fresh policy read is not a lease over its independently mutable sources. */
  pinForEffect?: boolean;
}

type PolicyReader = (input: PolicyInput) => Promise<IdentityGrantPolicy>;

const HOST_POLICY_EFFECT_PROTECTION_UNAVAILABLE = 'identity host policy effect protection is unavailable';

interface IdentityGrantKernelState extends KernelContextState {
  /** Set only when the control anchor's adv_sessions join found no row. */
  identityLaunchRecordMissing?: boolean;
  /** Database-owned row identity/version, never supplied by the tool caller. */
  identityLaunchRecordVersion?: { sessionId: string; rowVersion: string };
  /** Server-resolved coordination owner; never taken from a tool argument. */
  operationOwnerId?: string;
}

interface OperationEffectClaim {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  ownerId: string | null;
  advSessionId: string | null;
  acceptedOperation: Record<string, unknown>;
}

type OperationEffectClaimReader = (claim: OperationEffectClaim) => Promise<boolean>;

export async function readCurrentOperationEffectClaim(claim: OperationEffectClaim): Promise<boolean> {
  if (!claim.ownerId || !claim.advSessionId) return false;
  const { readActiveOperationWorkerClaimBinding, operationWorkerEffectWhereSql } =
    await import('../blueprint/operation-worker-binding');
  const read = await readActiveOperationWorkerClaimBinding(claim.workspaceId, claim.ownerId);
  if (read.status !== 'bound' || read.binding.harnessSlug !== claim.harnessSlug ||
      String(read.receipt.sessionId) !== claim.advSessionId ||
      !isDeepStrictEqual(read.receipt.acceptedOperation, claim.acceptedOperation)) return false;
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM harness_shared.work_items AS wi
     WHERE wi.workspace_id = ${claim.workspaceId}
       AND wi.feature_id = ${claim.workItemId}
       AND wi.harness_slug = ${read.binding.storageHarnessSlug}
       AND ${operationWorkerEffectWhereSql(sql, read, {
         payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug', holder: 'wi.taken_by',
       })}
     LIMIT 1`;
  return rows.length > 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * The receipt for one revision pair: the FIRST of `[record, ...identityHistory]`
 * matching both revisions. A body read narrowed to that pair
 * (identity-receipt-narrowing.ts, WI-10004801) must select the identical entry.
 */
export function selectAppliedReceipt(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
): Record<string, unknown> | null {
  const record = object(raw);
  if (!record || !revision) return null;
  const receipts = [record, ...(Array.isArray(record.identityHistory) ? record.identityHistory : [])];
  return receipts.map(object).find((entry) =>
    entry?.specificationRevision === revision.specificationRevision &&
    entry?.stateRevision === revision.stateRevision) ?? null;
}

/** Exact receipt selection; do not select a newer desired artifact for execution. */
export function appliedIdentityArtifact(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
  replay: (value: unknown) => ResolvedAgentSpecification = replayAgentSpecification,
): ResolvedAgentSpecification | null {
  const receipt = selectAppliedReceipt(raw, revision);
  if (!revision || !receipt?.specificationArtifact) return null;
  const artifact = replay(receipt.specificationArtifact);
  return artifact.specificationRevision === revision.specificationRevision ? artifact : null;
}

/**
 * The applied artifact, admitting the one case `resolveIdentityArtifact` below
 * also admits: a control-only activation advanced the applied STATE revision
 * without re-rendering, so no receipt carries it, while the record's current
 * specification IS the applied one (EI-23431478594488191). Readers of worn
 * content (rule pins) need the artifact itself, which that verdict omits for an
 * ungoverned identity, so they share this instead of re-deriving the fallback.
 */
export function appliedOrCurrentIdentityArtifact(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
): ResolvedAgentSpecification | null {
  const artifact = appliedIdentityArtifact(raw, revision);
  if (artifact || !revision) return artifact;
  const record = object(raw);
  if (!record?.specificationArtifact || record.specificationRevision !== revision.specificationRevision) return null;
  const current = replayAgentSpecification(record.specificationArtifact);
  return current.specificationRevision === revision.specificationRevision ? current : null;
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
  replay: (value: unknown) => ResolvedAgentSpecification = replayAgentSpecification,
): IdentityArtifactResolution {
  // WI-10008237: when the applied receipt IS the record (no transition in
  // flight — the common case), both replays below receive the SAME artifact
  // object, and replay is a pure function of it. Replaying it once halves the
  // canonical-hash work per resolution (the wedged sweep spent 44% of a bg-host
  // main-thread window here). Only a successful replay is remembered; a throw
  // propagates exactly as before. Sharing the result is already the contract:
  // the fallback below assigns `artifact = current`.
  const replayed = new Map<unknown, ResolvedAgentSpecification>();
  const replayOnce = (value: unknown): ResolvedAgentSpecification => {
    let spec = replayed.get(value);
    if (!spec) {
      spec = replay(value);
      replayed.set(value, spec);
    }
    return spec;
  };
  let artifact: ResolvedAgentSpecification | null;
  let current: ResolvedAgentSpecification | null;
  try {
    artifact = appliedIdentityArtifact(record, applied, replayOnce);
    current = record.specificationArtifact ? replayOnce(record.specificationArtifact) : null;
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
export const IDENTITY_RESOLUTION_CACHE_TTL_MS = 5 * 60_000;
export const IDENTITY_RESOLUTION_CACHE_MAX = 128;
const identityResolutionCache = pinModuleState('@papercusp/operator-core.identity-resolution-cache', () =>
  new Map<string, { validatedAt: number; resolution: IdentityArtifactResolution }>(),
);

function identityResolutionKey(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): string | null {
  // Callers without a database-owned version retain the original replay path.
  if (!version?.sessionId || !version.rowVersion) return null;
  return JSON.stringify([
    version.sessionId, version.rowVersion, record.workspaceId, record.harnessSlug,
    applied?.specificationRevision ?? null, applied?.stateRevision ?? null,
  ]);
}

/**
 * A fresh cached verdict, or null. Needs only the key fields — NOT the launch
 * record body — which is what lets the kernel resolver skip reading that body on
 * a hit (WI-10002721).
 */
function cachedIdentityResolution(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityArtifactResolution | null {
  const key = identityResolutionKey(record, applied, version);
  if (key === null) return null;
  const cached = identityResolutionCache.get(key);
  if (!cached || Date.now() - cached.validatedAt >= IDENTITY_RESOLUTION_CACHE_TTL_MS) return null;
  identityResolutionCache.delete(key);
  identityResolutionCache.set(key, cached);
  return cached.resolution;
}

function resolveIdentityArtifactForKernel(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityArtifactResolution {
  const cached = cachedIdentityResolution(record, applied, version);
  if (cached) return cached;
  const resolution = resolveIdentityArtifact(record, applied);
  const key = identityResolutionKey(record, applied, version);
  if (key === null) return resolution;
  const now = Date.now();
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

/** The administrator-selected pot of a harness and the worker roles ITS OWN layer declares. */
async function readAdministratorPotRoles(workspaceId: string, harnessSlug: string) {
  const registry = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId, { fresh: true });
  const harness = registry?.projects.find((entry) => entry.slug === harnessSlug);
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
  return { potSlug, roles: ownSource.fleet?.workerRoles ?? [] };
}

/** The runtime role-envelope overrides, only while that flag is on. */
async function readEnvelopeOverrides(workspaceId: string): Promise<CapabilityEnvelopeOverrides> {
  const overridesEnabled = await getFlag(FLAGS.CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId());
  return overridesEnabled
    ? await readOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes', workspaceId, { fresh: true }) ?? {}
    : {};
}

/** Reads existing stores; missing or failed policy reads must reach the caller.
 * This is an optimistic execution-policy read. The registry, pot source files,
 * override flag, provider bindings and projected tool catalog do not share an
 * effect lease. Neither freshness nor policyRevision can supply that protection.
 * Refuse a requested effect pin before accessing any of those sources. */
export const readIdentityGrantPolicy: PolicyReader = async (input) => {
  if (input.pinForEffect === true) throw new Error(HOST_POLICY_EFFECT_PROTECTION_UNAVAILABLE);
  const { potSlug, roles } = await readAdministratorPotRoles(input.workspaceId, input.harnessSlug);
  // A library install may omit a role only for an unambiguous single-role pot.
  // The installed package never supplies the administrator role selection.
  const role = input.role ?? (roles.length === 1 ? roles[0].id : null);
  if (!role) throw new Error('identity grant target role is ambiguous');
  const potRole = roles.find((entry) => entry.id === role);
  if (potRole?.capabilities === undefined) throw new Error('administrator pot has no explicit role capability ceiling');
  const overrides = await readEnvelopeOverrides(input.workspaceId);
  const ceilings: RoleEnvelope[] = [overrides.roleEnvelopes?.[role] ?? ROLE_ENVELOPES[role] ?? {}];
  ceilings.push({ allowCapabilities: potRole.capabilities });
  const bindings: PotCapabilityProviderBindingRow[] = [];
  for (const classRef of input.classRefs) {
    const parsed = parseCapabilityClassRef(classRef);
    if (!parsed) throw new Error(`invalid capability class ${classRef}`);
    const binding = await getPotCapabilityProviderBinding(getOrgPg().sql, {
      workspaceId: input.workspaceId, potSlug, classId: parsed.id, classVersion: parsed.version,
      providerKinds: ['tool', 'recipe'],
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

/** P-002 source census for ONE canonical launch record, not a permission grant
 * or a complete affected-owner/resource census. Keep each layer's own asks and
 * maximum separate from restrictions on the whole stack. In particular neither
 * merged configuration, publisher identity nor capability classes can supply
 * scoped action/resource grants or human ownership.
 *
 * The host supplies the stored record and applied pair. An expected revision
 * rechecks this slice after an asynchronous wait; it is not an effect lease.
 * pinForEffect explicitly refuses until the complete host-policy source vector
 * can be held through the first effect, including when a supplied PolicyReader
 * returns equal bytes or the expectedRevision matches. */
export async function readIdentityPermissionSources(
  input: { workspaceId: string; harnessSlug: string; record: unknown;
    applied: KernelExecutionRevision | null | undefined; expectedRevision?: string; pinForEffect?: boolean },
  readPolicy: PolicyReader = readIdentityGrantPolicy,
) {
  const { workspaceId, harnessSlug, expectedRevision } = input;
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });
  if (input.pinForEffect === true) return unavailable(HOST_POLICY_EFFECT_PROTECTION_UNAVAILABLE);
  const valid = (value: unknown): value is string => typeof value === 'string' &&
    !!value.trim() && value === value.trim();
  if (!valid(workspaceId) || !valid(harnessSlug) ||
      !valid(input.applied?.specificationRevision) || !valid(input.applied?.stateRevision)) {
    return unavailable('identity source scope or applied revision is unavailable');
  }
  // Detach BEFORE the first await, including the applied pair. A caller cannot
  // replace a source or change the role while its policy read is in flight.
  let record: Record<string, unknown> | null;
  let applied: KernelExecutionRevision;
  let artifacts: { applied: ResolvedAgentSpecification; desired: ResolvedAgentSpecification };
  try {
    record = object(structuredClone(input.record));
    applied = structuredClone(input.applied!);
    if (!record || record.workspaceId !== workspaceId || record.harnessSlug !== harnessSlug)
      return unavailable('launch record does not belong to the requested workspace and harness');
    const current = record.specificationArtifact ? replayAgentSpecification(record.specificationArtifact) : null;
    const acknowledged = appliedOrCurrentIdentityArtifact(record, applied);
    if (!current || current.specificationRevision !== record.specificationRevision || !acknowledged)
      return unavailable('applied or desired identity receipt is unavailable');
    artifacts = { applied: acknowledged, desired: current };
  } catch {
    return unavailable('identity source replay failed');
  }
  const sources = (artifact: ResolvedAgentSpecification) => {
    const layers = artifact.inputs.filter(entry => entry.kind === 'blueprint-layer');
    if (!layers.length) throw new Error('identity layer population is empty');
    const refs = new Set<string>();
    return layers.map(layer => {
      // Replay checks the whole artifact hash. Verify the individual canonical
      // source hash too, and parse its authored schema rather than treating an
      // unvalidated embedded object as the publisher's declaration.
      if (!layer.document || refs.has(layer.ref) || layerContentHash(layer.document) !== layer.contentHash ||
          !BlueprintSourceDocumentSchema.safeParse(layer.document).success) throw new Error('invalid identity source');
      refs.add(layer.ref);
      return { ref: layer.ref, revision: layer.revision, contentHash: layer.contentHash,
        sourceKind: layer.sourceKind, document: structuredClone(layer.document) };
    });
  };
  let layers: { applied: ReturnType<typeof sources>; desired: ReturnType<typeof sources> };
  try { layers = { applied: sources(artifacts.applied), desired: sources(artifacts.desired) }; }
  catch { return unavailable('identity layer population is malformed or incomplete'); }
  const role = identityWearerRole(record);
  const classRefs = [...new Set([...layers.applied, ...layers.desired].flatMap(layer => {
    const grants = BlueprintSourceDocumentSchema.parse(layer.document).grants;
    return [...grants?.requires ?? [], ...grants?.optional ?? []];
  }))].sort();
  let policy: IdentityGrantPolicy;
  try { policy = structuredClone(await readPolicy({ workspaceId, harnessSlug, role, classRefs })); }
  catch { return unavailable('current identity grant policy is unavailable'); }
  if (!valid(policy.policyRevision) || !valid(policy.potSlug) || !policy.ceilings?.length ||
      !Array.isArray(policy.bindings) || !(policy.tools instanceof Map) || !Array.isArray(policy.protectedAdditions))
    return unavailable('current identity grant policy is incomplete');
  const revision = createHash('sha256').update(canonicalJson({
    workspaceId, harnessSlug, role, applied,
    desired: { specificationRevision: record.specificationRevision, stateRevision: record.stateRevision },
    layers, policy: { ...policy, tools: [...policy.tools].sort(([a], [b]) => a.localeCompare(b)) },
  })).digest('hex');
  if (expectedRevision !== undefined && revision !== expectedRevision)
    return { status: 'stale' as const, revision };
  return { status: 'ok' as const, revision, role, applied, layers, policy };
}

export interface IdentityPermissionSessionSource {
  ownerId: string | null;
  sessionId: string | null;
  anchorPresent: boolean;
  /** Full stored bodies, including history excluded from the streamed view. */
  sourceRevision: string;
  launchSpec: unknown;
  controlState: unknown;
}

/** Complete stored session slice for P-002. Reuse the execution door's latest
 * launch-row ordering and readIdentityPermissionSources for each record. This
 * is source evidence, not permission or human ownership: null/malformed bodies,
 * inactive wearers, unowned launch rows and orphaned control anchors stay in the
 * population so an admission caller cannot silently discard an unknown scope.
 * With includePackageResources, read the existing installation/resource journal
 * in the SAME snapshot, including unknown human owners and legacy dependents.
 * includeWorkspaceUsers joins the canonical host workspace claims without
 * treating claims as human ownership. includeHostAuthorities joins explicit
 * host enrollment independently of policy roots and login claims. Its required
 * IDs remain present even when their policy is missing; an empty enrollment
 * source does not establish that no host authority is required.
 * includeScopedPolicies also joins the canonical user/platform policy census,
 * requiring those independently enrolled subjects even if other roots exist.
 * includeInheritedPolicies joins the canonical organization-to-workspace chain
 * in this same snapshot, including explicit host ownership of its present
 * authorities. Missing owners remain null, unmatched enrollments remain in the
 * host census, and a proven inapplicable department needs no owner. An absent/
 * malformed chain remains unavailable; policy editors never become owners.
 * Package selection also reconciles exact applied/desired session revisions
 * with the runtime's attempt decision and explicit installation ownership.
 * Unprovisioned/control-only revisions remain unknown; retained prior pins
 * stay in the package census. includeVaultSources joins existing vault settings,
 * grants, privacy rules and the FULL disclosure ledger, including released
 * windows. That stored source does not establish retained context (unrestricted
 * reads are not logged), synthesize vault policy, or prove external backend
 * state. includeBlueprintSources joins the registered filesystem tiers and
 * explicit host-supplied local roots, retaining hidden tiers and absent roots.
 * This source is optimistic, outside PostgreSQL's MVCC snapshot: a second scan
 * detects changes during traversal, but cannot exclude arbitrary writers.
 * It therefore refuses every pinned/effect read, even with an equal revision
 * or a held cooperative mutex. These source joins do not authorize a change.
 *
 * A pinned read serializes effect leases and holds both tables against updates
 * AND new wearers until the caller commits. Acquire this before package preparation, whose independent
 * transactions write the package journal, not these tables. Do not acquire the
 * package journal's SHARE locks before calling its pool-based provisioners.
 * includePackageResources pins those journal tables too: it is suitable for a
 * protected effect that does not call the journal through another connection.
 * includeWorkspaceUsers also pins auth storage: resolve retained credentials
 * before this lease, since getSessionUser may write last_seen_at through the pool.
 * includeVaultSources also pins the four vault authority tables: use the caller
 * transaction for any protected vault write, never a separate pool connection.
 *
 * Return compact source references; optionally visit receipt-narrowed bodies in
 * bounded batches. Visitors only collect/read evidence, never perform effects:
 * the final revision check happens AFTER traversal. The full un-narrowed body
 * hash still detects edits to excluded history. No raw artifact array is kept
 * by this adapter, including for the inactive population. */
export async function readIdentityPermissionPopulation(sql: Sql, workspaceId: string,
  options: { expectedRevision?: string; pinForEffect?: boolean; includePackageResources?: boolean;
    includeWorkspaceUsers?: boolean; includeHostAuthorities?: boolean; includeScopedPolicies?: boolean;
    includeInheritedPolicies?: boolean; includeVaultSources?: boolean;
    includeBlueprintSources?: { localDirs: readonly string[] };
    visit?: (session: IdentityPermissionSessionSource) => void | Promise<void> } = {}) {
  options = { ...options };
  if (options.includeBlueprintSources !== undefined) {
    const roots = options.includeBlueprintSources?.localDirs;
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' ||
        !isAbsolute(root) || root.includes('\0')))
      throw new Error('blueprint source join requires explicit absolute local roots');
    options.includeBlueprintSources = { localDirs: [...roots] };
  }
  if (!workspaceId || workspaceId !== workspaceId.trim() ||
      (options.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedRevision)))
    throw new Error('identity population requires an exact workspace and revision');
  const pinned = options.pinForEffect === true || options.expectedRevision !== undefined;
  const transaction = typeof (sql as unknown as Partial<TransactionSql>).savepoint === 'function';
  if (pinned && !transaction) throw new Error('pinned identity population requires an existing transaction');
  const read = async (tx: Sql) => {
    let blueprintSources: Extract<ReturnType<typeof readBlueprintSourcePopulation>, { status: 'ok' }> | undefined;
    if (options.includeBlueprintSources) {
      const population = readBlueprintSourcePopulation({ localDirs: [...options.includeBlueprintSources.localDirs],
        pinForEffect: pinned });
      if (population.status !== 'ok') throw new Error(`blueprint source population is unavailable: ${
        population.status === 'unavailable' ? population.reason : population.status}`);
      blueprintSources = population;
    }
    const [isolation] = await tx<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
    if (pinned) {
      if (isolation?.isolation !== 'read committed')
        throw new Error('pinned identity population requires read committed isolation');
      // These effects update the launch/anchor tables themselves. A plain
      // SHARE would admit two readers whose later write upgrades deadlock.
      await tx`LOCK TABLE harness_shared.adv_sessions, harness_shared.session_briefs IN SHARE ROW EXCLUSIVE MODE`;
    } else if (!['repeatable read', 'serializable'].includes(isolation?.isolation ?? ''))
      throw new Error('identity population snapshot requires repeatable read or serializable isolation');
    const [visibility] = await tx<Array<{ workspace: string | null; restricted: boolean }>>`
      SELECT current_setting('app.workspace_id', true) AS workspace,
        (row_security_active('harness_shared.adv_sessions') OR
         row_security_active('harness_shared.session_briefs')) AS restricted`;
    if (!visibility || (visibility.restricted && visibility.workspace !== workspaceId))
      throw new Error('identity population workspace is not visible to this connection');
    const sessions: Array<Omit<IdentityPermissionSessionSource, 'launchSpec' | 'controlState'>> = [];
    const packageRevisions: Array<{ applied: unknown; desired: unknown }> = [];
    const hash = createHash('sha256').update(canonicalJson({ workspaceId }));
    const query = tx<Array<IdentityPermissionSessionSource & { packageRevisions: { applied: unknown; desired: unknown } }>>`
      WITH launches AS (
        SELECT a.id, a.coord_owner_id, to_jsonb(a)->'launch_spec' AS launch_spec,
          row_number() OVER (PARTITION BY a.coord_owner_id ORDER BY a.id DESC) AS ordinal
          FROM harness_shared.adv_sessions a WHERE a.workspace_id = ${workspaceId}
      ), latest AS (
        SELECT * FROM launches WHERE ordinal = 1 OR coord_owner_id IS NULL
      ), anchors AS (
        SELECT owner_id, control_state FROM harness_shared.session_briefs
          WHERE workspace_id = ${workspaceId}
      ), joined AS (
        SELECT coalesce(a.coord_owner_id, b.owner_id) AS owner_id, a.id,
          a.launch_spec, b.control_state, b.owner_id IS NOT NULL AS anchor_present,
          b.control_state->'activation'->'applied' AS applied_pair
          FROM latest a FULL OUTER JOIN anchors b ON b.owner_id = a.coord_owner_id
      )
      SELECT n.owner_id AS "ownerId", n.id::text AS "sessionId", n.anchor_present AS "anchorPresent",
        encode(sha256(convert_to(jsonb_build_array(n.launch_spec, n.control_state)::text, 'UTF8')), 'hex') AS "sourceRevision",
        CASE WHEN ${options.includePackageResources === true} THEN jsonb_build_object('applied', n.applied_pair,
          'desired', jsonb_build_object('specificationRevision', n.launch_spec->'specificationRevision',
            'stateRevision', n.launch_spec->'stateRevision')) ELSE NULL::jsonb END AS "packageRevisions",
        CASE WHEN ${options.visit !== undefined} THEN ${narrowedLaunchSpecToAppliedPairSql(tx)} ELSE NULL::jsonb END AS "launchSpec",
        CASE WHEN ${options.visit !== undefined} THEN n.control_state ELSE NULL::jsonb END AS "controlState"
        FROM joined n ORDER BY n.owner_id NULLS LAST, n.id NULLS LAST`;
    for await (const batch of query.cursor(8)) {
      for (const { launchSpec, controlState, packageRevisions: revisions, ...ref } of batch) {
        sessions.push(ref);
        if (options.includePackageResources) packageRevisions.push(revisions);
        hash.update('\n').update(canonicalJson(ref));
        await options.visit?.({ ...ref, launchSpec, controlState });
      }
    }
    // Do not compose independently committed source snapshots into one census.
    // The journal reader reuses this transaction and its visibility checks;
    // its revision covers empty installs, shared/released links and ownership.
    let packages: Extract<Awaited<ReturnType<typeof import('../blueprint/package-resource-receipts').readPackageResourcePopulation>>,
      { status: 'ok' }> | undefined;
    if (options.includePackageResources) {
      const { readPackageResourcePopulation } = await import('../blueprint/package-resource-receipts');
      const population = await readPackageResourcePopulation(tx, workspaceId, { pinForEffect: pinned });
      if (population.status !== 'ok') throw new Error('package population is unavailable');
      packages = population;
      hash.update('\n').update(canonicalJson({ packageResourceRevision: packages.revision }));
    }
    let sessionPackageOwners: Array<{ ownerId: string | null; sessionId: string | null;
      applied: Awaited<ReturnType<typeof import('../blueprint/session-package-resources').readSessionPackageOwnership>> | {
        status: 'unknown'; revision: unknown; dependentId: null; humanOwnerId: null; reason: string };
      desired: Awaited<ReturnType<typeof import('../blueprint/session-package-resources').readSessionPackageOwnership>> | {
        status: 'unknown'; revision: unknown; dependentId: null; humanOwnerId: null; reason: string };
    }> | undefined;
    if (packages) {
      const { readSessionPackageOwnership } = await import('../blueprint/session-package-resources');
      const installationRevisions = new Set(packages.installations.map(row => canonicalJson([
        row.owner_id, row.specification_revision, row.state_revision,
      ])));
      sessionPackageOwners = [];
      for (const [index, session] of sessions.entries()) {
        const resolve = async (phase: 'applied' | 'desired') => {
          const raw = packageRevisions[index]?.[phase];
          const revision = object(raw);
          const spec = revision?.specificationRevision, state = revision?.stateRevision;
          const valid = session.ownerId !== null && typeof spec === 'string' && /^[a-f0-9]{64}$/.test(spec) &&
            typeof state === 'string' && !!state.trim() && state === state.trim();
          if (!valid || !installationRevisions.has(canonicalJson([session.ownerId, spec, state])))
            return { status: 'unknown' as const, revision: raw ?? null, dependentId: null, humanOwnerId: null,
              reason: valid ? 'no-exact-installation' : 'session-revision-unavailable' };
          return readSessionPackageOwnership(tx as unknown as TransactionSql, { workspaceId, ownerId: session.ownerId!,
            revision: { specificationRevision: spec as string, stateRevision: state as string }, phase });
        };
        sessionPackageOwners.push({ ownerId: session.ownerId, sessionId: session.sessionId,
          applied: await resolve('applied'), desired: await resolve('desired') });
      }
      hash.update('\n').update(canonicalJson({ sessionPackageOwners }));
    }
    let workspaceUsers: Extract<Awaited<ReturnType<typeof import('../auth').readWorkspaceUserBindings>>,
      { status: 'ok' }> | undefined;
    if (options.includeWorkspaceUsers) {
      const { readWorkspaceUserBindings } = await import('../auth');
      const population = await readWorkspaceUserBindings(tx, workspaceId, { pinForEffect: pinned });
      if (population.status !== 'ok') throw new Error('workspace user population is unavailable');
      workspaceUsers = population;
      hash.update('\n').update(canonicalJson({ workspaceUserRevision: workspaceUsers.revision }));
    }
    let hostAuthorities: Extract<Awaited<ReturnType<typeof import('../governance-policy/host-authority-bindings').readHostAuthorityBindings>>,
      { status: 'ok' }> | undefined;
    if (options.includeHostAuthorities || options.includeScopedPolicies || options.includeInheritedPolicies) {
      const { readHostAuthorityBindings } = await import('../governance-policy/host-authority-bindings');
      const population = await readHostAuthorityBindings(tx, workspaceId, { pinForEffect: pinned });
      if (population.status !== 'ok') throw new Error('host authority population is unavailable');
      hostAuthorities = population;
      hash.update('\n').update(canonicalJson({ hostAuthorityRevision: hostAuthorities.revision }));
    }
    let scopedPolicies: Extract<Awaited<ReturnType<typeof import('../governance-policy/store').loadScopedPolicyAuthorities>>,
      { status: 'ok' }> | undefined;
    if (options.includeScopedPolicies) {
      if (pinned) await tx`LOCK TABLE harness_shared.governance_policy_layers IN SHARE MODE`;
      const [visibility] = await tx<Array<{ restricted: boolean }>>`
        SELECT row_security_active('harness_shared.governance_policy_layers') AS restricted`;
      if (!visibility || visibility.restricted) throw new Error('scoped policy population is not fully visible');
      const { loadScopedPolicyAuthorities } = await import('../governance-policy/store');
      const population = await loadScopedPolicyAuthorities({ workspaceId,
        userIds: 'workspace', platformIds: 'workspace',
        requiredUserIds: hostAuthorities!.requiredUserIds,
        requiredPlatformIds: hostAuthorities!.requiredPlatformIds }, tx);
      // Empty enrollment fails the loader's required-ID validation. A nonempty
      // policy census cannot substitute for the independent required source.
      if (population.status !== 'ok') throw new Error(`scoped policy population is unavailable: ${population.status}`);
      scopedPolicies = population;
      hash.update('\n').update(canonicalJson({ scopedPolicyRevision: scopedPolicies.revision }));
    }
    let inheritedPolicies: Extract<Awaited<ReturnType<typeof import('../governance-policy/store').loadPolicyAuthoritiesForWorkspace>>,
      { status: 'ok' }> | undefined;
    if (options.includeInheritedPolicies) {
      // Lock insertion gaps as well as current ancestors before reading at the
      // effect boundary. READ COMMITTED sees changes completed during the wait;
      // the aggregate revision below refuses a changed before-image. No pool
      // provisioner or separately committed chain participates in this lease.
      if (pinned && !options.includeScopedPolicies)
        await tx`LOCK TABLE harness_shared.governance_policy_layers IN SHARE MODE`;
      const [visibility] = await tx<Array<{ restricted: boolean }>>`
        SELECT row_security_active('harness_shared.governance_policy_layers') AS restricted`;
      if (!visibility || visibility.restricted) throw new Error('inherited policy population is not fully visible');
      const { loadPolicyAuthoritiesForWorkspace } = await import('../governance-policy/store');
      const population = await loadPolicyAuthoritiesForWorkspace(workspaceId, tx);
      if (population.status !== 'ok') throw new Error(`inherited policy population is unavailable: ${population.status}`);
      inheritedPolicies = population;
      hash.update('\n').update(canonicalJson({ inheritedPolicyRevision: inheritedPolicies.revision }));
    }
    // The policy's canonical layer id is the subject, not its editor, scope
    // label or ancestor's owner. Retain unknowns so the eventual admission
    // cannot authorize from a guessed human or a silently shortened census.
    // Both sources were measured in this transaction and remain pinned through
    // effect; the aggregate revision covers owner changes and first enrollment.
    const inheritedPolicyOwners = inheritedPolicies?.policies.filter(policy => policy.state === 'present')
      .map(({ kind, id, revision }) => ({ authority: { kind, id, revision },
        ownerId: hostAuthorities!.bindings.find(binding => binding.kind === kind && binding.subjectId === id)?.humanOwnerId ?? null }));
    let vaultSources: Extract<Awaited<ReturnType<typeof import('../personal-vault/store').readPersonalAuthorityPopulation>>,
      { status: 'ok' }> | undefined;
    if (options.includeVaultSources) {
      const { readPersonalAuthorityPopulation } = await import('../personal-vault/store');
      const population = await readPersonalAuthorityPopulation(tx, workspaceId, { pinForEffect: pinned });
      if (population.status !== 'ok') throw new Error('vault source population is unavailable');
      vaultSources = population;
      hash.update('\n').update(canonicalJson({ vaultSourceRevision: vaultSources.revision }));
    }
    if (blueprintSources) {
      const current = readBlueprintSourcePopulation({ localDirs: [...options.includeBlueprintSources!.localDirs],
        expectedRevision: blueprintSources.revision });
      if (current.status === 'unavailable')
        throw new Error(`blueprint source population is unavailable: ${current.reason}`);
      hash.update('\n').update(canonicalJson({ blueprintSourceRevision: current.revision }));
      if (current.status === 'stale') return { status: 'stale' as const, revision: hash.digest('hex') };
    }
    const revision = hash.digest('hex');
    return options.expectedRevision !== undefined && revision !== options.expectedRevision
      ? { status: 'stale' as const, revision }
      : { status: 'ok' as const, revision, sessions, ...(packages ? { packages, sessionPackageOwners } : {}),
        ...(workspaceUsers ? { workspaceUsers } : {}), ...(hostAuthorities ? { hostAuthorities } : {}),
        ...(scopedPolicies ? { scopedPolicies } : {}),
        ...(inheritedPolicies ? { inheritedPolicies, inheritedPolicyOwners } : {}),
        ...(vaultSources ? { vaultSources } : {}),
        ...(blueprintSources ? { blueprintSources: { ...blueprintSources, consistency: 'optimistic' as const } } : {}) };
  };
  return transaction ? read(sql) : sql.begin('isolation level repeatable read read only',
    tx => read(tx as unknown as Sql));
}

/** The pot/role ceiling an identity reaction's capability is narrowed to (P-018, D-027 §4). */
export interface IdentityReactionCeiling {
  potSlug: string;
  ceilings: readonly RoleEnvelope[];
  protectedAdditions: readonly string[];
}

/**
 * The same sources as {@link readIdentityGrantPolicy}: the role envelope (with its
 * runtime override) and the administrator pot's explicit role ceiling. One
 * difference: a pot that declares no ceiling for the role adds none here instead
 * of throwing. The dispatch that follows still runs the kernel, which refuses a
 * governed wearer in that pot, and an ungoverned wearer keeps its structural
 * envelope. Throws when a source cannot be read, so the durable step retries
 * rather than authorizing on a partial read.
 */
export async function readIdentityReactionCeiling(input: {
  workspaceId: string;
  harnessSlug: string;
  role: string;
}): Promise<IdentityReactionCeiling> {
  const { potSlug, roles } = await readAdministratorPotRoles(input.workspaceId, input.harnessSlug);
  const overrides = await readEnvelopeOverrides(input.workspaceId);
  const ceilings: RoleEnvelope[] = [overrides.roleEnvelopes?.[input.role] ?? ROLE_ENVELOPES[input.role] ?? {}];
  const potRole = roles.find((entry) => entry.id === input.role);
  if (potRole?.capabilities !== undefined) ceilings.push({ allowCapabilities: potRole.capabilities });
  return { potSlug, ceilings, protectedAdditions: overrides.protectedAdditions ?? [] };
}

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
  // WI-10005197: the install-time refusal carries the same lift condition as the
  // runtime kernel denial further down. `observed` is omitted on purpose — install
  // time has no live policy revision to compare against, and the contract renders
  // without it.
  const failure = (cause: IdentityGrantFailure['cause'], classRef: string | null, toolName?: string): IdentityGrantFailure => ({
    code: 'capability_unsatisfied', cause, classRef, ...(toolName ? { toolName } : {}),
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
    refusal: identityRefusalContract(cause),
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
    // A recipe provider's verbBindings name recipes. Its reach is the tools its
    // inspected scripts call, so those are what the ceiling must admit (D-019).
    // The one reach function compile and the runtime envelope also use (D-040(e)).
    const toolNames = grantProviderToolReach(provider);
    if (!toolNames) {
      failures.push(failure('provider-unbound', requirement.classRef));
      continue;
    }
    for (const toolName of new Set(toolNames)) {
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
  observed?: RefusalObservation,
): KernelEnforcementResult {
  // EI-23766133296678780: every denial carries what would lift it. The leading
  // `Identity capability <class>: <cause> (<tool>)` is unchanged — the tool-error
  // classifier keys on it — and the contract is appended after it.
  const refusal = identityRefusalContract(cause, observed);
  const failure: IdentityGrantFailure = {
    code: 'capability_unsatisfied', cause, classRef, toolName,
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
    refusal,
  };
  return {
    decision: 'deny', availability: 'available', applied: true,
    code: failure.code,
    reason: `Identity capability ${classRef ?? '(unresolved)'}: ${cause} (${toolName})${renderRefusalContract(refusal)}`,
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
  observed?: RefusalObservation,
): KernelEnforcementResult {
  return denyUnlessRecoveryDoor(request, 'stale-artifact', null, toolName, policyRevision, observed);
}

/**
 * The values a `stale-artifact` verdict compared, for its refusal contract: the
 * applied/desired activation pair and the launch record's specification revision.
 * `resolution` is the sub-reason `resolveIdentityArtifact` chose, or a site label
 * where no resolution ran (no usable record, or an envelope that did not apply).
 */
function staleObservation(
  state: IdentityGrantKernelState,
  record: Record<string, unknown> | null,
  resolution: string,
): RefusalObservation {
  const launch = typeof record?.specificationRevision === 'string' ? record.specificationRevision.slice(0, 8) : null;
  return {
    applied: shortRevision(state.activation?.applied ?? state.appliedRevision),
    desired: shortRevision(state.activation?.desired),
    launchSpec: launch,
    resolution,
  };
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
  observed?: RefusalObservation,
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
  return denial(cause, classRef, toolName, policyRevision, observed);
}

/**
 * The exact adv_sessions row version whose immutable identity artifact a kernel
 * decision evaluated: the database row id and the xmin actually read (the lazily
 * loaded body's xmin on a cache miss, not the earlier header's).
 */
export interface IdentityLaunchAuditStamp {
  advSessionId: string;
  xmin: string;
}

/**
 * Receives the audit stamp for an artifact this gate evaluated but does not
 * govern. `checkIdentityGrantKernel` returns `null` for that outcome so the
 * caller's structural verdict stands; this is how that verdict still names the
 * row it was judged against (D-007).
 */
export type UngovernedIdentityAuditSink = (stamp: IdentityLaunchAuditStamp) => void;

function identityLaunchAuditStamp(
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityLaunchAuditStamp | null {
  return version?.sessionId && version.rowVersion
    ? { advSessionId: version.sessionId, xmin: version.rowVersion }
    : null;
}

/**
 * WI-10007010: whether any provider binding in the policy reaches `toolName`.
 * Such a tool is governed by its grant class; anything else is a platform tool
 * the grant envelope never covers. Deliberately pot- and status-agnostic: a
 * binding that reaches the tool in ANY state keeps it on the grant path.
 */
function providerReachable(policy: IdentityGrantPolicy, toolName: string): boolean {
  return policy.bindings.some((binding) => (grantProviderToolReach(binding) ?? []).includes(toolName));
}

export async function checkIdentityGrantKernel(
  request: KernelEnforcementRequest,
  state: IdentityGrantKernelState,
  rawRecord: unknown,
  readPolicy: PolicyReader = readIdentityGrantPolicy,
  readOperationEffectClaim: OperationEffectClaimReader = readCurrentOperationEffectClaim,
  onUngovernedEvaluated?: UngovernedIdentityAuditSink,
): Promise<KernelEnforcementResult | null> {
  // WI-10002721: the live resolver passes a header + loader instead of the
  // (hundreds-of-KB) record. The header carries exactly the fields this gate
  // reads before and after resolution, so a cache hit never loads the body.
  const lazy = isLazyIdentityLaunchRecord(rawRecord) ? rawRecord : null;
  let record: Record<string, unknown> | null = lazy
    ? (lazy.isObject ? {
        workspaceId: lazy.workspaceId, harnessSlug: lazy.harnessSlug,
        ...(lazy.hasAcceptedOperation ? { acceptedOperation: lazy.acceptedOperation } : {}),
      } : null)
    : object(rawRecord);
  let version = state.identityLaunchRecordVersion;
  const applied = state.activation?.applied ?? state.appliedRevision;
  // No launch artifact is the legacy, non-opted-in path. An acknowledged
  // identity with a missing receipt is not legacy: fail closed.
  //
  // "Acknowledged" is load-bearing and is what makes `no-launch-record` a fault
  // rather than a brick. A session_briefs row alone is NOT an identity: any
  // coord verb creates one, and the compaction watchdog writes one (carry +
  // control_state, no activation) for a session it force-compacts. A launch
  // that never registered an adv_sessions row (a consult-expiry-sweep
  // `psu --fork --owner-id` fork, measured 2026-09-23: 12 of 12 live forks had
  // no row) is therefore ungoverned until it is compacted — and was then denied
  // EVERY verb on this branch, with no activation for coord:orient to converge
  // and no wedged-identity escalation (that sweep already treats "no applied
  // receipt" as the legacy path, exactly as the comment above says). Gate the
  // fault on an activation being present so the kernel and the sweep agree.
  const acknowledged = Boolean(state.activation) || Boolean(applied);
  if (!record) {
    if (state.identityLaunchRecordMissing && acknowledged) {
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
    return applied
      ? staleArtifact(request, request.toolName, undefined, staleObservation(state, null, 'no-launch-record-body'))
      : null;
  }
  // The decision itself lives in `resolveIdentityArtifact` (above) so the
  // WI-10002060 sweep can ask the same question instead of paraphrasing it.
  // This call site is behaviour-identical to the body it replaced.
  let resolution = lazy ? cachedIdentityResolution(record, applied, version) : null;
  if (lazy && !resolution) {
    // Cache miss: read the body. It is resolved AND keyed at the row version it
    // was read at, so a row updated between the header read and this one is
    // judged as one consistent snapshot rather than a header/body mix.
    //
    // WI-10004801: only the receipt for `applied` is ever consulted
    // (`selectAppliedReceipt`), so the body arrives with identityHistory
    // narrowed to that pair in PostgreSQL instead of every retained ~1 MB
    // artifact. No applied pair means no history is consulted at all.
    const loaded = await lazy.load(applied ? [applied] : []);
    const full = object(loaded?.record);
    // The row vanished or stopped being an object between the two reads:
    // exactly the "no usable record" outcome the header path would have given.
    if (!full) {
      return applied
        ? staleArtifact(request, request.toolName, undefined, staleObservation(state, null, 'launch-record-unreadable'))
        : null;
    }
    record = full;
    version = version && loaded?.rowVersion
      ? { sessionId: version.sessionId, rowVersion: loaded.rowVersion }
      : undefined;
  }
  resolution ??= resolveIdentityArtifactForKernel(record, applied, version);
  if (resolution.kind === 'stale-artifact') {
    return staleArtifact(request, request.toolName, undefined, staleObservation(state, record, resolution.reason));
  }
  if (resolution.kind === 'ungoverned') {
    // D-007: no live session carries configuration.grants, so without this
    // every identity-bearing invocation would persist with no row reference and
    // the per-call receipt could never be produced. Audit only: the caller's
    // structural verdict (and its decision) is unchanged.
    const stamp = identityLaunchAuditStamp(version);
    if (stamp) onUngovernedEvaluated?.(stamp);
    return null;
  }
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
  // WI-6554700010029046: a released accepted-operation worker must not be able
  // to promote itself, but the first-party UserPromptSubmit hook still needs one
  // exact door that asks the host to mint a distinct SU assignment. This admits
  // only the hook-declared transport to that handler; it grants no operation
  // tool and changes neither requiredTools nor the effect-claim check below.
  // The handler independently rereads the exact receipt, hook-captured owner
  // directive and released claim before it launches anything.
  if ('acceptedOperation' in record &&
      isHookReleasedOperationContinuationCall({ toolName, ctx: request.ctx })) {
    return {
      decision: 'allow', availability: 'available', applied: true,
      policyRevision: policy.policyRevision, executionRevision: applied, revisionSource: 'applied',
      ...(version?.sessionId && version.rowVersion
        ? { serverAudit: { identityLaunchRecord: {
          advSessionId: version.sessionId, xmin: version.rowVersion,
        } } }
        : {}),
    };
  }
  // The accepted operation's requested tools are a further ceiling carried by
  // the host-owned launch receipt. Tool arguments and nested dispatch cannot
  // alter this list. An empty list deliberately permits no operation tools.
  const accepted = 'acceptedOperation' in record ? object(record.acceptedOperation) : null;
  if ('acceptedOperation' in record) {
    const tools = accepted?.requiredTools;
    const pin = object(accepted?.pin);
    if (accepted?.kind !== 'blueprint-operation-worker' ||
        typeof accepted.workItemId !== 'string' || !accepted.workItemId ||
        typeof accepted.specificationRevision !== 'string' ||
        !/^[0-9a-f]{64}$/.test(accepted.specificationRevision) ||
        pin?.kind !== 'blueprint-operation' ||
        pin.operationId !== accepted.operationId ||
        pin.specificationRevision !== accepted.specificationRevision ||
        pin.harnessSlug !== record.harnessSlug ||
        !Array.isArray(tools) || !tools.every((name) => typeof name === 'string' && name.length > 0) ||
        !tools.includes(toolName)) {
      return denyUnlessRecoveryDoor(
        request, 'outside-ceiling', classRefs[0] ?? null, toolName, policy.policyRevision,
      );
    }
  }
  for (const specification of [artifact, current]) {
    const envelope = resolveIdentityGrantEnvelope({
      specification, appliedSpecificationRevision: specification.specificationRevision, ...policy,
    });
    if (!envelope.applied) {
      return staleArtifact(
        request, toolName, policy.policyRevision, staleObservation(state, record, 'envelope-not-applied'),
      );
    }
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
      // WI-10007010: grant classes govern PROVIDER tools only — the envelope reaches
      // nothing else — so a deny-all accepted-operation identity could otherwise call
      // none of its own requiredTools (work_items:claim, memory:search, …). A required
      // tool that no provider binding reaches is a platform tool: the host-owned
      // receipt (checked above) plus every role ceiling authorize it. A
      // provider-reachable tool still needs its grant.
      const cause = accepted && !providerReachable(policy, toolName)
        ? identityGrantToolFailure({
            toolName, ceilings: policy.ceilings, tools: policy.tools,
            protectedAdditions: policy.protectedAdditions,
          })
        : 'outside-ceiling';
      if (cause) {
        return denyUnlessRecoveryDoor(
          request, cause, classRefs[0] ?? null, toolName, policy.policyRevision,
        );
      }
    }
  }
  // The accepted tool list narrows WHAT a role may call. A separate live
  // claim check narrows WHEN it may cause an effect. Read-only and claim doors
  // remain usable for pickup/recovery; every other direct, native or nested
  // dispatch checks the same current holder and immutable receipt.
  const claimDoors = new Set(['work_items:claim', 'work_items:claim_next', 'scheduler:get_next']);
  const readOnly = request.capabilities.length > 0 &&
    request.capabilities.every((capability) => capability.endsWith(':read'));
  if (accepted && !claimDoors.has(toolName) && !readOnly && toolName !== 'coord:orient') {
    const claim = {
      workspaceId: workspaceId as string,
      harnessSlug: record.harnessSlug as string,
      workItemId: accepted.workItemId as string,
      ownerId: state.operationOwnerId ?? null,
      advSessionId: state.identityLaunchRecordVersion?.sessionId ?? null,
      acceptedOperation: accepted,
    };
    let current = false;
    try { current = await readOperationEffectClaim(claim); } catch {
      return { decision: 'deny', code: 'operation-claim-unavailable',
        reason: 'current operation claim authority could not be read', availability: 'unavailable', applied: true,
        policyRevision: policy.policyRevision };
    }
    if (!current) return { decision: 'deny', code: 'operation-claim-stale',
      reason: 'operation worker no longer holds the item under its applied launch receipt',
      availability: 'available', applied: true, policyRevision: policy.policyRevision };
  }
  return {
    decision: 'allow', availability: 'available', applied: true,
    policyRevision: policy.policyRevision, executionRevision: applied, revisionSource: 'applied',
    // R1 needs every invocation receipt to identify the exact adv_sessions row
    // whose immutable identity artifact this decision evaluated. `sessionId`
    // is the database row id here; `rowVersion` is the xmin actually used after
    // any lazy body read, not necessarily the earlier header's xmin.
    ...(version?.sessionId && version.rowVersion
      ? { serverAudit: { identityLaunchRecord: { advSessionId: version.sessionId, xmin: version.rowVersion } } }
      : {}),
  };
}
