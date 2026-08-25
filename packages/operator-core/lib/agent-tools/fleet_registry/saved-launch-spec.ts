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
  getFleetHeadcountTarget,
  type FleetHeadcountConfig,
  type FleetHeadcountTarget,
} from '../../agent-fleets-store';
import type { MemberSpec } from '../../agent-launch-core';
import { readAdvSessionLaunchRecordByOwner, type AdvSessionLaunchRecord } from '../../adv-sessions';
import { parseSuLaunchSpecRecord } from '../../su-persona-render';

export const SAVED_FLEET_LAUNCH_SPEC_SOURCE = 'fleet:headcount-target' as const;
export const LEGACY_FLEET_LAUNCH_SPEC_SOURCE = 'adv_sessions.launch_spec' as const;
export type SavedFleetLaunchSpecSource =
  | typeof SAVED_FLEET_LAUNCH_SPEC_SOURCE
  | typeof LEGACY_FLEET_LAUNCH_SPEC_SOURCE;

/**
 * Canonical headcount rows require a plan, while a legacy member may have
 * been launched through the planless capability:launch-agent door. Keep that
 * distinction local to recovery rather than weakening FleetHeadcountConfig.
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
  contextSize?: 'full' | 'trimmed';
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
export function savedFleetLaunchSpecFromConfig(config: FleetHeadcountConfig): SavedFleetLaunchSpec {
  return {
    ...(config.plan !== undefined ? { plan: config.plan } : {}),
    harness: config.harness,
    member: {
      agent: config.agent,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.effort !== undefined ? { effort: config.effort } : {}),
      ...(config.account !== undefined ? { account: config.account } : {}),
      headless: config.headless ?? true,
      ...(config.carry !== undefined ? { carry: config.carry } : {}),
      ...(config.role !== undefined ? { role: config.role } : {}),
      ...(config.brief !== undefined ? { brief: config.brief } : {}),
      ...(config.launchContext !== undefined ? { launchContext: config.launchContext } : {}),
      ...(config.contextSize !== undefined ? { contextSize: config.contextSize } : {}),
      ...(config.compactionLimit !== undefined ? { compactionLimit: config.compactionLimit } : {}),
      ...(config.extraArgs !== undefined ? { extraArgs: [...config.extraArgs] } : {}),
    },
  };
}

export type LegacyLaunchParseResult =
  | { ok: true; config: SavedFleetLaunchConfig; saved: SavedFleetLaunchSpec }
  | { ok: false; message: string };

/** Trusted values a recovery caller may supply only to fill absent legacy fields. */
export interface LegacyLaunchSpecFallbacks {
  /** Explicit respawn agent override, used when both legacy sources omit the agent. */
  agent?: string;
  /** Target-member pot/harness context or a concrete caller harness. */
  harness?: string;
}

const LEGACY_AGENTS = new Set<FleetHeadcountConfig['agent']>(['claude', 'omp', 'codex']);
const LEGACY_CARRY = new Set<NonNullable<FleetHeadcountConfig['carry']>>(['warm', 'cold']);
const LEGACY_CONTEXT_SIZES = new Set<NonNullable<FleetHeadcountConfig['contextSize']>>(['full', 'trimmed']);

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
  const recordedFleet = argFlag(argv, 'fleet');
  if (recordedFleet !== fleetSlug) {
    return { ok: false, message: `Legacy launch_argv fleet does not match requested fleet \`${fleetSlug}\`.` };
  }

  // Older launch_spec rows can omit agent while launch_argv may still attest it.
  // If both legacy sources omitted it, only an explicit recovery fallback may
  // fill it; no system/default agent is guessed here.
  const recordedAgent = argFlag(argv, 'agent');
  const storedAgent = typeof rawLaunchSpec.agent === 'string' && rawLaunchSpec.agent.trim()
    ? rawLaunchSpec.agent
    : null;
  const launch = parseSuLaunchSpecRecord({
    ...rawLaunchSpec,
    ...(storedAgent || recordedAgent || fallbacks.agent
      ? { agent: storedAgent ?? recordedAgent ?? fallbacks.agent }
      : {}),
  });
  if (!launch) return { ok: false, message: 'Legacy adv_sessions launch_spec is missing or malformed.' };
  if (launch.workspaceId !== workspaceId) {
    return { ok: false, message: `Legacy launch_spec workspace \`${launch.workspaceId}\` does not match \`${workspaceId}\`.` };
  }
  if (launch.fleet?.slug !== fleetSlug) {
    return { ok: false, message: `Legacy launch_spec fleet does not match requested fleet \`${fleetSlug}\`.` };
  }

  const plan = matchingValue('plan', launch.planSlug, argFlag(argv, 'plan'));
  const harness = matchingValue('harness', launch.harnessSlug, argFlag(argv, 'harness'));
  const agent = matchingValue('agent', launch.agent, argFlag(argv, 'agent'));
  if (plan.error || harness.error || agent.error) {
    return { ok: false, message: plan.error ?? harness.error ?? agent.error! };
  }
  const fallbackHarness = fallbacks.harness?.trim() || null;
  const effectiveHarness = harness.value ?? fallbackHarness;
  if (!effectiveHarness || !agent.value || !LEGACY_AGENTS.has(agent.value as FleetHeadcountConfig['agent'])) {
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
  if (contextSizeRaw && !LEGACY_CONTEXT_SIZES.has(contextSizeRaw as NonNullable<FleetHeadcountConfig['contextSize']>)) {
    return { ok: false, message: `Legacy launch_argv has invalid context size \`${contextSizeRaw}\`.` };
  }
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
  const config: SavedFleetLaunchConfig = {
    ...(plan.value ? { plan: plan.value } : {}),
    harness: effectiveHarness,
    agent: agent.value as FleetHeadcountConfig['agent'],
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(account ? { account } : {}),
    headless: booleanFlag(argv, 'headless'),
    ...(carryRaw ? { carry: carryRaw as FleetHeadcountConfig['carry'] } : {}),
    ...(argFlag(argv, 'role') ? { role: argFlag(argv, 'role')! } : {}),
    ...(argFlag(argv, 'launch-context') ? { launchContext: argFlag(argv, 'launch-context')! } : {}),
    ...(contextSizeRaw ? { contextSize: contextSizeRaw as FleetHeadcountConfig['contextSize'] } : {}),
    ...(compactionLimit !== undefined ? { compactionLimit } : {}),
    ...(extraArgs.length ? { extraArgs } : {}),
  };
  return { ok: true, config, saved: savedFleetLaunchSpecFromConfig(config) };
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
  const saved = opts.saved ?? savedFleetLaunchSpecFromConfig(target!.config);
  const config = target?.config ?? opts.config;
  if (!config) {
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
  readLegacy?: typeof readAdvSessionLaunchRecordByOwner;
  legacyFallbacks?: LegacyLaunchSpecFallbacks;
}): Promise<SavedFleetLaunchSpecResolution> {
  const readTarget = opts.readTarget ?? getFleetHeadcountTarget;
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
      });
    }
  }
  return resolveLoadedSavedFleetLaunchSpec({ ...opts, target });
}
