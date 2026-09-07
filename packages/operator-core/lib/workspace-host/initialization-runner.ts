/**
 * Production assembly for workspace-host initialization (P-046 / WI-40474).
 *
 * Every piece of this flow already existed and was independently tested; nothing assembled
 * them, which is why `planWorkspaceHostInitialization` / `executeWorkspaceHostInitialization`
 * had zero production callers. This module is that assembly and deliberately contains no new
 * initialization logic of its own:
 *
 *   beginWorkspaceHostOperation(action:'initialize')   <- observability-store (migration 887/955)
 *     -> planWorkspaceHostInitialization(request)      <- contract library (validates + plans)
 *       -> ReplaySafeWorkspaceHostInitializationExecutor
 *            { operations: <host adapter, e.g. GcpIap...>, replayStore: <durable, migration 955> }
 *         -> executeWorkspaceHostInitialization(plan, executor)
 *           -> appendWorkspaceHostEvent / updateWorkspaceHostOperation per step
 *
 * Two ordering decisions here are load-bearing:
 *
 * 1. PLAN BEFORE RECORDING. `planWorkspaceHostInitialization` is what validates the request
 *    (contract version, ids, timestamps, credential-set coherence) and asserts secret
 *    isolation. Planning first means a malformed or secret-bearing request throws without
 *    leaving an orphaned `queued` operation row behind for an operation that never began.
 *
 * 2. PERSIST THE PLAN, NOT THE REQUEST. The request carries `credentialRefs` and
 *    `credentialDelivery`; only the PLAN is passed through
 *    `assertWorkspaceHostSecretIsolation` (by `executeWorkspaceHostInitialization`). So the
 *    plan is the artifact the library itself guarantees is free of secret material, and it is
 *    therefore the one safe to write to an operation row that is exported by the audit route.
 */
import { randomUUID } from 'node:crypto';
import {
  ReplaySafeWorkspaceHostInitializationExecutor,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  assertWorkspaceHostSecretIsolation,
  executeWorkspaceHostInitialization,
  planWorkspaceHostInitialization,
} from '@papercusp/deployment-driver';
import type {
  WorkspaceHostCredentialDeliverySet,
  WorkspaceHostCredentialRefs,
  WorkspaceHostDeliveryCapabilities,
  WorkspaceHostInitializationExecutor,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationPlan,
  WorkspaceHostInitializationRequest,
  WorkspaceHostInitializationSource,
  WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
import {
  assertWorkspaceHostAgentCredentialAdmissionEvidence,
  verifyWorkspaceHostAgentCredentialAdmission,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
  type WorkspaceHostAgentCredentialAdmissionInput,
} from './agent-credential-admission';
import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';
import { createWorkspaceHostInitializationReplayStore } from './initialization-replay-store';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  updateWorkspaceHostOperation,
} from './observability-store';

export interface WorkspaceHostInitializationRunInput {
  workspaceId: string;
  /** An ALREADY-PROVISIONED host. Initialization is a lifecycle action on it, not a provision. */
  hostId: string;
  /** Supply to resume/retry an interrupted run: the replay store keys off the operation id. */
  operationId?: string;
  requestedAt?: string;
  source: WorkspaceHostInitializationSource;
  credentialRefs: WorkspaceHostCredentialRefs;
  credentialDelivery: WorkspaceHostCredentialDeliverySet;
  /** Exact controller-side source shared with the host delivery adapter. */
  credentialMaterialSource: WorkspaceHostCredentialMaterialSource;
  /**
   * Additional exact-generation receipts already produced by a compound admission such as the
   * canary's rotated/restored generations. They are persisted beside this run's own receipt.
   */
  additionalCredentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
  /**
   * The executing provider's declared transport features — pass the provider's real profile
   * (`profile.transportProfile.features`) rather than a transcribed boolean. A provider declaring
   * `fileTransfer: false` is refused here, at plan time, instead of failing on a running host.
   */
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  /** Persistable labels only; secret-isolation asserted by the planner. */
  publicMetadata?: Readonly<Record<string, unknown>>;
  /** The concrete capability-declaring host adapter (e.g. GcpIapWorkspaceHostInitializationOperations). */
  operations: WorkspaceHostInitializationHostOperations;
  /** Stable controller identity for lease re-entrancy; defaults to this operation. */
  leaseOwner?: string;
  leaseTtlMs?: number;
  /**
   * Called once the request has been VALIDATED and its exact agent generation has passed
   * authentication admission, still before any operation row exists.
   *
   * This exposes the one boundary a caller cannot otherwise observe: a throw from this function
   * either means the request was rejected by the contract, or means execution against a real host
   * failed — and those deserve opposite answers at an API edge (the first is the caller's fault
   * and retrying it unchanged is pointless; the second is not). Without this seam a surface has to
   * guess from the error's shape, which is exactly the kind of inference that silently rots.
   */
  onPlanned?: (plan: WorkspaceHostInitializationPlan) => void;
  /** Test seam. */
  now?: () => Date;
}

