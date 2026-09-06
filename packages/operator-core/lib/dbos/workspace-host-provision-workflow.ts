/**
 * Host-scoped DBOS admission for workspace-host provisioning (D-100).
 *
 * The runner is operation-replay-safe; this workflow adds the missing cross-operation mutex. A
 * stable workflow id resumes one operation, while the host-scoped deduplication id prevents two
 * different operation ids from mutating the same resource graph concurrently.
 */
import { randomUUID } from 'node:crypto';
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  resolveWorkspaceHostProvider,
  workspaceHostWorkflowKeys,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
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
  disposition: 'discard';
  confirmation: {
    expectedHostId: string;
    confirmedBy: string;
    confirmedAt: string;
  };
  canary: WorkspaceHostDestroyCanaryEvidence;
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
  | WorkspaceHostLifecycleWorkflowInput;

export type WorkspaceHostProvisioningExecutor = (
  input: WorkspaceHostWorkflowInput,
) => Promise<WorkspaceHostProvisioningResult | WorkspaceHostDestroyResult>;

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

async function execute(input: WorkspaceHostWorkflowInput): Promise<WorkspaceHostProvisioningResult> {
  const injected = hooks().executor;
  if (injected) return injected(input);
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
): Promise<WorkspaceHostProvisioningResult> {
  for (let turn = 0; turn < MAX_WORKFLOW_TURNS; turn += 1) {
    const result = await DBOS.runStep(() => execute(input), {
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
}

export const workspaceHostProvisioningWorkflow = idempotentRegisterWorkflow('workspace-host-provision', () =>
  DBOS.registerWorkflow(workspaceHostProvisioningWorkflowImpl, {
    name: 'workspace-host-provision',
    maxRecoveryAttempts: 20,
  }),
);

export const workspaceHostProvisioningQueue = idempotentWorkflowQueue(
  'workspace-host-provision',
  () => new WorkflowQueue('workspace-host-provision', { concurrency: queueConcurrency(4) }),
);

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

export async function startWorkspaceHostProvisioningWorkflow(
  input: StartWorkspaceHostProvisioningInput,
): Promise<WorkspaceHostProvisioningResult> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostProvisioningWorkflowInput = { ...input, action: 'provision', operationId };
  const keys = workspaceHostWorkflowKeys({
    workspaceId: input.workspaceId,
    hostId: input.desired.hostId,
    operationId,
  });
  try {
    const handle = await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
    return await handle.getResult();
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
): Promise<WorkspaceHostDestroyResult> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostDestroyWorkflowInput = { ...input, action: 'destroy', operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  try {
    const handle = await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
    return (await handle.getResult()) as WorkspaceHostDestroyResult;
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export async function startWorkspaceHostLifecycleWorkflow(
  input: StartWorkspaceHostLifecycleInput,
): Promise<WorkspaceHostProvisioningResult> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostLifecycleWorkflowInput = { ...input, operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  try {
    const handle = await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
    return (await handle.getResult()) as WorkspaceHostProvisioningResult;
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}
