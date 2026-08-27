/** Durable receipt-to-process lifecycle used by subsystem migrations. */
import { randomUUID } from 'node:crypto';
import {
  Governor,
  type AdmissionClass,
  type AdmissionContext,
  type AdmissionMetadataValue,
  type AdmissionRequest,
  type ResourceDemand,
} from './admission';
import { PgWorkItemAdmissionQueueStore, WorkItemAdmissionQueueDriver, type AdmissionQueueLeaseClaim } from './queue';

export const GOVERNED_EXECUTION_LEASE_TTL_MS = 24 * 60 * 60_000;

export interface GovernedExecution {
  readonly receiptId: string;
  readonly context: AdmissionContext;
  readonly lease: AdmissionQueueLeaseClaim['lease'];
  finish(actualDemand?: ResourceDemand): Promise<boolean>;
  cancel(reason: string): Promise<boolean>;
}

export interface GovernedExecutionDeps {
  readonly governor: Governor;
  readonly driver: WorkItemAdmissionQueueDriver;
}

/**
 * Run one bounded unit behind the durable admission lifecycle.
 *
 * Subsystem migrations used to repeat the same begin/try/finish/cancel shape at
 * every process boundary. Apart from being noisy, that made the failure path the
 * easiest part to forget. Keep the actual resource start inside `run`: a normal
 * result exact-releases the durable lease, while a thrown spawn/runtime failure
 * cancels the visible receipt before the error escapes.
 */
export async function withGovernedExecution<T>(
  request: AdmissionRequest,
  input: { owner: string; leaseTtlMs?: number },
  deps: GovernedExecutionDeps,
  run: (context: AdmissionContext) => Promise<T>,
): Promise<T> {
  const execution = await beginGovernedExecution(request, input, deps);
  try {
    const result = await run(execution.context);
    await execution.finish();
    return result;
  } catch (error) {
    await execution.cancel(
      `governed execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export interface GovernedOperationInput {
  readonly workspaceId: string;
  readonly namespace: string;
  readonly owner: string;
  readonly admissionClass: AdmissionClass;
  readonly demand?: ResourceDemand;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext;
  readonly metadata?: Readonly<Record<string, AdmissionMetadataValue>>;
  readonly idempotencyKey?: string;
  readonly leaseTtlMs?: number;
}

/** Workspace-scoped convenience seam used by request/tool subprocess writers. */
export function runGovernedOperation<T>(
  input: GovernedOperationInput,
  run: (context: AdmissionContext) => Promise<T>,
): Promise<T> {
  const namespace = input.namespace.trim();
  if (!namespace) throw new Error('governed operation namespace must be non-empty');
  return withGovernedExecution(
    {
      idempotencyKey: input.idempotencyKey?.trim() || `${namespace}:${randomUUID()}`,
      admissionClass: input.admissionClass,
      demand: input.demand,
      payloadRef: input.payloadRef,
      parent: input.parent,
      metadata: input.metadata,
    },
    { owner: input.owner, leaseTtlMs: input.leaseTtlMs },
    governedExecutionRuntime(input.workspaceId, namespace),
    run,
  );
}

export async function beginGovernedExecution(
  request: AdmissionRequest,
  input: { owner: string; leaseTtlMs?: number },
  deps: GovernedExecutionDeps,
): Promise<GovernedExecution> {
  const outcome = await deps.governor.admit(request);
  if (outcome.kind !== 'queued') {
    throw new Error(`governed execution requires a durable queued receipt; received '${outcome.kind}'`);
  }
  const claim = await deps.driver.leaseReceipt({
    receiptId: outcome.receipt.receiptId,
    owner: input.owner,
    ttlMs: input.leaseTtlMs ?? GOVERNED_EXECUTION_LEASE_TTL_MS,
  });
  if (!claim) throw new Error(`durable receipt '${outcome.receipt.receiptId}' is not leaseable`);
  const running = await deps.driver.markRunning(claim.receiptId, claim.lease.leaseId);
  if (!running?.changed) {
    await deps.driver.releaseLease(claim.receiptId, claim.lease.leaseId);
    throw new Error(`durable receipt '${claim.receiptId}' could not enter running state`);
  }

  let settled = false;
  return Object.freeze({
    receiptId: claim.receiptId,
    context: Object.freeze(claim.context),
    lease: Object.freeze(claim.lease),
    async finish(actualDemand?: ResourceDemand): Promise<boolean> {
      if (settled) return false;
      const result = await deps.governor.release(claim.context, actualDemand);
      if (result.released) settled = true;
      return result.released;
    },
    async cancel(reason: string): Promise<boolean> {
      if (settled) return false;
      const result = await deps.governor.cancel(request.idempotencyKey, reason);
      if (result.cancelled) settled = true;
      return result.cancelled;
    },
  });
}

const runtimes = new Map<string, GovernedExecutionDeps>();

/** Process-local facade over the canonical PG-backed queue; receipts remain cross-process durable. */
export function governedExecutionRuntime(workspaceId: string, namespace = 'agent-process'): GovernedExecutionDeps {
  const key = `${workspaceId}\0${namespace}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    const driver = new WorkItemAdmissionQueueDriver(new PgWorkItemAdmissionQueueStore({ workspaceId }), {
      namespace,
      leaseIdFactory: () => randomUUID(),
    });
    runtime = { driver, governor: new Governor(driver) };
    runtimes.set(key, runtime);
  }
  return runtime;
}

export function resetGovernedExecutionRuntimesForTests(): void {
  runtimes.clear();
}

/** Decode the typed parent lineage propagated through a spawned process env. */
export function admissionContextFromEnvironment(value: string | undefined): AdmissionContext | undefined {
  if (!value?.trim()) return undefined;
  try {
    const context = JSON.parse(value) as Partial<AdmissionContext>;
    if (
      context.contractVersion !== 1
      || typeof context.requestId !== 'string'
      || !context.requestId
      || typeof context.rootRequestId !== 'string'
      || !context.rootRequestId
      || typeof context.idempotencyKey !== 'string'
      || !context.idempotencyKey
      || typeof context.admissionClass !== 'string'
      || typeof context.priority !== 'number'
      || !context.demand
      || typeof context.demand !== 'object'
      || typeof context.depth !== 'number'
      || typeof context.createdAtMs !== 'number'
      || typeof context.decisionGeneration !== 'number'
    ) return undefined;
    return Object.freeze(context as AdmissionContext);
  } catch {
    return undefined;
  }
}
