/**
 * Production controller for the P-046 workspace-host canary (D-132 / WI-42252).
 *
 * This module composes the existing initialization and credential-lifecycle runners. It does
 * not implement another host protocol, replay store, provider controller, or destroy path.
 * Stable phase operation ids make a repeated run resume through the runners' existing durable
 * replay store; the ordered plans and receipts remain available in the result for evidence.
 */
import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CANARY_AGENTS,
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  adaptWorkspaceHostDestroyCanaryEvidence,
  buildWorkspaceHostBackupCredentialManifest,
  buildWorkspaceHostBackupRestoreCredentialRebindRequest,
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  type WorkspaceHostAgentVerificationEvidence,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostBackupCredentialManifest,
  type WorkspaceHostBackupRestoreCredentialRebindRequest,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostCredentialRefs,
  type WorkspaceHostCredentialTeardownObservation,
  type WorkspaceHostDeliveryCapabilities,
  type WorkspaceHostDestroyCanaryEvidenceContract,
  type WorkspaceHostDestroyOperationObservation,
  type WorkspaceHostInitializationHostOperations,
  type WorkspaceHostInitializationSource,
  type WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import {
  assembleWorkspaceHostCanaryEvidence,
  type WorkspaceHostCanaryAssembly,
  type WorkspaceHostCanaryLifecycleRun,
} from './canary-evidence-assembler';
import {
  runWorkspaceHostCredentialLifecycle,
  type WorkspaceHostCredentialLifecycleRunAction,
  type WorkspaceHostCredentialLifecycleRunInput,
  type WorkspaceHostCredentialLifecycleRunResult,
} from './credential-lifecycle-runner';
import {
  runWorkspaceHostInitialization,
  type WorkspaceHostInitializationRunInput,
  type WorkspaceHostInitializationRunResult,
} from './initialization-runner';
import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';

export const WORKSPACE_HOST_CANARY_PHASES = ['initialize', 'rotate', 'revoke', 'reconnect', 'restore-rebind'] as const;
export type WorkspaceHostCanaryPhase = (typeof WORKSPACE_HOST_CANARY_PHASES)[number];

const CANARY_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

export interface WorkspaceHostCanaryCredentialGeneration {
  readonly credentialRefs: WorkspaceHostCredentialRefs;
  readonly delivery: WorkspaceHostCredentialDeliverySet;
}

/** Provider-produced observations supplied only after the existing destroy controller finishes. */
export interface WorkspaceHostCanaryDestroyFinalizationInput {
  readonly operationId: string;
  readonly credentialTeardown: readonly WorkspaceHostCredentialTeardownObservation[];
  readonly teardown: WorkspaceHostDestroyOperationObservation;
  readonly destroyEvidence: WorkspaceHostDestroyCanaryEvidenceContract;
}

export interface WorkspaceHostCanaryRunInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  /** Required so retries rebuild byte-identical plans and therefore reuse replay identities. */
  readonly requestedAt: string;
  readonly source: WorkspaceHostInitializationSource;
  readonly credentials: {
    readonly initial: WorkspaceHostCanaryCredentialGeneration;
    readonly rotated: WorkspaceHostCanaryCredentialGeneration;
    readonly restored: WorkspaceHostCanaryCredentialGeneration;
  };
  readonly operations: WorkspaceHostInitializationHostOperations;
  /**
   * The executing provider's declared transport features — pass the provider's real profile
   * (`profile.transportProfile.features`). The canary binds git and agent channels, so a provider
   * declaring `fileTransfer: false` is refused in preflight rather than after a VM is provisioned.
   */
  readonly deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  /** Exact encrypted-store source reused by the initialization admission guard and host delivery. */
  readonly credentialMaterialSource: WorkspaceHostCredentialMaterialSource;
  /**
   * Omit on the first pass. After the existing destroy controller returns provider reads and a
   * clean census, repeat the same run with this field; every host phase replays durably and the
   * lane-I adapter validates the post-teardown evidence without touching the absent host.
   */
  readonly destroyFinalization?: WorkspaceHostCanaryDestroyFinalizationInput;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
  readonly onPhaseStart?: (phase: WorkspaceHostCanaryPhase, operationId: string) => void;
}

export interface WorkspaceHostCanaryLifecyclePhaseResult {
  readonly phase: Exclude<WorkspaceHostCanaryPhase, 'initialize'>;
  readonly result: WorkspaceHostCredentialLifecycleRunResult;
}

export interface WorkspaceHostCanaryRunResult {
  readonly runId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly requestedAt: string;
  readonly operationIds: Readonly<Record<WorkspaceHostCanaryPhase, string>>;
  readonly initialization: WorkspaceHostInitializationRunResult;
  readonly lifecycle: readonly WorkspaceHostCanaryLifecyclePhaseResult[];
  readonly backupManifest: WorkspaceHostBackupCredentialManifest;
  readonly restoreRebindRequest: WorkspaceHostBackupRestoreCredentialRebindRequest;
  readonly assembly: WorkspaceHostCanaryAssembly;
  readonly adaptedDestroyEvidence?: WorkspaceHostDestroyCanaryEvidenceContract;
}

