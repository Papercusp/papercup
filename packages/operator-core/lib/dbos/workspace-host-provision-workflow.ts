/**
 * Host-scoped DBOS admission for workspace-host provisioning (D-100).
 *
 * The runner is operation-replay-safe; this workflow adds the missing cross-operation mutex. A
 * stable workflow id resumes one operation, while the host-scoped deduplication id prevents two
 * different operation ids from mutating the same resource graph concurrently.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  resolveWorkspaceHostProvider,
  workspaceHostWorkflowKeys,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostInitializationRequest,
} from '@papercusp/deployment-driver';
import { executeAdmittedWorkspaceHostInitialization, executeAdmittedWorkspaceHostDesktopPack, type WorkspaceHostDesktopPackRequest } from '../workspace-host/initialization-admission';
import {
  runWorkspaceHostDestroy,
  runWorkspaceHostProvisioning,
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  WorkspaceHostProvisioningTransientError,
  type WorkspaceHostDestroyCanaryEvidence,
  type WorkspaceHostDestroyResult,
  type WorkspaceHostProvisioningResult,
} from '../workspace-host/provisioning-runner';
import {
  runWorkspaceHostLifecycle,
  type RunWorkspaceHostLifecycleInput,
} from '../workspace-host/lifecycle-runner';
import { recordWorkspaceHostOperationTerminalFailure } from '../workspace-host/observability-store';
import {
  WORKSPACE_HOST_ADMISSION_WINDOW_MS,
  type WorkspaceHostOperationAcceptance,
} from '../workspace-host/admission-window';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

const QUEUE_DEDUP_DUPLICATED_CODE = 28;
const MAX_WORKFLOW_TURNS = 1_800;
const DEFAULT_RETRY_AFTER_MS = 2_000;

export interface StartWorkspaceHostProvisioningInput {
  workspaceId: string;
  connectionId: string;
  name: string;
  desired: WorkspaceHostDesiredSpec;
  connection: WorkspaceHostProviderConnection;
  operationId?: string;
  actorId?: string;
}

export interface StartWorkspaceHostDestroyInput {
  workspaceId: string;
  hostId: string;
  connectionId: string;
  connection: WorkspaceHostProviderConnection;
  disposition: 'snapshot' | 'backup' | 'discard';
  confirmation: {
    expectedHostId: string;
    confirmedBy: string;
    confirmedAt: string;
  };
  /** Present only for the canary wrapper; ordinary customer teardown does not manufacture it. */
  canary?: WorkspaceHostDestroyCanaryEvidence;
  operationId?: string;
  actorId?: string;
}

export type StartWorkspaceHostLifecycleInput = Omit<
  RunWorkspaceHostLifecycleInput,
  'provider' | 'store' | 'signal'
>;

type WorkspaceHostProvisioningWorkflowInput = StartWorkspaceHostProvisioningInput & {
  action: 'provision';
  operationId: string;
};

type WorkspaceHostDestroyWorkflowInput = StartWorkspaceHostDestroyInput & {
  action: 'destroy';
  operationId: string;
};

type WorkspaceHostLifecycleWorkflowInput = StartWorkspaceHostLifecycleInput & {
  operationId: string;
};

type WorkspaceHostWorkflowInput =
  | WorkspaceHostProvisioningWorkflowInput
  | WorkspaceHostDestroyWorkflowInput
  | WorkspaceHostLifecycleWorkflowInput
  | (WorkspaceHostInitializationRequest & { action: 'initialize' })
  | WorkspaceHostDesktopPackRequest;

type WorkspaceHostWorkflowResult = WorkspaceHostProvisioningResult | {
  status: 'succeeded'; operationId: string; hostId: string;
};

export type WorkspaceHostProvisioningExecutor = (
  input: WorkspaceHostWorkflowInput,
) => Promise<WorkspaceHostWorkflowResult>;

interface WorkflowHooks {
  executor?: WorkspaceHostProvisioningExecutor;
}

