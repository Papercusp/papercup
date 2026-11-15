/**
 * Canonical saved fleet launch-spec recovery (agent-launch-unification P-043).
 *
 * `fleet:headcount-target` is the existing durable writer for a homogeneous
 * fleet's launch recipe. Recovery callers must read that row before composing a
 * command, preserve every omitted field, and fail closed when an unaudited
 * request disagrees with it. This module is the one read/merge/diagnostic seam;
 * launch-on-plan, launch-agent resume, and respawn-member integrate it in P-044.
 */
import {
  accountFromArgv,
  composeLaunchModelSpec,
  flagValueFromArgv,
  modelSpecFromArgv,
  splitModelSpec,
} from '../../agent-config-constants';
import {
  fleetSlugFromName,
  getFleetHeadcountTarget,
  type FleetHeadcountConfig,
  type FleetHeadcountTarget,
} from '../../agent-fleets-store';
import { foldMemberSpec, memberSpecSchema, type MemberSpec } from '../../agent-launch-core';
import { replayAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { readAdvSessionLaunchRecordByOwner, type AdvSessionLaunchRecord } from '../../adv-sessions';
import { parseSuLaunchSpecRecord } from '../../su-persona-render';
import { normalizeSuContextSize } from '../../su-context-size.mjs';

export const SAVED_FLEET_LAUNCH_SPEC_SOURCE = 'fleet:headcount-target' as const;
export const LEGACY_FLEET_LAUNCH_SPEC_SOURCE = 'adv_sessions.launch_spec' as const;
export type SavedFleetLaunchSpecSource =
  | typeof SAVED_FLEET_LAUNCH_SPEC_SOURCE
  | typeof LEGACY_FLEET_LAUNCH_SPEC_SOURCE
  | 'adv_sessions.launch_spec.originalMemberLaunch';

/**
 * A saved launch config may lack a plan: a legacy member launched through the
 * planless capability:launch-agent door, or (R-8) a pure claim-spec drain fleet
 * whose canonical headcount row now records no plan either.
 */
export type SavedFleetLaunchConfig = Omit<FleetHeadcountConfig, 'plan'> & { plan?: string };

export type SavedFleetLaunchField =
  | 'plan'
  | 'harness'
  | 'agent'
  | 'model'
  | 'account'
  | 'headless'
  | 'carry'
  | 'role'
  | 'brief'
  | 'launchContext'
  | 'contextSize'
  | 'compactionLimit'
  | 'extraArgs';

export interface SavedFleetLaunchSpecRequest {
  plan?: string;
  harness?: string;
  agent?: string;
  model?: string;
  effort?: string;
  account?: string;
  headless?: boolean;
  carry?: 'warm' | 'cold';
  role?: string;
  brief?: string;
  launchContext?: string;
  contextSize?: 'trimmed' | 'steward';
  compactionLimit?: number;
  extraArgs?: readonly string[];
  /** A homogeneous saved profile cannot be silently reconstructed per member. */
  members?: readonly unknown[];
  perMemberLaunchContext?: readonly string[];
  /** Claim scope is persisted by the fleet claim-spec store, not this recipe. */
  claimKinds?: readonly string[];
  /** These MemberSpec fields are intentionally absent from FleetHeadcountConfig. */
  addDir?: readonly string[];
  allowSubagents?: boolean;
  brain?: boolean;
  feature?: string;
  profile?: string;
  display?: string;
}

export interface SavedFleetLaunchSpec {
  /** Optional only for legacy planless recovery; canonical targets always set it. */
  plan?: string;
  harness: string;
  member: MemberSpec;
}

/**
 * Normalize the one legacy value that can appear in a persisted launch profile
 * but is not a psu persona. Fleet membership stores `member` as its role label;
 * launch profiles store a psu `role`, where omission means the standard su
 * collaborator. Keep this intentionally narrow so real persona names continue
 * to round-trip unchanged.
 */
export function normalizePersistedFleetLaunchRole(role: unknown): string | undefined {
  const trimmed = typeof role === 'string' ? role.trim() : undefined;
  return trimmed && trimmed !== 'member' ? trimmed : undefined;
}

/** Return a copy of a saved config with the legacy membership label removed. */
export function normalizePersistedFleetLaunchConfig<T extends SavedFleetLaunchConfig>(
  config: T,
): T {
  const role = normalizePersistedFleetLaunchRole(config.role);
  if (role === config.role) return config;

  const normalized = { ...config } as T;
  if (role === undefined) delete normalized.role;
  else normalized.role = role;
  return normalized;
}

/** Return a copy of a command-neutral spec with the legacy membership label removed. */
export function normalizePersistedFleetLaunchSpec(
  spec: SavedFleetLaunchSpec,
): SavedFleetLaunchSpec {
  const role = normalizePersistedFleetLaunchRole(spec.member.role);
  if (role === spec.member.role) return spec;

  const member = { ...spec.member };
  if (role === undefined) delete member.role;
  else member.role = role;
  return { ...spec, member };
}

export interface SavedFleetLaunchSpecProvenance {
  source: SavedFleetLaunchSpecSource;
  workspaceId: string;
  fleetSlug: string;
  target: number | null;
}

export interface SavedFleetLaunchSpecDelta {
  field: string;
  saved: unknown;
  requested: unknown;
  provenance: SavedFleetLaunchSpecProvenance;
  reusePath: string;
}

export type SavedFleetLaunchSpecResolution =
  | {
      ok: true;
      found: false;
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    }
  | {
      ok: true;
      found: true;
      target: number;
      config: SavedFleetLaunchConfig;
      saved: SavedFleetLaunchSpec;
      effective: SavedFleetLaunchSpec;
      preservedFields: SavedFleetLaunchField[];
      overrides: SavedFleetLaunchSpecDelta[];
      deprecations: string[];
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    }
  | {
      ok: false;
      found: boolean;
      error:
        | 'saved_launch_spec_read_failed'
        | 'saved_launch_spec_missing'
        | 'saved_launch_spec_invalid'
        | 'saved_launch_spec_conflict';
      message: string;
      conflicts: SavedFleetLaunchSpecDelta[];
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    };

const SAVED_FIELD_ORDER: readonly SavedFleetLaunchField[] = [
  'plan',
  'harness',
  'agent',
  'model',
  'account',
  'headless',
  'carry',
  'role',
  'brief',
  'launchContext',
  'contextSize',
  'compactionLimit',
  'extraArgs',
];

function provenanceFor(
  workspaceId: string,
  fleetSlug: string,
  target: number | null,
  source: SavedFleetLaunchSpecSource = SAVED_FLEET_LAUNCH_SPEC_SOURCE,
): SavedFleetLaunchSpecProvenance {
  return { source, workspaceId, fleetSlug, target };
}

/** Convert the validated headcount recipe to the command-neutral member spec. */
export function savedFleetLaunchSpecFromConfig(config: SavedFleetLaunchConfig): SavedFleetLaunchSpec {
  const normalizedConfig = normalizePersistedFleetLaunchConfig(config);
  const normalizedContextSize = normalizeSuContextSize((normalizedConfig as { contextSize?: unknown }).contextSize);
  if (!normalizedContextSize.ok) throw new Error(normalizedContextSize.error);
  return {
    ...(normalizedConfig.plan !== undefined ? { plan: normalizedConfig.plan } : {}),
    harness: normalizedConfig.harness,
    member: {
      agent: normalizedConfig.agent,
      ...(normalizedConfig.model !== undefined ? { model: normalizedConfig.model } : {}),
      ...(normalizedConfig.effort !== undefined ? { effort: normalizedConfig.effort } : {}),
      ...(normalizedConfig.account !== undefined ? { account: normalizedConfig.account } : {}),
      headless: normalizedConfig.headless ?? true,
      ...(normalizedConfig.carry !== undefined ? { carry: normalizedConfig.carry } : {}),
      ...(normalizedConfig.role !== undefined ? { role: normalizedConfig.role } : {}),
      ...(normalizedConfig.brief !== undefined ? { brief: normalizedConfig.brief } : {}),
      ...(normalizedConfig.launchContext !== undefined ? { launchContext: normalizedConfig.launchContext } : {}),
      ...(normalizedConfig.contextSize !== undefined ? { contextSize: normalizedContextSize.contextSize } : {}),
      ...(normalizedConfig.compactionLimit !== undefined ? { compactionLimit: normalizedConfig.compactionLimit } : {}),
      ...(normalizedConfig.extraArgs !== undefined ? { extraArgs: [...normalizedConfig.extraArgs] } : {}),
    },
  };
}

export type LegacyLaunchParseResult =
  | { ok: true; config: SavedFleetLaunchConfig; saved: SavedFleetLaunchSpec; normalizedLegacyContextSize: boolean;
      originalEvidence?: { snapshot: AdvSessionLaunchRecord; receipt: Record<string, unknown>;
        fieldDispositions: Record<string, 'recipe' | 'launch-only' | 'guard'> } }
  | { ok: false; message: string };

export interface OriginalMemberLaunchBinding {
  advSessionId: number;
  ownerId: string;
  sessionId: string;
  /** Required by historical recovery; never inferred from today's profile. */
  harnessSlug?: string;
}

const originalRecipeFields = [
  'agent', 'model', 'effort', 'account', 'carry', 'headless', 'role', 'stack', 'profile',
  'contextSize', 'compactionLimit', 'addDir', 'allowSubagents', 'brain', 'feature', 'display', 'extraArgs',
] as const;
const originalLaunchOnlyFields = [
  'name', 'count', 'leader', 'supervise', 'brief', 'launchContext', 'perMemberLaunchContext', 'claimKinds',
] as const;
const originalGuardFields = [
  'plan', 'harness', 'workspace', 'type', 'placement', 'confirmRouteSwitch', 'overrideCapacityClamp',
  'confirmClaimCollapse', 'confirmKickoffMismatch',
] as const;

function launchObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim().length > 0) &&
    new Set(value).size === value.length;
}

