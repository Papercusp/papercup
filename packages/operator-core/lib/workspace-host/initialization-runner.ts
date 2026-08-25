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
  executeWorkspaceHostInitialization,
  planWorkspaceHostInitialization,
} from '@papercusp/deployment-driver';
import type {
  WorkspaceHostCredentialDeliverySet,
  WorkspaceHostCredentialRefs,
  WorkspaceHostInitializationExecutor,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationPlan,
  WorkspaceHostInitializationRequest,
  WorkspaceHostInitializationSource,
  WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
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
  /** Persistable labels only; secret-isolation asserted by the planner. */
  publicMetadata?: Readonly<Record<string, unknown>>;
  /** The concrete capability-declaring host adapter (e.g. GcpIapWorkspaceHostInitializationOperations). */
  operations: WorkspaceHostInitializationHostOperations;
  /** Stable controller identity for lease re-entrancy; defaults to this operation. */
  leaseOwner?: string;
  leaseTtlMs?: number;
  /** Test seam. */
  now?: () => Date;
}

export interface WorkspaceHostInitializationRunResult {
  operationId: string;
  plan: WorkspaceHostInitializationPlan;
  receipts: readonly WorkspaceHostInitializationStepReceipt[];
}

/**
 * Run a workspace-host initialization end to end, durably and resumably.
 *
 * Re-invoking with the same `operationId` replays: steps already recorded as complete return
 * their prior receipt without re-executing against the host, so an interrupted controller
 * resumes rather than repeating side effects.
 */
export async function runWorkspaceHostInitialization(
  input: WorkspaceHostInitializationRunInput,
): Promise<WorkspaceHostInitializationRunResult> {
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
    ...(input.publicMetadata ? { publicMetadata: input.publicMetadata } : {}),
  };

  // (1) Validate by planning, before any row exists. See module header.
  const plan = planWorkspaceHostInitialization(request);
  const totalSteps = plan.steps.length;

  // (2) Only the plan is persisted — it is the secret-isolated artifact. See module header.
  await beginWorkspaceHostOperation({
    workspaceId: input.workspaceId,
    operationId,
    hostId: input.hostId,
    action: 'initialize',
    status: 'running',
    percent: 0,
    message: `Initializing workspace host (${totalSteps} steps)`,
    request: plan,
  });

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

  let completedSteps = 0;

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

  try {
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

    return { operationId, plan, receipts };
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