export class WorkspaceHostCanaryRunError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Workspace-host canary cannot continue: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostCanaryRunError';
    this.problems = problems;
  }
}

export interface WorkspaceHostCanaryRunnerDependencies {
  runInitialization: typeof runWorkspaceHostInitialization;
  runLifecycle: typeof runWorkspaceHostCredentialLifecycle;
  assembleEvidence: typeof assembleWorkspaceHostCanaryEvidence;
  adaptDestroyEvidence: typeof adaptWorkspaceHostDestroyCanaryEvidence;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostCanaryRunnerDependencies = {
  runInitialization: runWorkspaceHostInitialization,
  runLifecycle: runWorkspaceHostCredentialLifecycle,
  assembleEvidence: assembleWorkspaceHostCanaryEvidence,
  adaptDestroyEvidence: adaptWorkspaceHostDestroyCanaryEvidence,
  now: () => new Date(),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameMembers(values: readonly unknown[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length &&
    new Set(values).size === values.length &&
    values.every((value) => typeof value === 'string' && expected.includes(value))
  );
}

function requireCompleteCredentialGeneration(label: string, generation: WorkspaceHostCanaryCredentialGeneration): void {
  const missing: string[] = [];
  if (!generation.credentialRefs?.cloudCredentialRef || !generation.delivery?.cloud) {
    missing.push('cloud');
  }
  if (!generation.credentialRefs?.gitCredentialRef || !generation.delivery?.git) {
    missing.push('git');
  }
  if (!generation.credentialRefs?.agentCredentialRef || !generation.delivery?.agent) {
    missing.push('agent');
  }
  if (missing.length > 0) {
    throw new WorkspaceHostCanaryRunError([
      `${label} credential generation is missing channel(s): ${missing.join(', ')}`,
    ]);
  }
}

export function workspaceHostCanaryOperationIds(runId: string): Readonly<Record<WorkspaceHostCanaryPhase, string>> {
  if (!CANARY_RUN_ID.test(runId)) {
    throw new WorkspaceHostCanaryRunError(['runId must be a stable identifier of at most 96 characters']);
  }
  return Object.fromEntries(
    WORKSPACE_HOST_CANARY_PHASES.map((phase) => [phase, `canary:${runId}:${phase}`]),
  ) as Readonly<Record<WorkspaceHostCanaryPhase, string>>;
}

function validateAgentEvidence(
  agent: (typeof WORKSPACE_HOST_CANARY_AGENTS)[number],
  value: unknown,
  problems: string[],
): WorkspaceHostAgentVerificationEvidence | undefined {
  if (!isRecord(value)) {
    problems.push(`initialization verification is missing '${agent}' agent evidence`);
    return undefined;
  }
  if (
    value.contractVersion !== WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION ||
    value.agent !== agent ||
    value.ready !== true ||
    (value.verificationKind !== 'authenticated-account' &&
      !(agent === 'omp' && value.verificationKind === 'local-inference')) ||
    typeof value.endpoint !== 'string' ||
    !Number.isSafeInteger(value.exitStatus) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    (value.subjectDisclosure !== 'redacted' && value.subjectDisclosure !== 'digest') ||
    typeof value.proofDigest !== 'string' ||
    value.proofDigest.length === 0
  ) {
    problems.push(`initialization verification has invalid '${agent}' agent evidence`);
    return undefined;
  }
  return value as unknown as WorkspaceHostAgentVerificationEvidence;
}

/** Extract only the fail-closed evidence emitted by the plan's verify-initialization step. */
export function extractWorkspaceHostCanaryInitializationObservation(result: WorkspaceHostInitializationRunResult): {
  readonly observedAt: string;
  readonly repository: { readonly visibility: 'private'; readonly cloned: true };
  readonly agents: WorkspaceHostAgentVerificationReport;
} {
  const problems: string[] = [];
  const verifySteps = result.plan.steps.filter((step) => step.kind === 'verify-initialization');
  if (verifySteps.length !== 1) {
    throw new WorkspaceHostCanaryRunError([
      `initialization plan must contain exactly one verify-initialization step (got ${verifySteps.length})`,
    ]);
  }
  const receipt = result.receipts.find((candidate) => candidate.stepId === verifySteps[0]!.id);
  if (!receipt || !isRecord(receipt.publicEvidence)) {
    throw new WorkspaceHostCanaryRunError([
      'initialization verification receipt is missing structured public evidence',
    ]);
  }

  const evidence = receipt.publicEvidence;
  if (evidence.sourceKind !== 'git') {
    problems.push('initialization verification did not observe a Git source');
  }
  if (
    !Array.isArray(evidence.requiredChannels) ||
    !sameMembers(evidence.requiredChannels, WORKSPACE_HOST_CREDENTIAL_CHANNELS)
  ) {
    problems.push('initialization verification did not cover all credential channels');
  }
  const repository = evidence.repository;
  if (!isRecord(repository) || repository.visibility !== 'private' || repository.cloned !== true) {
    problems.push('initialization verification did not prove a private repository clone');
  }
  if (evidence.agentContractVersion !== WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION) {
    problems.push('initialization verification has an incompatible agent evidence contract');
  }

  const rawAgents = isRecord(evidence.agents) ? evidence.agents : {};
  const agents: Partial<Record<(typeof WORKSPACE_HOST_CANARY_AGENTS)[number], WorkspaceHostAgentVerificationEvidence>> =
    {};
  for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
    const validated = validateAgentEvidence(agent, rawAgents[agent], problems);
    if (validated) agents[agent] = validated;
  }
  if (!Number.isFinite(Date.parse(receipt.observedAt))) {
    problems.push('initialization verification receipt has an invalid observedAt');
  }
  if (problems.length > 0) throw new WorkspaceHostCanaryRunError(problems);

  return {
    observedAt: receipt.observedAt,
    repository: { visibility: 'private', cloned: true },
    agents: {
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      observedAt: receipt.observedAt,
      allReady: true,
      agents: agents as WorkspaceHostAgentVerificationReport['agents'],
    },
  };
}

function preflight(
  input: WorkspaceHostCanaryRunInput,
  operationIds: Readonly<Record<WorkspaceHostCanaryPhase, string>>,
): {
  backupManifest: WorkspaceHostBackupCredentialManifest;
  restoreRebindRequest: WorkspaceHostBackupRestoreCredentialRebindRequest;
} {
  if (!Number.isFinite(Date.parse(input.requestedAt))) {
    throw new WorkspaceHostCanaryRunError(['requestedAt must be an ISO timestamp']);
  }
  if (input.source.kind !== 'git' || input.source.visibility !== 'private') {
    throw new WorkspaceHostCanaryRunError(['the production canary requires a private Git source']);
  }
  requireCompleteCredentialGeneration('initial', input.credentials.initial);
  requireCompleteCredentialGeneration('rotated', input.credentials.rotated);
  requireCompleteCredentialGeneration('restored', input.credentials.restored);

  // Reuse the exact driver validators before any remote side effect. The runners rebuild these
  // plans when they execute; this early pass prevents a bad late-phase request from stranding a
  // partially completed canary.
  planWorkspaceHostInitialization({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: operationIds.initialize,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    source: input.source,
    credentialRefs: input.credentials.initial.credentialRefs,
    credentialDelivery: input.credentials.initial.delivery,
  });
  planWorkspaceHostCredentialLifecycle({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: operationIds.rotate,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    action: 'rotate',
    currentCredentialRefs: input.credentials.initial.credentialRefs,
    currentDelivery: input.credentials.initial.delivery,
    nextCredentialRefs: input.credentials.rotated.credentialRefs,
    nextDelivery: input.credentials.rotated.delivery,
  });
  planWorkspaceHostCredentialLifecycle({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: operationIds.revoke,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    action: 'revoke',
    currentCredentialRefs: input.credentials.rotated.credentialRefs,
    currentDelivery: input.credentials.rotated.delivery,
    channels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
  });
  planWorkspaceHostCredentialLifecycle({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: operationIds.reconnect,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    action: 'reconnect',
    currentCredentialRefs: input.credentials.rotated.credentialRefs,
    currentDelivery: input.credentials.rotated.delivery,
  });

  const backupManifest = buildWorkspaceHostBackupCredentialManifest(
    input.workspaceId,
    input.requestedAt,
    input.credentials.rotated.credentialRefs,
    input.credentials.rotated.delivery,
  );
  const restoreRebindRequest = buildWorkspaceHostBackupRestoreCredentialRebindRequest(
    backupManifest,
    input.credentials.restored.credentialRefs,
    input.credentials.restored.delivery,
    input.requestedAt,
  );
  planWorkspaceHostCredentialLifecycle({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: operationIds['restore-rebind'],
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    ...restoreRebindRequest,
  });
  return { backupManifest, restoreRebindRequest };
}

export async function runWorkspaceHostCanary(
  input: WorkspaceHostCanaryRunInput,
  overrides: Partial<WorkspaceHostCanaryRunnerDependencies> = {},
): Promise<WorkspaceHostCanaryRunResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const operationIds = workspaceHostCanaryOperationIds(input.runId);
  const { backupManifest, restoreRebindRequest } = preflight(input, operationIds);
  const common = {
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    operations: input.operations,
    requestedAt: input.requestedAt,
    deliveryCapabilities: input.deliveryCapabilities,
    ...(input.leaseOwner ? { leaseOwner: input.leaseOwner } : {}),
    ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
    now: dependencies.now,
  };