/** Decode only the original invocation joined by the reader's independent
 * launch epoch. Current argv and current fleet defaults are never inputs.
 * This branch is read-only: its artifact is evidence, not an authority grant. */
function savedHistoricalOriginalMemberLaunchSpec(
  record: AdvSessionLaunchRecord,
  binding: OriginalMemberLaunchBinding,
  workspaceId: string,
  fleetSlug: string,
): LegacyLaunchParseResult {
  const refuse = (message: string): LegacyLaunchParseResult => ({ ok: false, message });
  const source = record.originalMemberHistoricalSource;
  const tx = launchObject(source?.transaction);
  const requestedIds = tx?.requestedMemberIds;
  const openedIds = tx?.openedMemberIds;
  const verifiedIds = tx?.verifiedMemberIds;
  const args = launchObject(source?.invocation.args);
  const current = launchObject(record.launchSpec);
  const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  if (!source || !tx || !args || record.workspaceId !== workspaceId ||
      !binding.harnessSlug || source.workspaceId !== workspaceId || source.fleetSlug !== fleetSlug ||
      source.ownerId !== binding.ownerId || source.advSessionId !== binding.advSessionId ||
      source.currentSessionId !== binding.sessionId || !source.originalSessionId ||
      !Number.isSafeInteger(binding.advSessionId) || binding.advSessionId <= 0 ||
      source.invocation.harnessSlug !== binding.harnessSlug || !id(source.invocation.id) ||
      tx.version !== 1 || typeof tx.transactionId !== 'string' || !tx.transactionId.trim() ||
      tx.previousTransactionId !== undefined || tx.launcherOwnerId !== source.invocation.actor ||
      !source.invocation.actor || !uniqueStrings(requestedIds) ||
      !uniqueStrings(openedIds) || !uniqueStrings(verifiedIds) ||
      !requestedIds.includes(binding.ownerId) || !openedIds.includes(binding.ownerId) ||
      !verifiedIds.includes(binding.ownerId) ||
      openedIds.some(v => !requestedIds.includes(v)) ||
      verifiedIds.some(v => !openedIds.includes(v))) {
    return refuse('Original historical launch epoch, exact scope or requested/opened/verified custody is missing.');
  }
  if (!Array.isArray(tx.requestedMembers) || tx.requestedMembers.length !== requestedIds.length ||
      tx.requestedMembers.some((value, index) => {
        const slot = launchObject(value);
        return !slot || slot.index !== index || slot.ownerId !== requestedIds[index];
      })) return refuse('Original launch member slots are missing, duplicated or not index-aligned.');
  const index = requestedIds.indexOf(binding.ownerId);
  const slot = launchObject(tx.requestedMembers[index])!;
  const allowed = new Set<string>([...originalRecipeFields, ...originalLaunchOnlyFields,
    ...originalGuardFields, 'members']);
  if (Object.keys(args).some(key => !allowed.has(key))) return refuse('Original launch request has an unclassified key.');
  if (args.count !== requestedIds.length ||
      (args.type !== undefined && args.type !== 'single') ||
      (args.placement !== undefined && args.placement !== 'local') ||
      (args.leader !== undefined && args.leader !== 'caller') ||
      (args.workspace !== undefined && args.workspace !== workspaceId) ||
      (args.harness !== undefined && args.harness !== binding.harnessSlug) ||
      (args.plan !== undefined && (typeof args.plan !== 'string' || !args.plan.trim())) ||
      typeof args.name !== 'string' || !args.name.trim() || fleetSlugFromName(args.name) !== fleetSlug) {
    return refuse('Original launch request does not describe this complete local single fleet epoch.');
  }
  if (!memberSpecSchema.pick({ claimKinds: true }).safeParse({ claimKinds: args.claimKinds }).success ||
      (args.plan === undefined && args.claimKinds === undefined)) return refuse('Original scheduling scope is missing or malformed.');
  for (const key of ['supervise', 'confirmRouteSwitch', 'overrideCapacityClamp',
    'confirmClaimCollapse', 'confirmKickoffMismatch']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') return refuse(`Original ${key} is malformed.`);
  }
  for (const key of ['brief', 'launchContext']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') return refuse(`Original ${key} is malformed.`);
  }
  if (args.perMemberLaunchContext !== undefined &&
      (!Array.isArray(args.perMemberLaunchContext) || !args.perMemberLaunchContext.every(v => typeof v === 'string'))) {
    return refuse('Original per-member launch context is malformed.');
  }
  const top = Object.fromEntries(originalRecipeFields.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  // The shared strict member schema is the inventory of supported recipe knobs.
  // Top-level steward context predates its per-member schema; validate it separately.
  const topContext = top.contextSize;
  const normalized = normalizeSuContextSize(topContext);
  if (!normalized.ok) return refuse('Original context policy is malformed.');
  const validatedTop = memberSpecSchema.safeParse({ ...top,
    ...(topContext !== undefined ? { contextSize: 'trimmed' } : {}) });
  if (!validatedTop.success || !Array.isArray(args.members ?? []) ||
      ((args.members ?? []) as unknown[]).length > requestedIds.length) {
    return refuse('Original fleet recipe or member list is malformed.');
  }
  const members: MemberSpec[] = [];
  for (const value of (args.members ?? []) as unknown[]) {
    const parsed = memberSpecSchema.safeParse(value);
    if (!parsed.success) return refuse('Original member request has an unsupported or malformed field.');
    members.push(parsed.data);
  }
  const requested = members[index];
  if (!['claude', 'codex', 'omp'].includes(String(slot.agent)) ||
      typeof slot.model !== 'string' || !splitModelSpec(slot.model).model ||
      typeof slot.account !== 'string' || !slot.account.trim() ||
      !['warm', 'cold'].includes(String(slot.carry)) || typeof slot.headless !== 'boolean' ||
      slot.agent !== record.agent) return refuse('Original member slot lacks a complete route.');
  const folded = foldMemberSpec({ ...validatedTop.data, agent: String(slot.agent),
    ...(topContext !== undefined ? { contextSize: normalized.contextSize } : {}) }, requested);
  const display = requested?.display ?? validatedTop.data.display;
  let model: string | undefined;
  try {
    const originalModel = splitModelSpec(slot.model);
    const requestModel = splitModelSpec(folded.model);
    model = composeLaunchModelSpec(requestModel.model ?? originalModel.model!,
      folded.effort ?? requestModel.effort ?? originalModel.effort ?? undefined);
  } catch { return refuse('Original request model and effort cannot be composed.'); }
  if ((folded.agent !== slot.agent) ||
      (validatedTop.data.agent !== undefined && !requested?.agent && validatedTop.data.agent !== slot.agent) ||
      (model !== undefined && model !== slot.model) ||
      (folded.account !== undefined && folded.account !== slot.account) ||
      (folded.carry !== undefined && folded.carry !== slot.carry) ||
      (folded.headless !== undefined && folded.headless !== slot.headless)) {
    return refuse('Original request route contradicts the indexed original member slot.');
  }
  const first = source.originalApplied;
  const last = source.currentApplied;
  if (!id(first.id) || !id(last.id) || BigInt(first.id) > BigInt(last.id) ||
      (source.originalSessionId !== source.currentSessionId && first.id === last.id) ||
      first.actorId !== binding.ownerId || last.actorId !== binding.ownerId ||
      first.sessionId !== binding.ownerId || last.sessionId !== binding.ownerId ||
      !first.principalId || first.principalId !== last.principalId ||
      first.principalId !== current?.principalId ||
      current.workspaceId !== workspaceId || current.harnessSlug !== binding.harnessSlug ||
      current.specificationRevision !== last.specificationRevision || current.stateRevision !== last.stateRevision ||
      !uniqueStrings(first.stack) || !uniqueStrings(last.stack)) {
    return refuse('Original applied identity/principal/native custody is inconsistent.');
  }
  const receipts = [current, ...(Array.isArray(current?.identityHistory) ? current.identityHistory : [])]
    .map(launchObject).filter((value): value is Record<string, unknown> => value !== null &&
      value.specificationRevision === first.specificationRevision && value.stateRevision === first.stateRevision);
  if (receipts.length !== 1) return refuse('Original applied artifact/state receipt is missing or ambiguous.');
  const receipt = receipts[0];
  try {
    const artifact = replayAgentSpecification(receipt.specificationArtifact);
    const states = artifact.inputs.filter(input => input.kind === 'setting' && input.ref === 'launch-state-v1');
    const statePin = states.length === 1 && states[0].kind === 'setting' ? states[0] : null;
    const state = launchObject(statePin?.value);
    const principal = launchObject(state?.principal);
    const policy = launchObject(state?.policy);
    if (artifact.specificationRevision !== first.specificationRevision ||
        statePin?.revision !== first.stateRevision || state?.schemaVersion !== 1 ||
        principal?.kind !== 'su' || principal.role !== 'su' || typeof principal.profile !== 'string' ||
        !principal.profile || policy?.mcp !== 'superuser' ||
        !['trimmed', 'steward'].includes(String(policy.contextSize)) ||
        !['full', 'fleet'].includes(String(policy.personaTier)) ||
        !valuesEqual(state.stack, first.stack) || !valuesEqual(receipt.stack, first.stack) ||
        (folded.profile !== undefined && folded.profile !== principal.profile) ||
        (folded.contextSize !== undefined && folded.contextSize !== policy.contextSize)) {
      return refuse('Original artifact state does not match its applied principal/profile/policy/stack receipt.');
    }
    const selection = receipt.selectedIdentity;
    if (selection != null) {
      const pin = launchObject(selection);
      const selectedRef = pin?.ref;
      if (!pin || typeof selectedRef !== 'string' ||
          !/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selectedRef) ||
          typeof pin.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sourceRevision) ||
          folded.stack?.length !== 1 || folded.stack[0] !== selectedRef ||
          !artifact.inputs.some(input => input.kind === 'blueprint-layer' &&
            input.ref === selectedRef.slice(selectedRef.indexOf(':') + 1) && input.contentHash === pin.sourceRevision)) {
        return refuse('Original selected identity is not in the replayed source closure.');
      }
    }
    if (folded.stack !== undefined && !valuesEqual(folded.stack, first.stack) &&
        !(folded.stack.length === 1 && launchObject(selection)?.ref === folded.stack[0])) {
      return refuse('Original requested stack differs from its applied identity.');
    }
    const extraArgs = [...(folded.extraArgs ?? [])];
    const seen = new Set<string>();
    // No escape hatch can replace identity, route, native, grant, kickoff or
    // automation controls. Preserve only explicit supported additive tokens.
    for (const token of extraArgs) {
      const match = /^(--add-dir|--feature|--display)=([^\u0000\r\n]+)$/.exec(token);
      if (!match || (match[1] !== '--add-dir' && seen.has(match[1])) ||
          (match[1] === '--feature' && folded.feature !== undefined) ||
          (match[1] === '--display' && display !== undefined)) {
        return refuse('Original extraArgs has an unsupported or duplicate control token.');
      }
      seen.add(match[1]);
    }
    if (folded.allowSubagents === false) extraArgs.push('--no-subagents');
    extraArgs.push(`--persona-tier=${policy.personaTier}`);
    const routeModel = splitModelSpec(slot.model);
    const config: SavedFleetLaunchConfig = {
      ...(typeof args.plan === 'string' ? { plan: args.plan } : {}), harness: binding.harnessSlug,
      agent: slot.agent as FleetHeadcountConfig['agent'], model: routeModel.model!,
      ...(routeModel.effort ? { effort: routeModel.effort } : {}), account: slot.account,
      carry: slot.carry as 'warm' | 'cold', headless: slot.headless,
      ...(folded.role ? { role: folded.role } : {}),
      contextSize: policy.contextSize as 'trimmed' | 'steward',
      ...(folded.compactionLimit !== undefined ? { compactionLimit: folded.compactionLimit } : {}),
      ...(extraArgs.length ? { extraArgs } : {}),
    };
    const saved = savedFleetLaunchSpecFromConfig(config);
    saved.member = { ...saved.member, profile: principal.profile, stack: [...first.stack],
      ...(folded.addDir ? { addDir: [...folded.addDir] } : {}),
      ...(folded.allowSubagents !== undefined ? { allowSubagents: folded.allowSubagents } : {}),
      ...(folded.brain !== undefined ? { brain: folded.brain } : {}),
      ...(folded.feature !== undefined ? { feature: folded.feature } : {}),
      ...(display !== undefined ? { display } : {}) };
    const fieldDispositions: Record<string, 'recipe' | 'launch-only' | 'guard'> = {};
    for (const key of Object.keys(args)) fieldDispositions[key] = originalRecipeFields.includes(key as never)
      ? 'recipe' : originalLaunchOnlyFields.includes(key as never) ? 'launch-only' : 'guard';
    for (const key of Object.keys(requested ?? {})) fieldDispositions[`members[${index}].${key}`] =
      ['brief', 'launchContext', 'claimKinds'].includes(key) ? 'launch-only' : 'recipe';
    return { ok: true, config, saved, normalizedLegacyContextSize: normalized.normalizedLegacyFull,
      originalEvidence: { snapshot: structuredClone(record), receipt: structuredClone(receipt), fieldDispositions } };
  } catch {
    return refuse('Original artifact cannot be replayed from its exact retained source closure.');
  }
}

