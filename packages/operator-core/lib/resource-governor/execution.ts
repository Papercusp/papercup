/** Durable receipt-to-process lifecycle used by subsystem migrations. */
import { randomUUID } from 'node:crypto';
import { Governor, type AdmissionContext, type AdmissionRequest, type ResourceDemand } from './admission';
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
