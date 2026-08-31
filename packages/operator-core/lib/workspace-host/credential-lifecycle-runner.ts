/**
 * Durable production assembly for workspace-host credential lifecycle operations (D-114).
 *
 * The deployment driver remains the single planner/executor. This module only joins it to the
 * existing initialization replay store, host transport, and observability ledger. Lifecycle
 * steps deliberately reuse the initialization replay table: both families share the same
 * idempotency-key/fingerprint contract and run against the same already-provisioned host.
 */
import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WorkspaceHostCredentialResolver,
  assertNoResolvedAuthorizationMaterial,
  assertWorkspaceHostSecretIsolation,
  describeWorkspaceHostCredentialBinding,
  encodeWorkspaceHostCredentialLifecycleStep,
  executeWorkspaceHostCredentialLifecycle,
  planWorkspaceHostCredentialLifecycle,
  workspaceHostCredentialReferenceDigest,
  workspaceHostInitializationStepFingerprint,
} from '@papercusp/deployment-driver';
import type {
  WorkspaceHostCredentialEvidence,
  WorkspaceHostCredentialLifecyclePlan,
  WorkspaceHostCredentialLifecycleReceipt,
  WorkspaceHostCredentialLifecycleRequest,
  WorkspaceHostCredentialLifecycleStep,
  WorkspaceHostDeliveryCapabilities,
  WorkspaceHostInitializationHostOperationResult,
  WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import { createWorkspaceHostInitializationReplayStore } from './initialization-replay-store';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  updateWorkspaceHostOperation,
} from './observability-store';

type ControllerOwnedRequestField =
  | 'contractVersion'
  | 'operationId'
  | 'workspaceId'
  | 'hostId'
  | 'requestedAt';
type CredentialLifecycleActionInput<T> = T extends unknown
  ? Omit<T, ControllerOwnedRequestField>
  : never;

export type WorkspaceHostCredentialLifecycleRunAction =
  CredentialLifecycleActionInput<WorkspaceHostCredentialLifecycleRequest>;

export interface WorkspaceHostCredentialLifecycleHostOperations {
  execute(
    step: WorkspaceHostCredentialLifecycleStep,
  ): Promise<WorkspaceHostInitializationHostOperationResult>;
}

interface WorkspaceHostCredentialLifecycleRunBase {
  workspaceId: string;
  hostId: string;
  operationId?: string;
  requestedAt?: string;
  operations: WorkspaceHostCredentialLifecycleHostOperations;
  /**
   * The executing provider's declared transport features — pass the provider's real profile
   * (`profile.transportProfile.features`). A provider declaring `fileTransfer: false` cannot
   * carry the git/agent channels and is refused at plan time.
   */
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  leaseOwner?: string;
  leaseTtlMs?: number;
  onPlanned?: (plan: WorkspaceHostCredentialLifecyclePlan) => void;
  now?: () => Date;
}

export type WorkspaceHostCredentialLifecycleRunInput =
  WorkspaceHostCredentialLifecycleRunBase & WorkspaceHostCredentialLifecycleRunAction;

export interface WorkspaceHostCredentialLifecycleRunResult {
  operationId: string;
  plan: WorkspaceHostCredentialLifecyclePlan;
  receipts: readonly WorkspaceHostCredentialLifecycleReceipt[];
}

function buildRequest(
  input: WorkspaceHostCredentialLifecycleRunInput,
  operationId: string,
  requestedAt: string,
): WorkspaceHostCredentialLifecycleRequest {
  const base = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    deliveryCapabilities: input.deliveryCapabilities,
    operationId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt,
  } as const;
  switch (input.action) {
    case 'rotate':
      return {
        ...base,
        action: input.action,
        currentCredentialRefs: input.currentCredentialRefs,
        currentDelivery: input.currentDelivery,
        nextCredentialRefs: input.nextCredentialRefs,
        nextDelivery: input.nextDelivery,
      };
    case 'revoke':
      return {
        ...base,
        action: input.action,
        currentCredentialRefs: input.currentCredentialRefs,
        currentDelivery: input.currentDelivery,
        channels: input.channels,
      };
    case 'reconnect':
      return {
        ...base,
        action: input.action,
        currentCredentialRefs: input.currentCredentialRefs,
        currentDelivery: input.currentDelivery,
      };
    case 'restore-rebind':
      return {
        ...base,
        action: input.action,
        backup: input.backup,
        nextCredentialRefs: input.nextCredentialRefs,
        nextDelivery: input.nextDelivery,
      };
  }
}

function requireEvidenceRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Reconstruct the typed receipt from the redacted wire evidence plus the validated plan step. */
function credentialEvidence(
  step: WorkspaceHostCredentialLifecycleStep,
  requestedAt: string,
  publicEvidence: unknown,
): WorkspaceHostCredentialEvidence {
  const evidence = requireEvidenceRecord(publicEvidence, `lifecycle receipt '${step.id}' evidence`);
  assertWorkspaceHostSecretIsolation(evidence, `workspaceHost.credentialLifecycle.receipt.${step.id}`);
  assertNoResolvedAuthorizationMaterial(evidence, `workspaceHost.credentialLifecycle.receipt.${step.id}`);

  const binding = describeWorkspaceHostCredentialBinding({
    channel: step.channel,
    credentialRef: step.credentialRef,
    delivery: step.delivery,
    requestedAt,
  });
  const expected = {
    channel: step.channel,
    family: binding.family,
    operation: step.kind,
    deliveryKind: binding.deliveryKind,
    generation: binding.generation,
    audience: binding.audience,
    referenceDigest: workspaceHostCredentialReferenceDigest(step.credentialRef.ref),
  } as const;
  for (const [field, value] of Object.entries(expected)) {
    if (evidence[field] !== value) {
      throw new Error(`Lifecycle receipt '${step.id}' returned mismatched ${field}`);
    }
  }
  const detail = requireEvidenceRecord(evidence.detail, `lifecycle receipt '${step.id}' detail`);
  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    channel: step.channel,
    family: binding.family,
    operation: step.kind,
    deliveryKind: binding.deliveryKind,
    generation: binding.generation,
    audience: binding.audience,
    revocationRef: step.delivery.revocationRef,
    referenceDigest: expected.referenceDigest,
    detail,
  };
}

