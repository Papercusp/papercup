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

/**
 * Process-bound executions should not inherit the day-long lease used by
 * interactive sessions.  A test runner knows its foreground budget, so it can
 * derive a lease that is just long enough to cover that budget plus the small
 * amount of time needed to reap a child.  The cap is deliberately finite: a
 * malformed/forgotten timeout must not turn a short-lived process receipt into
 * another effectively permanent claim.
 */
export const GOVERNED_EXECUTION_SHORT_LEASE_MIN_MS = 5_000;
export const GOVERNED_EXECUTION_SHORT_LEASE_MAX_MS = 30 * 60_000;
export const GOVERNED_EXECUTION_SHORT_LEASE_GRACE_MS = 5_000;
export const GOVERNED_EXECUTION_PROCESS_LEASE_TTL_MS = 5 * 60_000;

export function governedExecutionLeaseTtlForTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return GOVERNED_EXECUTION_PROCESS_LEASE_TTL_MS;
  }
  const bounded = Math.floor(timeoutMs) + GOVERNED_EXECUTION_SHORT_LEASE_GRACE_MS;
  return Math.min(
    GOVERNED_EXECUTION_SHORT_LEASE_MAX_MS,
    Math.max(GOVERNED_EXECUTION_SHORT_LEASE_MIN_MS, bounded),
  );
}

export interface GovernedExecution {
  readonly receiptId: string;
  readonly context: AdmissionContext;
  readonly lease: AdmissionQueueLeaseClaim['lease'];
  finish(actualDemand?: ResourceDemand): Promise<boolean>;
  cancel(reason: string): Promise<boolean>;
}

export type GovernedExecutionSettlement =
  | { readonly kind: 'release'; readonly actualDemand?: ResourceDemand }
  | { readonly kind: 'cancel'; readonly reason: string };