  const initialization = await dependencies.runInitialization({
    ...common,
    operationId: operationIds.initialize,
    source: input.source,
    credentialRefs: input.credentials.initial.credentialRefs,
    credentialDelivery: input.credentials.initial.delivery,
    credentialMaterialSource: input.credentialMaterialSource,
    // The initialization runner invokes this only after the exact stored agent generation passed
    // admission and before it creates the operation row. A revoked generation therefore remains a
    // canary preflight rejection rather than masquerading as a durable remote-phase failure.
    onPlanned: () => input.onPhaseStart?.('initialize', operationIds.initialize),
  } satisfies WorkspaceHostInitializationRunInput);
  const initializationObservation = extractWorkspaceHostCanaryInitializationObservation(initialization);

  const lifecycleOperations = {
    execute: (step: Parameters<WorkspaceHostCredentialLifecycleRunInput['operations']['execute']>[0]) =>
      input.operations.execute(step as unknown as WorkspaceHostInitializationStep),
  };
  const runLifecycle = async (
    phase: Exclude<WorkspaceHostCanaryPhase, 'initialize'>,
    action: WorkspaceHostCredentialLifecycleRunAction,
  ): Promise<WorkspaceHostCanaryLifecyclePhaseResult> => {
    input.onPhaseStart?.(phase, operationIds[phase]);
    return {
      phase,
      result: await dependencies.runLifecycle({
        ...action,
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        operationId: operationIds[phase],
        requestedAt: input.requestedAt,
        deliveryCapabilities: input.deliveryCapabilities,
        operations: lifecycleOperations,
        ...(input.leaseOwner ? { leaseOwner: `${input.leaseOwner}:${phase}` } : {}),
        ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
        now: dependencies.now,
      }),
    };
  };