/**
 * Run one lifecycle request durably. Reusing operationId resumes completed remote side effects.
 */
export async function runWorkspaceHostCredentialLifecycle(
  input: WorkspaceHostCredentialLifecycleRunInput,
): Promise<WorkspaceHostCredentialLifecycleRunResult> {
  const operationId = input.operationId ?? randomUUID();
  const requestedAt = input.requestedAt ?? (input.now ?? (() => new Date()))().toISOString();
  const plan = planWorkspaceHostCredentialLifecycle(buildRequest(input, operationId, requestedAt));
  const totalSteps = plan.steps.length;
  input.onPlanned?.(plan);

  // The existing DB action vocabulary names the host-side controller family "initialize".
  // Lifecycle specificity remains lossless in the persisted plan, phase, and message.
  await beginWorkspaceHostOperation({
    workspaceId: input.workspaceId,
    operationId,
    hostId: input.hostId,
    action: 'initialize',
    status: 'running',
    percent: 0,
    message: `Running workspace host credential lifecycle '${plan.action}' (${totalSteps} steps)`,
    request: plan,
  });

  const replayStore = createWorkspaceHostInitializationReplayStore({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    leaseOwner: input.leaseOwner ?? `workspace-host-credential-lifecycle:${operationId}`,
    ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  let completedSteps = 0;

  class RemoteCredentialResolver extends WorkspaceHostCredentialResolver {
    constructor() {
      super([]);
    }

    override async executeLifecycleStep(
      step: WorkspaceHostCredentialLifecycleStep,
      acceptedAt: string,
    ): Promise<WorkspaceHostCredentialEvidence> {
      const wireStep = encodeWorkspaceHostCredentialLifecycleStep(step);
      const receipt = await replayStore.runOnce(
        {
          idempotencyKey: step.idempotencyKey,
          stepFingerprint: workspaceHostInitializationStepFingerprint(
            wireStep as unknown as WorkspaceHostInitializationStep,
          ),
        },
        async () => {
          const result = await input.operations.execute(step);
          if (!Number.isFinite(Date.parse(result.observedAt))) {
            throw new Error(`Lifecycle receipt '${step.id}' returned an invalid observedAt`);
          }
          const evidence = credentialEvidence(step, acceptedAt, result.publicEvidence);
          return {
            stepId: step.id,
            status: 'succeeded' as const,
            observedAt: result.observedAt,
            publicEvidence: {
              channel: evidence.channel,
              family: evidence.family,
              operation: evidence.operation,
              deliveryKind: evidence.deliveryKind,
              generation: evidence.generation,
              audience: evidence.audience,
              referenceDigest: evidence.referenceDigest,
              detail: evidence.detail,
            },
          };
        },
      );
      if (receipt.stepId !== step.id || receipt.status !== 'succeeded') {
        throw new Error(`Lifecycle replay for '${step.id}' returned an invalid receipt`);
      }
      const evidence = credentialEvidence(step, acceptedAt, receipt.publicEvidence);
      completedSteps += 1;

      await appendWorkspaceHostEvent({
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        operationId,
        occurredAt: receipt.observedAt,
        phase: `credential-lifecycle:${plan.action}:${step.kind}`,
        status: 'running',
        level: 'info',
        source: 'controller',
        message: `Credential lifecycle step '${step.id}' (${step.kind}) succeeded`,
        details: {
          stepId: step.id,
          kind: step.kind,
          channel: step.channel,
          generation: evidence.generation,
          referenceDigest: evidence.referenceDigest,
        },
      });
      await updateWorkspaceHostOperation({
        workspaceId: input.workspaceId,
        operationId,
        status: 'running',
        percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
        message: `Completed ${completedSteps}/${totalSteps}: ${step.kind}`,
      });
      return evidence;
    }
  }

  try {
    const receipts = await executeWorkspaceHostCredentialLifecycle(
      plan,
      new RemoteCredentialResolver(),
    );
    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'succeeded',
      percent: 100,
      message: `Workspace host credential lifecycle '${plan.action}' completed (${receipts.length} steps)`,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: `credential-lifecycle:${plan.action}:complete`,
      status: 'succeeded',
      level: 'info',
      source: 'controller',
      message: `Workspace host credential lifecycle '${plan.action}' completed (${receipts.length} steps)`,
      details: { action: plan.action, stepIds: plan.steps.map((step) => step.id) },
    });
    return { operationId, plan, receipts };
  } catch (error) {
    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'failed',
      percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
      message: `Workspace host credential lifecycle '${plan.action}' failed after ${completedSteps}/${totalSteps} steps`,
      error,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: `credential-lifecycle:${plan.action}:failed`,
      status: 'failed',
      level: 'error',
      source: 'controller',
      message: `Workspace host credential lifecycle '${plan.action}' failed after ${completedSteps}/${totalSteps} steps`,
      details: { action: plan.action, completedSteps, totalSteps },
    });
    throw error;
  }
}