export interface WorkspaceHostInitializationRunResult {
  operationId: string;
  plan: WorkspaceHostInitializationPlan;
  receipts: readonly WorkspaceHostInitializationStepReceipt[];
  credentialAdmission?: WorkspaceHostAgentCredentialAdmissionEvidence;
  credentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
}

export interface WorkspaceHostInitializationRunnerDependencies {
  verifyAgentCredentialAdmission: (
    input: WorkspaceHostAgentCredentialAdmissionInput,
  ) => Promise<WorkspaceHostAgentCredentialAdmissionEvidence>;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostInitializationRunnerDependencies = {
  verifyAgentCredentialAdmission: verifyWorkspaceHostAgentCredentialAdmission,
};

/**
 * Run a workspace-host initialization end to end, durably and resumably.
 *
 * Re-invoking with the same `operationId` replays: steps already recorded as complete return
 * their prior receipt without re-executing against the host, so an interrupted controller
 * resumes rather than repeating side effects.
 */
export async function runWorkspaceHostInitialization(
  input: WorkspaceHostInitializationRunInput,
  overrides: Partial<WorkspaceHostInitializationRunnerDependencies> = {},
): Promise<WorkspaceHostInitializationRunResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const operationId = input.operationId ?? randomUUID();
  const requestedAt = input.requestedAt ?? new Date().toISOString();