function hooks(): WorkflowHooks {
  const root = globalThis as typeof globalThis & {
    __papercuspWorkspaceHostProvisioningHooks__?: WorkflowHooks;
  };
  return (root.__papercuspWorkspaceHostProvisioningHooks__ ??= {});
}

export function setWorkspaceHostProvisioningExecutor(executor: WorkspaceHostProvisioningExecutor | null): void {
  if (executor) hooks().executor = executor;
  else delete hooks().executor;
}

/**
 * WI-10001739 link 1: a control-plane fence error must not spend the PROVIDER-NETWORK retry budget.
 *
 * `DBOS.runStep` below has a single `maxAttempts: 3`. A WorkspaceHostControllerFenceError is not a
 * provider failure at all, but it was being retried out of that same budget — measured 2026-09-17,
 * a destroy spent attempts 1 and 2 on fence errors and had exactly one left when it finally reached
 * the provider and hit a genuinely transient network error.
 *
 * Absorbing the fence here, INSIDE one step, is what makes the budgets separate: DBOS sees a single
 * step invocation, so this is replay-safe (no cross-step mutable counter to diverge on replay), and
 * the step's 3 attempts stay reserved for provider errors.
 *
 * A GENUINE supersede is unaffected: a newer operation holds the host permanently, so every attempt
 * here fails and the error is rethrown — bounded, never a spin. The window is sized off a single
 * observation (that fence cleared on its own within ~16s), which is why it is deliberately generous:
 * over-waiting on a transient race costs seconds, under-waiting costs the whole operation.
 */
const FENCE_RETRY_ATTEMPTS = 5;
const FENCE_RETRY_BASE_MS = 2_000;

async function executeToleratingControllerFence(
  input: WorkspaceHostWorkflowInput,
): Promise<WorkspaceHostWorkflowResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execute(input);
    } catch (error) {
      // Matched by NAME, not instanceof, deliberately: this codebase already carries a rehydration
      // path for typed errors "after DBOS serialization erases their prototypes", so an instanceof
      // check here would silently stop matching the moment the error crosses that boundary.
      const isFence =
        error instanceof Error && error.name === 'WorkspaceHostControllerFenceError';
      if (!isFence || attempt >= FENCE_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, FENCE_RETRY_BASE_MS * attempt));
    }
  }
}

async function execute(input: WorkspaceHostWorkflowInput): Promise<WorkspaceHostWorkflowResult> {
  const injected = hooks().executor;
  if (injected) return injected(input);
  if (input.action === 'initialize') return executeAdmittedWorkspaceHostInitialization(input);
  if (input.action === 'install-desktop-pack') return executeAdmittedWorkspaceHostDesktopPack(input);
  const provider = resolveWorkspaceHostProvider(input.connection);
  if (input.action === 'destroy') {
    return runWorkspaceHostDestroy({ ...input, provider });
  }
  if (input.action !== 'provision') {
    return runWorkspaceHostLifecycle({ ...input, provider });
  }
  return runWorkspaceHostProvisioning({
    ...input,
    provider,
  });
}

