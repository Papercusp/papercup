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
  workspaceHostWorkflowKeys,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
import { createAdcGcpWorkspaceHostProvider } from '../workspace-host/gcp-provider';
import {
  runWorkspaceHostProvisioning,
  type WorkspaceHostProvisioningResult,
} from '../workspace-host/provisioning-runner';
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

interface WorkspaceHostProvisioningWorkflowInput extends StartWorkspaceHostProvisioningInput {
  operationId: string;
}

export type WorkspaceHostProvisioningExecutor = (
  input: WorkspaceHostProvisioningWorkflowInput,
) => Promise<WorkspaceHostProvisioningResult>;

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

async function execute(input: WorkspaceHostProvisioningWorkflowInput): Promise<WorkspaceHostProvisioningResult> {
  const injected = hooks().executor;
  if (injected) return injected(input);
  return runWorkspaceHostProvisioning({
    ...input,
    provider: createAdcGcpWorkspaceHostProvider(),
  });
}

async function workspaceHostProvisioningWorkflowImpl(
  input: WorkspaceHostProvisioningWorkflowInput,
): Promise<WorkspaceHostProvisioningResult> {
  for (let turn = 0; turn < MAX_WORKFLOW_TURNS; turn += 1) {
    const result = await DBOS.runStep(() => execute(input), {
      name: `workspace-host-provision-${turn}`,
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: 2,
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

export async function startWorkspaceHostProvisioningWorkflow(
  input: StartWorkspaceHostProvisioningInput,
): Promise<WorkspaceHostProvisioningResult> {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostProvisioningWorkflowInput = { ...input, operationId };
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
    throw error;
  }
}