  const request: WorkspaceHostInitializationRequest = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt,
    source: input.source,
    credentialRefs: input.credentialRefs,
    credentialDelivery: input.credentialDelivery,
    deliveryCapabilities: input.deliveryCapabilities,
    ...(input.publicMetadata ? { publicMetadata: input.publicMetadata } : {}),
  };

  // (1) Validate by planning, before any row exists. See module header.
  const plan = planWorkspaceHostInitialization(request);
  const totalSteps = plan.steps.length;
  const agentCredentialRef = input.credentialRefs.agentCredentialRef;
  const agentDelivery = input.credentialDelivery.agent;
  const credentialAdmission =
    agentCredentialRef && agentDelivery
      ? await dependencies.verifyAgentCredentialAdmission({
          credentialRef: agentCredentialRef,
          delivery: agentDelivery,
          materialSource: input.credentialMaterialSource,
        })
      : undefined;
  const credentialAdmissions = [
    ...(input.additionalCredentialAdmissions ?? []),
    ...(credentialAdmission ? [credentialAdmission] : []),
  ];
  const admissionBindings = new Set<string>();
  for (const evidence of credentialAdmissions) {
    assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence);
    const key = [
      evidence.binding.family,
      evidence.binding.generation,
      evidence.binding.referenceDigest,
    ].join(':');
    if (admissionBindings.has(key)) {
      throw new Error('workspace-host initialization received duplicate credential admission evidence');
    }
    admissionBindings.add(key);
  }
  input.onPlanned?.(plan);

  // (2) Persist the secret-isolated plan plus the CLOSED admission receipt. The receipt contains
  // only a public reference digest, generation and probe reason codes — never material bytes or a
  // digest of them. Keeping it on the operation request binds the successful probe to the exact
  // request an audit later reads, instead of leaving it as an ephemeral controller assertion.
  const persistedRequest =
    credentialAdmissions.length > 0 ? { ...plan, credentialAdmissions } : plan;
  assertWorkspaceHostSecretIsolation(persistedRequest, 'workspaceHost.initialization.admittedPlan');
  await beginWorkspaceHostOperation({
    workspaceId: input.workspaceId,
    operationId,
    hostId: input.hostId,
    action: 'initialize',
    status: 'running',
    percent: 0,
    message: `Initializing workspace host (${totalSteps} steps)`,
    request: persistedRequest,
  });

  let completedSteps = 0;

  try {
    // Everything after beginWorkspaceHostOperation is inside the same failure boundary. Adapter
    // capability validation and replay-store setup can fail synchronously; if either does, the
    // operation row must become a durable failed operation rather than an apparently live 0%
    // orphan with no step/event evidence.
    const replayStore = createWorkspaceHostInitializationReplayStore({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      leaseOwner: input.leaseOwner ?? `workspace-host-initialization:${operationId}`,
      ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
      ...(input.now ? { now: input.now } : {}),
    });

    const replaySafe = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: input.operations,
      replayStore,
    });

    /**
     * Progress reporting wraps the replay-safe executor rather than being folded into it: the
     * replay store must own execution-exactly-once, and timeline writes must NOT participate in
     * that ownership. A failure to append an event after a step has already succeeded therefore
     * cannot cause the step to re-run against the host — the receipt is already durable, so a
     * retry replays it.
     */
    const reportingExecutor: WorkspaceHostInitializationExecutor = {
      async execute(step) {
        const receipt = await replaySafe.execute(step);
        completedSteps += 1;

        await appendWorkspaceHostEvent({
          workspaceId: input.workspaceId,
          hostId: input.hostId,
          operationId,
          occurredAt: receipt.observedAt,
          phase: `initialize:${step.kind}`,
          status: 'running',
          level: 'info',
          source: 'controller',
          message: `Initialization step '${step.id}' (${step.kind}) succeeded`,
          details: {
            stepId: step.id,
            kind: step.kind,
            ...(receipt.publicEvidence ? { publicEvidence: receipt.publicEvidence } : {}),
          },
        });

        await updateWorkspaceHostOperation({
          workspaceId: input.workspaceId,
          operationId,
          status: 'running',
          // Capped below 100 so terminal completion is the only writer of 100.
          percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
          message: `Completed ${completedSteps}/${totalSteps}: ${step.kind}`,
        });

        return receipt;
      },
    };

    const receipts = await executeWorkspaceHostInitialization(plan, reportingExecutor);

    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'succeeded',
      percent: 100,
      message: `Workspace host initialization completed (${receipts.length} steps)`,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: 'initialize:complete',
      status: 'succeeded',
      level: 'info',
      source: 'controller',
      message: `Workspace host initialization completed (${receipts.length} steps)`,
      details: { stepIds: plan.steps.map((step) => step.id) },
    });

    return {
      operationId,
      plan,
      receipts,
      ...(credentialAdmission ? { credentialAdmission } : {}),
      ...(credentialAdmissions.length > 0 ? { credentialAdmissions } : {}),
    };
  } catch (error) {
    // The thrown message may quote host output, so it is passed ONLY through `error`, which the
    // observability store redacts — never interpolated into the human-facing message field.
    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'failed',
      percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
      message: `Workspace host initialization failed after ${completedSteps}/${totalSteps} steps`,
      error,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: 'initialize:failed',
      status: 'failed',
      level: 'error',
      source: 'controller',
      message: `Workspace host initialization failed after ${completedSteps}/${totalSteps} steps`,
      details: { completedSteps, totalSteps },
    });
    throw error;
  }
}