async function workspaceHostProvisioningWorkflowImpl(
  input: WorkspaceHostWorkflowInput,
): Promise<WorkspaceHostWorkflowResult> {
  try {
    for (let turn = 0; turn < MAX_WORKFLOW_TURNS; turn += 1) {
      const result = await DBOS.runStep(() => executeToleratingControllerFence(input), {
        name: `workspace-host-${input.action}-${turn}`,
        retriesAllowed: true,
        maxAttempts: 3,
        intervalSeconds: 2,
        shouldRetry: (error) =>
          !(error instanceof WorkspaceHostProvisioningRequestError) &&
          !(error instanceof WorkspaceHostProvisioningConnectionError),
      });
      if (result.status !== 'in-progress') return result;
      const retryAfterMs = Math.max(250, Math.min(30_000, result.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
      await DBOS.sleep(retryAfterMs);
    }
    throw new Error('Workspace-host provisioning exceeded its durable workflow turn budget');
  } catch (error) {
    // WI-10001739 link 2: a step that exhausts its retries throws straight out of this workflow.
    // Nothing downstream records that, so the operation row keeps its last-known status and a
    // stale updated_at — it looks ALIVE. ~20min later the hosted-lifecycle reconciler reaps it on
    // recency alone and writes a SYNTHESIZED hosted_lifecycle_recovery_exhausted, erasing the real
    // cause. Persist the true terminal cause here, at the only point that still has it.
    try {
      await DBOS.runStep(
        () =>
          recordWorkspaceHostOperationTerminalFailure({
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            message: 'Workspace-host workflow failed',
            error,
          }),
        { name: `workspace-host-${input.action}-terminal-failure`, retriesAllowed: false },
      );
    } catch (recordError) {
      // The ORIGINAL error must always win: a failure to record must never mask what failed.
      console.error('[workspace-host] could not persist terminal failure', recordError);
    }
    throw error;
  }
}

/** Registered workflow name AND queue name — a DBOS client enqueues by these strings. */
export const WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME = 'workspace-host-provision';

export const workspaceHostProvisioningWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostProvisioningWorkflowImpl, {
    name: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
    maxRecoveryAttempts: 20,
  }),
);

export const workspaceHostProvisioningQueue = idempotentWorkflowQueue(
  WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
  () => new WorkflowQueue(WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME, { concurrency: queueConcurrency(4) }),
);

/**
 * The exact enqueue request for one provision. Both the in-process start below and the
 * hosted control plane's DBOS client (`workspace-host-provision-client.ts`) build it here,
 * so a client-enqueued provision carries the same workflow id, dedup key and input as an
 * in-process one — and a replay of either collapses onto the same durable workflow.
 */
export function workspaceHostProvisioningEnqueueRequest(input: StartWorkspaceHostProvisioningInput): {
  workflowInput: WorkspaceHostProvisioningWorkflowInput;
  workflowId: string;
  deduplicationId: string;
} {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostProvisioningWorkflowInput = { ...input, action: 'provision', operationId };
  const keys = workspaceHostWorkflowKeys({
    workspaceId: input.workspaceId,
    hostId: input.desired.hostId,
    operationId,
  });
  return { workflowInput, workflowId: keys.workflowId, deduplicationId: keys.deduplicationId };
}

export class WorkspaceHostProvisioningConflictError extends Error {
  constructor(readonly hostId: string) {
    super(`Workspace host '${hostId}' already has a provisioning operation in progress`);
    this.name = 'WorkspaceHostProvisioningConflictError';
  }
}

export function isWorkspaceHostProvisioningDedupConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { dbosErrorCode?: number }).dbosErrorCode === QUEUE_DEDUP_DUPLICATED_CODE
  );
}

function serializedProvisioningProblems(error: unknown, expectedName: string): readonly string[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; problems?: unknown };
  if (candidate.name !== expectedName || !Array.isArray(candidate.problems) || candidate.problems.length === 0) {
    return null;
  }
  if (!candidate.problems.every((problem) => typeof problem === 'string' && problem.length > 0)) return null;
  return candidate.problems;
}

function rehydrateWorkspaceHostProvisioningError(error: unknown): unknown {
  if (
    error instanceof WorkspaceHostProvisioningRequestError ||
    error instanceof WorkspaceHostProvisioningConnectionError ||
    error instanceof WorkspaceHostProvisioningTransientError
  ) {
    return error;
  }

  const requestProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningRequestError');
  if (requestProblems) return new WorkspaceHostProvisioningRequestError(requestProblems);

  const connectionProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningConnectionError');
  if (connectionProblems) return new WorkspaceHostProvisioningConnectionError(connectionProblems);

  const transientProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningTransientError');
  if (transientProblems) return new WorkspaceHostProvisioningTransientError(transientProblems);

  return error;
}

/**
 * Wait at most the admission window for a durably-enqueued workflow (EI-23712230399040759).
 * `DBOS.getResult` rethrows the workflow's own failure, so a fast typed refusal still reaches
 * the route's typed mapping; `null` means the workflow is queued or running and the caller
 * answers 202 instead of holding the request open for minutes.
 */