/** Original means the lifecycle receipt captured before the first resume,
 * never the owner's newest launch or the current fleet recipe. Legacy rows
 * that already lost that provenance need independent recovery evidence. */
export function savedOriginalMemberLaunchSpec(
  record: AdvSessionLaunchRecord | null,
  binding: OriginalMemberLaunchBinding,
  workspaceId: string,
  fleetSlug: string,
): LegacyLaunchParseResult {
  const spec = record?.launchSpec as Record<string, unknown> | null;
  if (record && spec && !Object.prototype.hasOwnProperty.call(spec, 'originalMemberLaunch')) {
    return savedHistoricalOriginalMemberLaunchSpec(record, binding, workspaceId, fleetSlug);
  }
  const original = spec?.originalMemberLaunch as Record<string, unknown> | undefined;
  const custody = record?.originalMemberNativeCustody;
  const nativeMatches = original?.sessionId === binding.sessionId ||
    (custody?.workspaceId === workspaceId && custody.advSessionId === binding.advSessionId &&
      custody.ownerId === binding.ownerId && custody.originalSessionId === original?.sessionId &&
      custody.currentSessionId === binding.sessionId &&
      /^[1-9][0-9]*$/.test(custody.originalEventId) && /^[1-9][0-9]*$/.test(custody.reanchorEventId) &&
      custody.originalEventId !== custody.reanchorEventId);
  if (!record || record.workspaceId !== workspaceId || !original || original.v !== 1 ||
      original.advSessionId !== binding.advSessionId || original.ownerId !== binding.ownerId ||
      !nativeMatches || original.workspaceId !== workspaceId ||
      original.agent !== record.agent) {
    return { ok: false, message: 'Original member routing provenance is missing or its exact row/native/owner binding changed.' };
  }
  const parsed = savedFleetLaunchSpecFromLegacyRecord(original as unknown as AdvSessionLaunchRecord, workspaceId, fleetSlug);
  if (parsed.ok && (!parsed.config.account || !parsed.config.model || !parsed.config.carry))
    return { ok: false, message: 'Original member routing receipt lacks account, model or carry; refusing reconstruction.' };
  return parsed;
}