export interface GovernedExecutionInput<T = unknown> {
  readonly owner: string;
  readonly leaseTtlMs?: number;
  /**
   * Choose the terminal action after the bounded operation returns.  A normal
   * test failure still releases resources (the process really ran), while a
   * timeout/abort/launch failure cancels the receipt because no trustworthy
   * test verdict exists.  Omitting this preserves the historical release-on-
   * success behaviour.
   */
  readonly settle?: (
    result: T,
    context: AdmissionContext,
  ) => GovernedExecutionSettlement | Promise<GovernedExecutionSettlement>;
  /** Convenience for callers that only need to provide measured demand. */
  readonly measureActualDemand?: () => ResourceDemand | undefined | Promise<ResourceDemand | undefined>;
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
  input: GovernedExecutionInput<T>,
  deps: GovernedExecutionDeps,
  run: (context: AdmissionContext) => Promise<T>,
): Promise<T> {
  const execution = await beginGovernedExecution(
    request,
    { owner: input.owner, leaseTtlMs: input.leaseTtlMs },
    deps,
  );
  try {
    const result = await run(execution.context);
    const settlement = input.settle
      ? await input.settle(result, execution.context)
      : {
          kind: 'release' as const,
          actualDemand: input.measureActualDemand ? await input.measureActualDemand() : undefined,
        };
    if (settlement.kind === 'cancel') await execution.cancel(settlement.reason);
    else await execution.finish(settlement.actualDemand);
    return result;
  } catch (error) {
    // Preserve the operation's original error even if a best-effort durable
    // cancellation itself is unavailable (for example, a transient database
    // failure while recording the failure path).
    await execution.cancel(
      `governed execution failed: ${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => undefined);
    throw error;
  }
}

export interface GovernedOperationInput<T = unknown> {
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
  readonly settle?: (
    result: T,
    context: AdmissionContext,
  ) => GovernedExecutionSettlement | Promise<GovernedExecutionSettlement>;
  readonly measureActualDemand?: () => ResourceDemand | undefined | Promise<ResourceDemand | undefined>;
}

/** Workspace-scoped convenience seam used by request/tool subprocess writers. */
export function runGovernedOperation<T>(
  input: GovernedOperationInput<T>,
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
    {
      owner: input.owner,
      leaseTtlMs: input.leaseTtlMs,
      ...(input.settle ? { settle: input.settle } : {}),
      ...(input.measureActualDemand ? { measureActualDemand: input.measureActualDemand } : {}),
    },
    governedExecutionRuntime(input.workspaceId, namespace),
    run,
  );
}

export async function beginGovernedExecution<T = unknown>(
  request: AdmissionRequest,
  input: Pick<GovernedExecutionInput<T>, 'owner' | 'leaseTtlMs'>,
  deps: GovernedExecutionDeps,
): Promise<GovernedExecution> {
  const outcome = await deps.governor.admit(request);
  if (outcome.kind !== 'queued') {
    throw new Error(`governed execution requires a durable queued receipt; received '${outcome.kind}'`);
  }

  // Admission is persisted before the targeted lease.  Every failure after
  // that point must remove the visible receipt; otherwise a failed process
  // start leaves a queued item that the drainer can resurrect later.
  const cancelStartFailure = async (reason: string, claim?: AdmissionQueueLeaseClaim): Promise<void> => {
    if (claim) {
      await deps.driver.releaseLease(claim.receiptId, claim.lease.leaseId).catch(() => undefined);
    }
    await deps.governor.cancel(request.idempotencyKey, reason).catch(() => undefined);
  };

  let claim: AdmissionQueueLeaseClaim | null = null;
  try {
    claim = await deps.driver.leaseReceipt({
      receiptId: outcome.receipt.receiptId,
      owner: input.owner,
      ttlMs: input.leaseTtlMs ?? GOVERNED_EXECUTION_LEASE_TTL_MS,
    });
  } catch (error) {
    await cancelStartFailure(
      `governed execution lease acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  if (!claim) {
    const error = new Error(`durable receipt '${outcome.receipt.receiptId}' is not leaseable`);
    await cancelStartFailure(error.message);
    throw error;
  }

  let running: Awaited<ReturnType<GovernedExecutionDeps['driver']['markRunning']>>;
  try {
    running = await deps.driver.markRunning(claim.receiptId, claim.lease.leaseId);
  } catch (error) {
    await cancelStartFailure(
      `governed execution start failed: ${error instanceof Error ? error.message : String(error)}`,
      claim,
    );
    throw error;
  }
  if (!running?.changed) {
    const error = new Error(`durable receipt '${claim.receiptId}' could not enter running state`);
    await cancelStartFailure(error.message, claim);
    throw error;
  }

  let settled = false;
  let settlementInFlight: Promise<boolean> | null = null;
  const settleOnce = (operation: () => Promise<boolean>): Promise<boolean> => {
    if (settled || settlementInFlight) return Promise.resolve(false);
    let current!: Promise<boolean>;
    current = (async () => {
      try {
        const changed = await operation();
        // A terminal call is one-shot even when another process already won
        // the durable transition (`changed === false`).  This prevents a pair
        // of close/error/abort callbacks from repeatedly hitting the store.
        settled = true;
        return changed;
      } catch (error) {
        // A transport/database failure is not a terminal state.  Permit an
        // explicit retry while still serializing all concurrent callers.
        throw error;
      } finally {
        if (settlementInFlight === current) settlementInFlight = null;
      }
    })();
    settlementInFlight = current;
    return current;
  };

  return Object.freeze({
    receiptId: claim.receiptId,
    context: Object.freeze(claim.context),
    lease: Object.freeze(claim.lease),
    finish(actualDemand?: ResourceDemand): Promise<boolean> {
      return settleOnce(async () => (await deps.governor.release(claim!.context, actualDemand)).released);
    },
    cancel(reason: string): Promise<boolean> {
      return settleOnce(async () => (await deps.governor.cancel(request.idempotencyKey, reason)).cancelled);
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