async function settleWithinAdmissionWindow<T>(
  workflowId: string,
  accepted: WorkspaceHostOperationAcceptance,
): Promise<T | WorkspaceHostOperationAcceptance> {
  const settled = await DBOS.getResult<T>(workflowId, {
    timeoutSeconds: WORKSPACE_HOST_ADMISSION_WINDOW_MS / 1_000,
  });
  return settled ?? accepted;
}

export function isWorkspaceHostOperationAcceptance(value: unknown): value is WorkspaceHostOperationAcceptance {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'accepted';
}

export async function startWorkspaceHostProvisioningWorkflow(
  input: StartWorkspaceHostProvisioningInput,
): Promise<WorkspaceHostProvisioningResult | WorkspaceHostOperationAcceptance> {
  const request = workspaceHostProvisioningEnqueueRequest(input);
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: request.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: request.deduplicationId },
    })(request.workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostProvisioningResult>(request.workflowId, {
      status: 'accepted',
      operationId: request.workflowInput.operationId,
      hostId: input.desired.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.desired.hostId);
    }
    // DBOS serializes workflow errors through serialize-error. That preserves
    // name + enumerable fields, but deliberately rebuilds a plain Error and
    // therefore erases the custom prototype that the route uses for typed HTTP
    // mapping. Rehydrate only the two validated terminal shapes at this durable
    // boundary; unrelated/transient errors retain their original identity.
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export async function startWorkspaceHostDestroyWorkflow(
  input: StartWorkspaceHostDestroyInput,
): Promise<WorkspaceHostDestroyResult | WorkspaceHostOperationAcceptance> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostDestroyWorkflowInput = { ...input, action: 'destroy', operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostDestroyResult>(keys.workflowId, {
      status: 'accepted',
      operationId,
      hostId: input.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export async function startWorkspaceHostLifecycleWorkflow(
  input: StartWorkspaceHostLifecycleInput,
): Promise<WorkspaceHostProvisioningResult | WorkspaceHostOperationAcceptance> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostLifecycleWorkflowInput = { ...input, operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostProvisioningResult>(keys.workflowId, {
      status: 'accepted',
      operationId,
      hostId: input.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export class WorkspaceHostOperationIdentityConflictError extends Error {
  constructor() {
    super('Workspace-host operation ID is already bound to a different request');
    this.name = 'WorkspaceHostOperationIdentityConflictError';
  }
}

/** Return once DBOS has durably enqueued, never await the remote result at an HTTP boundary. */
export async function startWorkspaceHostInitializationWorkflow(request: WorkspaceHostInitializationRequest) {
  return startWorkspaceHostRemoteOperation({ ...request, action: 'initialize' });
}

export async function startWorkspaceHostDesktopPackWorkflow(request: WorkspaceHostDesktopPackRequest) {
  return startWorkspaceHostRemoteOperation(request);
}

async function startWorkspaceHostRemoteOperation(input: (WorkspaceHostInitializationRequest & { action: 'initialize' }) | WorkspaceHostDesktopPackRequest) {
  const keys = workspaceHostWorkflowKeys(input);
  try {
    const handle = await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(input);
    // DBOS binds the first input to an ID. A retry may change only its admission timestamp.
    const [stored] = await handle.getWorkflowInputs<[WorkspaceHostWorkflowInput]>();
    const { requestedAt: _requestedAt, ...identity } = input;
    if (stored.action !== 'initialize' && stored.action !== 'install-desktop-pack') throw new WorkspaceHostOperationIdentityConflictError();
    const { requestedAt: _storedRequestedAt, ...storedIdentity } = stored;
    if (!isDeepStrictEqual(identity, storedIdentity)) throw new WorkspaceHostOperationIdentityConflictError();
    return { operationId: input.operationId, hostId: input.hostId, status: 'accepted' as const };
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw error;
  }
}