/** Trusted values a recovery caller may supply only to fill absent legacy fields. */
export interface LegacyLaunchSpecFallbacks {
  /** Explicit respawn agent override, used when both legacy sources omit the agent. */
  agent?: string;
  /** Target-member pot/harness context or a concrete caller harness. */
  harness?: string;
  /** Current membership read from the durable ledger by the recovery caller.
   * Permits a source that originally launched outside a fleet to rejoin it. */
  postLaunchFleet?: string;
}

const LEGACY_AGENTS = new Set<FleetHeadcountConfig['agent']>(['claude', 'omp', 'codex']);
const LEGACY_CARRY = new Set<NonNullable<FleetHeadcountConfig['carry']>>(['warm', 'cold']);

function argFlag(argv: readonly string[], flag: string): string | null {
  return flagValueFromArgv(argv, flag);
}

function booleanFlag(argv: readonly string[], flag: string): boolean {
  const bare = `--${flag}`;
  return argv.some((item) => item === bare || new RegExp(`(?:^|\\s)${bare}(?:\\s|$)`).test(item));
}

function matchingValue(
  label: string,
  stored: string | null,
  recorded: string | null,
): { value: string | null; error?: string } {
  if (stored && recorded && stored !== recorded) {
    return { value: null, error: `${label} differs between launch_spec (${stored}) and launch_argv (${recorded})` };
  }
  return { value: stored ?? recorded };
}