  const rotate = await runLifecycle('rotate', {
    action: 'rotate',
    currentCredentialRefs: input.credentials.initial.credentialRefs,
    currentDelivery: input.credentials.initial.delivery,
    nextCredentialRefs: input.credentials.rotated.credentialRefs,
    nextDelivery: input.credentials.rotated.delivery,
  });
  const revoke = await runLifecycle('revoke', {
    action: 'revoke',
    currentCredentialRefs: input.credentials.rotated.credentialRefs,
    currentDelivery: input.credentials.rotated.delivery,
    channels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
  });
  const reconnect = await runLifecycle('reconnect', {
    action: 'reconnect',
    currentCredentialRefs: input.credentials.rotated.credentialRefs,
    currentDelivery: input.credentials.rotated.delivery,
  });
  const restoreRebind = await runLifecycle('restore-rebind', {
    ...restoreRebindRequest,
  });
  const lifecycle = [rotate, revoke, reconnect, restoreRebind] as const;
  const lifecycleRuns: readonly WorkspaceHostCanaryLifecycleRun[] = lifecycle.map(({ result }) => ({
    plan: result.plan,
    receipts: result.receipts,
  }));

  const observedAt = dependencies.now().toISOString();
  const assembly = dependencies.assembleEvidence({
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    observedAt,
    repository: initializationObservation.repository,
    agents: initializationObservation.agents,
    lifecycleRuns,
    backupRestore: {
      authorizationMaterialExcluded: backupManifest.authorizationMaterial === 'excluded',
      credentialReferencesExcluded: backupManifest.credentialReferences === 'excluded',
      reboundChannels: restoreRebind.result.plan.steps
        .filter((step) => step.kind === 'verify-bound')
        .map((step) => step.channel),
    },
  });
  if (!assembly.validation.ok) {
    throw new WorkspaceHostCanaryRunError([
      ...assembly.validation.errors.map((error) => `assembled evidence: ${error}`),
    ]);
  }

  const adaptedDestroyEvidence = input.destroyFinalization
    ? dependencies.adaptDestroyEvidence({
        expected: {
          runId: input.runId,
          workspaceId: input.workspaceId,
          hostId: input.hostId,
          operationId: input.destroyFinalization.operationId,
        },
        initialization: assembly.evidence,
        credentialTeardown: input.destroyFinalization.credentialTeardown,
        teardown: input.destroyFinalization.teardown,
        destroyEvidence: input.destroyFinalization.destroyEvidence,
      })
    : undefined;

  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt: input.requestedAt,
    operationIds,
    initialization,
    lifecycle,
    backupManifest,
    restoreRebindRequest,
    assembly,
    ...(adaptedDestroyEvidence ? { adaptedDestroyEvidence } : {}),
  };
}