/**
 * Convert one legacy adv_sessions record into the same command-neutral recipe
 * used by the canonical fleet target. This is deliberately strict: a legacy
 * row is useful only when its owner, workspace, fleet membership, and recorded
 * argv all attest to the same launch. Missing data stays an error rather than
 * becoming a fresh launch with guessed defaults. The only exceptions are
 * explicit, trusted recovery fallbacks for fields older records never stored.
 */
export function savedFleetLaunchSpecFromLegacyRecord(
  record: AdvSessionLaunchRecord,
  workspaceId: string,
  fleetSlug: string,
  fallbacks: LegacyLaunchSpecFallbacks = {},
): LegacyLaunchParseResult {
  if (!record || record.workspaceId !== workspaceId) {
    return {
      ok: false,
      message: `Legacy adv_sessions launch record workspace does not match requested workspace \`${workspaceId}\`.`,
    };
  }
  const rawLaunchSpec =
    record.launchSpec && typeof record.launchSpec === 'object' && !Array.isArray(record.launchSpec)
      ? record.launchSpec as Record<string, unknown>
      : null;
  if (!rawLaunchSpec) return { ok: false, message: 'Legacy adv_sessions launch_spec is missing or malformed.' };
  if (!Array.isArray(record.launchArgv) || !record.launchArgv.every((item) => typeof item === 'string')) {
    return { ok: false, message: 'Legacy adv_sessions launch_argv is missing or malformed.' };
  }
  const argv = record.launchArgv as string[];
  const recordedFleet = argFlag(argv, 'fleet')?.trim() || null;
  const rawFleet =
    rawLaunchSpec.fleet && typeof rawLaunchSpec.fleet === 'object' && !Array.isArray(rawLaunchSpec.fleet)
      ? rawLaunchSpec.fleet as Record<string, unknown>
      : null;
  const storedFleet = typeof rawFleet?.slug === 'string' && rawFleet.slug.trim()
    ? rawFleet.slug.trim()
    : null;
  const joinedAfterLaunch = recordedFleet === null && storedFleet === null &&
    fallbacks.postLaunchFleet === fleetSlug;
  if ((!recordedFleet || !storedFleet) && !joinedAfterLaunch) {
    return { ok: false, message: 'Legacy launch record fleet is missing from launch_spec or launch_argv.' };
  }
  // The member target has already established the live fleet. A legacy member
  // can legitimately have been moved/rejoined since its launch record was
  // written, so compare the two persisted source attestations with each other
  // rather than rejecting a stale source fleet against the live target. The
  // caller supplies `fleetSlug` to the replacement launch separately.
  if (storedFleet !== recordedFleet) {
    return {
      ok: false,
      message: `fleet differs between launch_spec (${storedFleet}) and launch_argv (${recordedFleet})`,
    };
  }

  // Older launch_spec/argv rows can omit agent even though adv_sessions.agent
  // recorded the backend at launch. Reuse that persisted column before an
  // explicit recovery fallback; never guess a system/default agent.
  const recordedAgent = argFlag(argv, 'agent');
  const storedAgent = typeof rawLaunchSpec.agent === 'string' && rawLaunchSpec.agent.trim()
    ? rawLaunchSpec.agent
    : null;
  const persistedAgent = typeof record.agent === 'string' && record.agent.trim()
    ? record.agent
    : null;
  const storedVsArgvAgent = matchingValue('agent', storedAgent, recordedAgent);
  if (storedVsArgvAgent.error) return { ok: false, message: storedVsArgvAgent.error };
  if (storedVsArgvAgent.value && persistedAgent && storedVsArgvAgent.value !== persistedAgent) {
    return {
      ok: false,
      message: `agent differs between legacy launch record (${storedVsArgvAgent.value}) and adv_sessions.agent (${persistedAgent})`,
    };
  }
  const effectiveAgent = storedVsArgvAgent.value ?? persistedAgent ?? fallbacks.agent ?? null;
  const launch = parseSuLaunchSpecRecord({
    ...rawLaunchSpec,
    ...(effectiveAgent ? { agent: effectiveAgent } : {}),
  });
  if (!launch) return { ok: false, message: 'Legacy adv_sessions launch_spec is missing or malformed.' };
  if (launch.workspaceId !== workspaceId) {
    return { ok: false, message: `Legacy launch_spec workspace \`${launch.workspaceId}\` does not match \`${workspaceId}\`.` };
  }
  if ((launch.fleet?.slug ?? null) !== storedFleet) {
    return { ok: false, message: `Legacy launch_spec fleet does not match its recorded fleet \`${storedFleet}\`.` };
  }

  const plan = matchingValue('plan', launch.planSlug, argFlag(argv, 'plan'));
  const harness = matchingValue('harness', launch.harnessSlug, argFlag(argv, 'harness'));
  if (plan.error || harness.error) {
    return { ok: false, message: plan.error ?? harness.error! };
  }
  const fallbackHarness = fallbacks.harness?.trim() || null;
  const effectiveHarness = harness.value ?? fallbackHarness;
  if (!effectiveHarness || !effectiveAgent || !LEGACY_AGENTS.has(effectiveAgent as FleetHeadcountConfig['agent'])) {
    return { ok: false, message: 'Legacy launch record lacks a valid harness or agent.' };
  }

  const recordedModel = modelSpecFromArgv(argv);
  const storedModel = launch.model;
  if (storedModel && recordedModel) {
    const stored = splitModelSpec(storedModel);
    const recorded = splitModelSpec(recordedModel);
    if (stored.model !== recorded.model || (stored.effort && recorded.effort && stored.effort !== recorded.effort)) {
      return { ok: false, message: `model differs between launch_spec (${storedModel}) and launch_argv (${recordedModel})` };
    }
  }
  const modelSpec = recordedModel ?? storedModel;
  const model = splitModelSpec(modelSpec);

  const account = accountFromArgv(argv);
  const carryRaw = argFlag(argv, 'carry');
  if (carryRaw && !LEGACY_CARRY.has(carryRaw as NonNullable<FleetHeadcountConfig['carry']>)) {
    return { ok: false, message: `Legacy launch_argv has invalid carry \`${carryRaw}\`.` };
  }
  const contextSizeRaw = argFlag(argv, 'context-size');
  const normalizedContextSize = normalizeSuContextSize(contextSizeRaw);
  if (!normalizedContextSize.ok) return { ok: false, message: `Legacy launch_argv has invalid context size \`${contextSizeRaw}\`.` };
  const compactionRaw = argFlag(argv, 'compaction-limit');
  let compactionLimit: number | undefined;
  if (compactionRaw != null) {
    const parsedCompactionLimit = Number(compactionRaw);
    if (!Number.isSafeInteger(parsedCompactionLimit) || parsedCompactionLimit <= 0) {
      return { ok: false, message: `Legacy launch_argv has invalid compaction limit \`${compactionRaw}\`.` };
    }
    compactionLimit = parsedCompactionLimit;
  }

  // These flags are not first-class FleetHeadcountConfig fields, but they are
  // safe, supported psu passthroughs and must not silently disappear on a
  // respawn. Preserve token-shaped records; shell-command records are handled
  // by the dedicated first-class parsers above.
  const extraArgs = argv.filter((item) =>
    item === '--brain' || item === '--allow-subagents' || item === '--no-subagents' ||
    item.startsWith('--feature=') || item.startsWith('--profile=') || item.startsWith('--add-dir='),
  );
  const config = normalizePersistedFleetLaunchConfig({
    ...(plan.value ? { plan: plan.value } : {}),
    harness: effectiveHarness,
    agent: effectiveAgent as FleetHeadcountConfig['agent'],
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(account ? { account } : {}),
    headless: booleanFlag(argv, 'headless'),
    ...(carryRaw ? { carry: carryRaw as FleetHeadcountConfig['carry'] } : {}),
    ...(argFlag(argv, 'role') ? { role: argFlag(argv, 'role')! } : {}),
    ...(argFlag(argv, 'launch-context') ? { launchContext: argFlag(argv, 'launch-context')! } : {}),
    ...(contextSizeRaw ? { contextSize: normalizedContextSize.contextSize } : {}),
    ...(compactionLimit !== undefined ? { compactionLimit } : {}),
    ...(extraArgs.length ? { extraArgs } : {}),
  });
  return {
    ok: true,
    config,
    saved: savedFleetLaunchSpecFromConfig(config),
    normalizedLegacyContextSize: normalizedContextSize.normalizedLegacyFull,
  };
}

function cloneSpec(spec: SavedFleetLaunchSpec): SavedFleetLaunchSpec {
  return {
    plan: spec.plan,
    harness: spec.harness,
    member: {
      ...spec.member,
      ...(spec.member.extraArgs ? { extraArgs: [...spec.member.extraArgs] } : {}),
    },
  };
}

function requestedFieldPresent(requested: SavedFleetLaunchSpecRequest, field: SavedFleetLaunchField): boolean {
  if (field === 'model') return requested.model !== undefined || requested.effort !== undefined;
  return requested[field] !== undefined;
}

function canonicalModel(spec: SavedFleetLaunchSpec): string | undefined {
  return composeLaunchModelSpec(spec.member.model, spec.member.effort);
}

function fieldValue(spec: SavedFleetLaunchSpec, field: SavedFleetLaunchField): unknown {
  if (field === 'plan' || field === 'harness') return spec[field];
  if (field === 'model') return canonicalModel(spec);
  return spec.member[field as keyof MemberSpec];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyRequest(saved: SavedFleetLaunchSpec, requested: SavedFleetLaunchSpecRequest): SavedFleetLaunchSpec {
  const effective = cloneSpec(saved);
  if (requested.plan !== undefined) effective.plan = requested.plan;
  if (requested.harness !== undefined) effective.harness = requested.harness;

  if (requested.model !== undefined) {
    const split = splitModelSpec(requested.model);
    if (split.model === null) delete effective.member.model;
    else effective.member.model = split.model;
    // A suffixed model explicitly carries effort. A bare model preserves the
    // saved effort because omission is fallthrough, never an implicit reset.
    if (split.effort !== null) effective.member.effort = split.effort;
  }
  if (requested.effort !== undefined) effective.member.effort = requested.effort;

  const directFields: readonly Exclude<SavedFleetLaunchField, 'plan' | 'harness' | 'model'>[] = [
    'agent',
    'account',
    'headless',
    'carry',
    'role',
    'brief',
    'launchContext',
    'contextSize',
    'compactionLimit',
    'extraArgs',
  ];
  for (const field of directFields) {
    const value = requested[field];
    if (value === undefined) continue;
    (effective.member as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
  }
  return effective;
}

function diagnostic(
  field: string,
  saved: unknown,
  requested: unknown,
  provenance: SavedFleetLaunchSpecProvenance,
  reusePath: string,
): SavedFleetLaunchSpecDelta {
  return { field, saved, requested, provenance, reusePath };
}

function reconstructionConflicts(
  requested: SavedFleetLaunchSpecRequest,
  provenance: SavedFleetLaunchSpecProvenance,
  reusePath: string,
): SavedFleetLaunchSpecDelta[] {
  const conflicts: SavedFleetLaunchSpecDelta[] = [];
  if (requested.members?.length) {
    conflicts.push(
      diagnostic(
        'members',
        'fleet-wide persisted profile',
        `${requested.members.length} member override(s)`,
        provenance,
        reusePath,
      ),
    );
  }
  if (requested.perMemberLaunchContext?.length) {
    conflicts.push(
      diagnostic(
        'perMemberLaunchContext',
        'fleet-wide persisted launchContext',
        `${requested.perMemberLaunchContext.length} per-member launch context override(s)`,
        provenance,
        reusePath,
      ),
    );
  }
  if (requested.claimKinds?.length) {
    conflicts.push(
      diagnostic(
        'claimKinds',
        'fleet claim spec (preserved separately)',
        [...requested.claimKinds],
        provenance,
        reusePath,
      ),
    );
  }
  for (const field of ['addDir', 'allowSubagents', 'brain', 'feature', 'profile', 'display'] as const) {
    const value = requested[field];
    if (value === undefined) continue;
    conflicts.push(diagnostic(field, 'not present in canonical fleet launch spec', value, provenance, reusePath));
  }
  return conflicts;
}

/**
 * Merge an already-read target with a request. Only fields named in
 * `allowDeltas` may differ; every other difference is a fail-closed conflict.
 */
export function resolveLoadedSavedFleetLaunchSpec(opts: {
  target: FleetHeadcountTarget | null;
  saved?: SavedFleetLaunchSpec | null;
  config?: SavedFleetLaunchConfig | null;
  source?: SavedFleetLaunchSpecSource;
  syntheticTarget?: number;
  workspaceId: string;
  fleetSlug: string;
  requested?: SavedFleetLaunchSpecRequest;
  allowDeltas?: readonly SavedFleetLaunchField[];
  reusePath: string;
  requireSaved?: boolean;
  normalizedLegacyContextSize?: boolean;
}): SavedFleetLaunchSpecResolution {
  const { target, workspaceId, fleetSlug, reusePath } = opts;
  const provenance = provenanceFor(workspaceId, fleetSlug, target?.target ?? null, opts.source);
  if (!target && !opts.saved) {
    if (opts.requireSaved) {
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_missing',
        message: `No saved launch spec exists for fleet \`${fleetSlug}\`; refusing recovery through ${reusePath}.`,
        conflicts: [],
        provenance,
        reusePath,
      };
    }
    return { ok: true, found: false, provenance, reusePath };
  }

  const requested = opts.requested ?? {};
  const rawConfig = target?.config ?? opts.config;
  if (!rawConfig) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_invalid',
      message: `Saved launch spec for fleet \`${fleetSlug}\` has no reconstructible config; refusing recovery through ${reusePath}.`,
      conflicts: [],
      provenance,
      reusePath,
    };
  }
  const config = normalizePersistedFleetLaunchConfig(rawConfig);
  const saved = normalizePersistedFleetLaunchSpec(
    opts.saved ?? savedFleetLaunchSpecFromConfig(config),
  );
  let effective: SavedFleetLaunchSpec;
  try {
    // Validate both the stored model/effort pair and the requested merge before
    // comparing. An invalid persisted recipe is not an invitation to default.
    canonicalModel(saved);
    effective = applyRequest(saved, requested);
    canonicalModel(effective);
  } catch (error) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_invalid',
      message: `Invalid ${provenance.source} launch spec for fleet \`${fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing recovery through ${reusePath}.`,
      conflicts: [],
      provenance,
      reusePath,
    };
  }

  const allowed = new Set(opts.allowDeltas ?? []);
  const overrides: SavedFleetLaunchSpecDelta[] = [];
  const conflicts = reconstructionConflicts(requested, provenance, reusePath);
  const preservedFields: SavedFleetLaunchField[] = [];
  for (const field of SAVED_FIELD_ORDER) {
    if (!requestedFieldPresent(requested, field)) {
      if (fieldValue(saved, field) !== undefined) preservedFields.push(field);
      continue;
    }
    const savedValue = fieldValue(saved, field);
    const requestedValue = fieldValue(effective, field);
    if (valuesEqual(savedValue, requestedValue)) continue;
    const row = diagnostic(field, savedValue, requestedValue, provenance, reusePath);
    if (allowed.has(field)) overrides.push(row);
    else conflicts.push(row);
  }

  if (conflicts.length) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_conflict',
      message: `Saved launch spec conflict for fleet \`${fleetSlug}\` through ${reusePath}: ${JSON.stringify(conflicts)}.`,
      conflicts,
      provenance,
      reusePath,
    };
  }
  return {
    ok: true,
    found: true,
    target: target?.target ?? opts.syntheticTarget ?? 1,
    config,
    saved,
    effective,
    preservedFields,
    overrides,
    deprecations:
      target?.normalizedLegacyContextSize || opts.normalizedLegacyContextSize
        ? ['Saved contextSize=full is deprecated and was normalized to trimmed before launch.']
        : [],
    provenance,
    reusePath,
  };
}

/** Read the canonical row and apply the same pure fail-closed merge. */
export async function resolveSavedFleetLaunchSpec(opts: {
  workspaceId: string;
  fleetSlug: string;
  requested?: SavedFleetLaunchSpecRequest;
  allowDeltas?: readonly SavedFleetLaunchField[];
  reusePath: string;
  requireSaved?: boolean;
  readTarget?: typeof getFleetHeadcountTarget;
  memberOwnerId?: string;
  /** Read this owner's durable launch record before the fleet-wide recipe. Used
   * by retained-leader recovery, where the leader's own settings are authoritative. */
  preferMemberRecord?: boolean;
  readLegacy?: typeof readAdvSessionLaunchRecordByOwner;
  legacyFallbacks?: LegacyLaunchSpecFallbacks;
}): Promise<SavedFleetLaunchSpecResolution> {
  const readTarget = opts.readTarget ?? getFleetHeadcountTarget;
  if (opts.preferMemberRecord && opts.memberOwnerId) {
    const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null, LEGACY_FLEET_LAUNCH_SPEC_SOURCE);
    let legacy: AdvSessionLaunchRecord | null;
    try {
      legacy = await (opts.readLegacy ?? readAdvSessionLaunchRecordByOwner)(opts.memberOwnerId, opts.workspaceId);
    } catch (error) {
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_read_failed',
        message: `Could not read the retained leader launch spec for fleet \`${opts.fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing recovery through ${opts.reusePath}.`,
        conflicts: [],
        provenance,
        reusePath: opts.reusePath,
      };
    }
    if (!legacy) {
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_missing',
        message: `No retained leader launch spec exists for owner \`${opts.memberOwnerId}\` in fleet \`${opts.fleetSlug}\`; refusing recovery through ${opts.reusePath}.`,
        conflicts: [],
        provenance,
        reusePath: opts.reusePath,
      };
    }
    const parsed = savedFleetLaunchSpecFromLegacyRecord(
      legacy,
      opts.workspaceId,
      opts.fleetSlug,
      opts.legacyFallbacks,
    );
    if (!parsed.ok) {
      return {
        ok: false,
        found: true,
        error: 'saved_launch_spec_invalid',
        message: `${parsed.message} Refusing recovery through ${opts.reusePath}.`,
        conflicts: [],
        provenance,
        reusePath: opts.reusePath,
      };
    }
    return resolveLoadedSavedFleetLaunchSpec({
      ...opts,
      target: null,
      saved: parsed.saved,
      config: parsed.config,
      source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE,
      syntheticTarget: 1,
      normalizedLegacyContextSize: parsed.normalizedLegacyContextSize,
    });
  }
  let target: FleetHeadcountTarget | null;
  try {
    target = await readTarget(opts.workspaceId, opts.fleetSlug);
  } catch (error) {
    const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null);
    return {
      ok: false,
      found: false,
      error: 'saved_launch_spec_read_failed',
      message: `Could not read the canonical saved launch spec for fleet \`${opts.fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing reconstruction through ${opts.reusePath}.`,
      conflicts: [],
      provenance,
      reusePath: opts.reusePath,
    };
  }
  if (!target && opts.memberOwnerId) {
    let legacy: AdvSessionLaunchRecord | null;
    try {
      legacy = await (opts.readLegacy ?? readAdvSessionLaunchRecordByOwner)(opts.memberOwnerId, opts.workspaceId);
    } catch (error) {
      const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null, LEGACY_FLEET_LAUNCH_SPEC_SOURCE);
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_read_failed',
        message: `Could not read the legacy saved launch spec for fleet \`${opts.fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing reconstruction through ${opts.reusePath}.`,
        conflicts: [],
        provenance,
        reusePath: opts.reusePath,
      };
    }
    if (legacy) {
      const parsed = savedFleetLaunchSpecFromLegacyRecord(
        legacy,
        opts.workspaceId,
        opts.fleetSlug,
        opts.legacyFallbacks,
      );
      if (!parsed.ok) {
        const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null, LEGACY_FLEET_LAUNCH_SPEC_SOURCE);
        return {
          ok: false,
          found: true,
          error: 'saved_launch_spec_invalid',
          message: `${parsed.message} Refusing recovery through ${opts.reusePath}.`,
          conflicts: [],
          provenance,
          reusePath: opts.reusePath,
        };
      }
      return resolveLoadedSavedFleetLaunchSpec({
        ...opts,
        target: null,
        saved: parsed.saved,
        config: parsed.config,
        source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE,
        syntheticTarget: 1,
        normalizedLegacyContextSize: parsed.normalizedLegacyContextSize,
      });
    }
  }
  return resolveLoadedSavedFleetLaunchSpec({ ...opts, target });
}
