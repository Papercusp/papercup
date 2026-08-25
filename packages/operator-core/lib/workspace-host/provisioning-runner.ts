/**
 * Production workspace-host provisioning assembly.
 *
 * The provider contract and the pure durable-workflow oracle predate this file. What was missing
 * was the controller that joins them to the observability store. The ordering here is deliberate:
 * plan locally, persist the desired host intent, persist the operation and EVERY resource plan,
 * and only then permit the first provider mutation. Re-entry reads those checkpoints and
 * reconciles an uncertain call instead of issuing an unrelated create.
 */
import { randomUUID } from 'node:crypto';
import {
  assertWorkspaceHostSecretIsolation,
  createWorkspaceHostManualDestroyReceipt,
  nextWorkspaceHostControllerAction,
  WORKSPACE_HOST_CANARY_TAG_KEYS,
  WorkspaceHostLiveCanaryHarness,
  type WorkspaceHostApplyResult,
  type WorkspaceHostCanaryCompletionReceipt,
  type WorkspaceHostCanaryCostEvidence,
  type WorkspaceHostCanaryOrphanCensus,
  type WorkspaceHostContractApproval,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostDurableResourcePlan,
  type WorkspaceHostDurableWorkflowSpec,
  type WorkspaceHostManualDestroyReceipt,
  type WorkspaceHostObservation,
  type WorkspaceHostPlan,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostProviderContext,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import type { GcpWorkspaceHostInventoryRequest, GcpWorkspaceHostInventorySnapshot } from './gcp-provider';
import { censusGcpWorkspaceHostResources, type GcpWorkspaceHostResourceCensus } from './gcp-safety';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  readWorkspaceHostDestroyTarget,
  readWorkspaceHostResourceCheckpoints,
  recordWorkspaceHostObservation,
  recordWorkspaceHostSignals,
  type StoredWorkspaceHostDestroyTarget,
  updateWorkspaceHostLifecycleState,
  updateWorkspaceHostOperation,
  upsertWorkspaceHost,
  upsertWorkspaceHostResourceCheckpoint,
} from './observability-store';

const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_CONTROLLER_TRANSITIONS_PER_REQUEST = 256;

export class WorkspaceHostProvisioningRequestError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super('workspace-host provisioning request rejected');
    this.name = 'WorkspaceHostProvisioningRequestError';
    this.problems = problems;
  }
}

export class WorkspaceHostProvisioningConnectionError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super('workspace-host provider connection is unavailable');
    this.name = 'WorkspaceHostProvisioningConnectionError';
    this.problems = problems;
  }
}

export interface WorkspaceHostProvisioningStore {
  upsertHost: typeof upsertWorkspaceHost;
  beginOperation: typeof beginWorkspaceHostOperation;
  updateOperation: typeof updateWorkspaceHostOperation;
  readCheckpoints: typeof readWorkspaceHostResourceCheckpoints;
  upsertCheckpoint: typeof upsertWorkspaceHostResourceCheckpoint;
  appendEvent: typeof appendWorkspaceHostEvent;
  recordObservation: typeof recordWorkspaceHostObservation;
}

const DEFAULT_STORE: WorkspaceHostProvisioningStore = {
  upsertHost: upsertWorkspaceHost,
  beginOperation: beginWorkspaceHostOperation,
  updateOperation: updateWorkspaceHostOperation,
  readCheckpoints: readWorkspaceHostResourceCheckpoints,
  upsertCheckpoint: upsertWorkspaceHostResourceCheckpoint,
  appendEvent: appendWorkspaceHostEvent,
  recordObservation: recordWorkspaceHostObservation,
};

export interface RunWorkspaceHostProvisioningInput {
  workspaceId: string;
  connectionId: string;
  name: string;
  desired: WorkspaceHostDesiredSpec;
  connection: WorkspaceHostProviderConnection;
  provider: WorkspaceHostProvider;
  operationId?: string;
  actorId?: string;
  signal?: AbortSignal;
  store?: WorkspaceHostProvisioningStore;
}

export interface WorkspaceHostProvisioningResult {
  status: 'succeeded' | 'in-progress' | 'failed';
  operationId: string;
  hostId: string;
  plan: WorkspaceHostPlan;
  checkpoints: readonly WorkspaceHostResourceCheckpoint[];
  retryAfterMs?: number;
}

/** External evidence the operator cannot manufacture from Compute Engine itself. */
export interface WorkspaceHostDestroyCanaryEvidence {
  runId: string;
  workspaceId: string;
  contractApproval: WorkspaceHostContractApproval;
  maxSpendCents?: number;
  teardownDeadlineAt: string;
  /** Durable Cloud Billing budget resource (or an equally authoritative external budget). */
  budgetEvidenceRef: string;
  /** A provider read establishing the cumulative project baseline before this run mutated anything. */
  preRunZeroBaseline: WorkspaceHostCanaryCostEvidence;
  /** Cumulative, named cost entries known when teardown begins. */
  costEvidence: readonly WorkspaceHostCanaryCostEvidence[];
  /** Provider-delayed billing entries learned after the initial settle. */
  lateObservedSpend?: readonly WorkspaceHostCanaryCostEvidence[];
  /**
   * Audit context for an emergency/manual teardown. Confirmations are intentionally absent here:
   * the runner creates them only from provider-produced post-delete reads.
   */
  emergencyManualDestroy?: {
    actorId: string;
    reason: string;
    procedureRef: string;
  };
}

export interface WorkspaceHostDestroyEvidenceResult {
  completionReceipt: WorkspaceHostCanaryCompletionReceipt;
  orphanCensus: WorkspaceHostCanaryOrphanCensus;
  providerCensus: GcpWorkspaceHostResourceCensus;
  budgetEvidenceRef: string;
  preRunZeroBaseline: WorkspaceHostCanaryCostEvidence;
  manualDestroyReceipts: readonly WorkspaceHostManualDestroyReceipt[];
}

export interface WorkspaceHostDestroyResult extends WorkspaceHostProvisioningResult {
  evidence?: WorkspaceHostDestroyEvidenceResult;
}

export interface WorkspaceHostDestroyStore {
  readTarget: typeof readWorkspaceHostDestroyTarget;
  beginOperation: typeof beginWorkspaceHostOperation;
  updateOperation: typeof updateWorkspaceHostOperation;
  readCheckpoints: typeof readWorkspaceHostResourceCheckpoints;
  upsertCheckpoint: typeof upsertWorkspaceHostResourceCheckpoint;
  appendEvent: typeof appendWorkspaceHostEvent;
  recordSignals: typeof recordWorkspaceHostSignals;
  updateHostState: typeof updateWorkspaceHostLifecycleState;
}

const DEFAULT_DESTROY_STORE: WorkspaceHostDestroyStore = {
  readTarget: readWorkspaceHostDestroyTarget,
  beginOperation: beginWorkspaceHostOperation,
  updateOperation: updateWorkspaceHostOperation,
  readCheckpoints: readWorkspaceHostResourceCheckpoints,
  upsertCheckpoint: upsertWorkspaceHostResourceCheckpoint,
  appendEvent: appendWorkspaceHostEvent,
  recordSignals: recordWorkspaceHostSignals,
  updateHostState: updateWorkspaceHostLifecycleState,
};

export interface RunWorkspaceHostDestroyInput {
  workspaceId: string;
  hostId: string;
  connection: WorkspaceHostProviderConnection;
  provider: WorkspaceHostProvider;
  disposition: 'discard';
  confirmation: {
    expectedHostId: string;
    confirmedBy: string;
    confirmedAt: string;
  };
  canary: WorkspaceHostDestroyCanaryEvidence;
  operationId?: string;
  actorId?: string;
  signal?: AbortSignal;
  store?: WorkspaceHostDestroyStore;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkspaceHostProvisioningRequestError([`${label} must not be empty`]);
  return trimmed;
}

const SAFE_CANARY_ID = /^[a-z0-9_-]{1,63}$/;

function isoTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new WorkspaceHostProvisioningRequestError([`${label} must be an ISO timestamp`]);
  return value;
}

function externalEvidenceRef(value: string, label: string): string {
  const ref = nonEmpty(value, label);
  if (ref.length > 2_000) {
    throw new WorkspaceHostProvisioningRequestError([`${label} must be at most 2000 characters`]);
  }
  return ref;
}

function validateDestroyCanaryEvidence(evidence: WorkspaceHostDestroyCanaryEvidence, workspaceId: string): void {
  const problems: string[] = [];
  if (!SAFE_CANARY_ID.test(evidence.runId)) {
    problems.push('canary.runId must already be lowercase [a-z0-9_-] and at most 63 characters');
  }
  if (!SAFE_CANARY_ID.test(evidence.workspaceId)) {
    problems.push('canary.workspaceId must already be lowercase [a-z0-9_-] and at most 63 characters');
  }
  if (evidence.workspaceId !== workspaceId) problems.push('canary.workspaceId must match the active workspace');
  if (evidence.preRunZeroBaseline.cents !== 0) {
    problems.push('canary.preRunZeroBaseline must establish an exact zero-cent baseline');
  }
  if (evidence.preRunZeroBaseline.reservationId) {
    problems.push('canary.preRunZeroBaseline must be passive provider evidence, not a reservation settlement');
  }
  if (evidence.costEvidence.length === 0 && (evidence.lateObservedSpend?.length ?? 0) === 0) {
    problems.push('canary requires at least one named cumulative or late-observed cost entry');
  }
  for (const [index, entry] of [
    evidence.preRunZeroBaseline,
    ...evidence.costEvidence,
    ...(evidence.lateObservedSpend ?? []),
  ].entries()) {
    if (entry.reservationId) problems.push(`canary cost evidence[${index}] must be passive cumulative evidence`);
  }
  if (problems.length > 0) throw new WorkspaceHostProvisioningRequestError(problems);

  externalEvidenceRef(evidence.budgetEvidenceRef, 'canary.budgetEvidenceRef');
  externalEvidenceRef(evidence.preRunZeroBaseline.providerEvidenceRef, 'canary.preRunZeroBaseline.providerEvidenceRef');
  isoTimestamp(evidence.preRunZeroBaseline.observedAt, 'canary.preRunZeroBaseline.observedAt');
  isoTimestamp(evidence.teardownDeadlineAt, 'canary.teardownDeadlineAt');
  assertWorkspaceHostSecretIsolation(evidence, 'workspaceHost.destroy.canary');
}

function assertDestroyCanaryLabels(
  desired: WorkspaceHostDesiredSpec,
  evidence: WorkspaceHostDestroyCanaryEvidence,
): Readonly<Record<string, string>> {
  const labels = desired.labels ?? {};
  const required = {
    [WORKSPACE_HOST_CANARY_TAG_KEYS.canary]: 'true',
    [WORKSPACE_HOST_CANARY_TAG_KEYS.runId]: evidence.runId,
    [WORKSPACE_HOST_CANARY_TAG_KEYS.workspaceId]: evidence.workspaceId,
  } as const;
  const problems = Object.entries(required)
    .filter(([key, value]) => labels[key] !== value)
    .map(([key, value]) => `stored desired.labels must contain '${key}=${value}'`);
  if (problems.length > 0) throw new WorkspaceHostProvisioningRequestError(problems);
  return required;
}

function destroyResourceForStep(
  step: WorkspaceHostPlanStep,
  resources: readonly WorkspaceHostResourceRef[],
): WorkspaceHostResourceRef {
  const providerId = typeof step.input.resourceName === 'string' ? step.input.resourceName : '';
  const resource = resources.find(
    (candidate) => candidate.kind === step.resourceKind && candidate.providerId === providerId,
  );
  if (!providerId || !resource) {
    throw new WorkspaceHostProvisioningRequestError([
      `destroy step '${step.id}' does not map to one registered provider resource`,
    ]);
  }
  return resource;
}

interface WorkspaceHostInventoryProvider extends WorkspaceHostProvider {
  inventoryManagedResources(request: GcpWorkspaceHostInventoryRequest): Promise<GcpWorkspaceHostInventorySnapshot>;
}

function inventoryProvider(provider: WorkspaceHostProvider): WorkspaceHostInventoryProvider {
  if (
    !('inventoryManagedResources' in provider) ||
    typeof (provider as Partial<WorkspaceHostInventoryProvider>).inventoryManagedResources !== 'function'
  ) {
    throw new WorkspaceHostProvisioningConnectionError([
      'provider does not expose controller-independent managed-resource inventory',
    ]);
  }
  return provider as WorkspaceHostInventoryProvider;
}

function networkLabel(desired: WorkspaceHostDesiredSpec): string {
  const network = desired.provider?.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) return 'provider-managed';
  const record = network as Record<string, unknown>;
  if (typeof record.networkName === 'string' && record.networkName.trim()) return record.networkName.trim();
  if (typeof record.mode === 'string' && record.mode.trim()) return record.mode.trim();
  return 'provider-managed';
}

function createdByOperation(step: WorkspaceHostPlanStep): boolean {
  const operation = typeof step.input.op === 'string' ? step.input.op : '';
  return !operation.startsWith('use-existing');
}

function durableWorkflow(
  input: RunWorkspaceHostProvisioningInput,
  operationId: string,
  plan: WorkspaceHostPlan,
): WorkspaceHostDurableWorkflowSpec {
  const resources: WorkspaceHostDurableResourcePlan[] = plan.steps.map((step) => {
    const created = createdByOperation(step);
    return {
      logicalKey: step.id,
      step,
      createdByOperation: created,
      deleteOnDestroy: created,
      // This initial provision surface has no cancellation verb. Under an uncertain outcome it
      // deliberately retains resources for reconcile/explicit confirmed destroy; guessing that a
      // provider call failed and auto-deleting is the data-loss direction.
      ...(created ? { retainOnCancel: true } : {}),
    };
  });
  return {
    identity: {
      workspaceId: input.workspaceId,
      hostId: input.desired.hostId,
      operationId,
      planId: plan.planId,
      target: plan.target,
      desiredGeneration: 1,
    },
    action: 'provision',
    resources,
    maxApplyAttempts: 3,
  };
}

function replaceCheckpoint(
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  checkpoint: WorkspaceHostResourceCheckpoint,
): WorkspaceHostResourceCheckpoint[] {
  const next = checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey);
  next.push(checkpoint);
  return next.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
}

function knownResources(checkpoints: readonly WorkspaceHostResourceCheckpoint[]): WorkspaceHostResourceRef[] {
  return checkpoints
    .filter((entry) => entry.state === 'applied' || entry.state === 'unchanged')
    .map((entry) => entry.providerResource)
    .filter((entry): entry is WorkspaceHostResourceRef => !!entry);
}

function progress(checkpoints: readonly WorkspaceHostResourceCheckpoint[], total: number): number {
  if (total === 0) return 100;
  const settled = checkpoints.filter(
    (entry) => entry.state === 'applied' || entry.state === 'unchanged' || entry.state === 'absent',
  ).length;
  return Math.max(0, Math.min(99, Math.floor((settled / total) * 100)));
}

function resultCheckpoint(
  prior: WorkspaceHostResourceCheckpoint,
  attempts: number,
  result: WorkspaceHostApplyResult,
): WorkspaceHostResourceCheckpoint {
  const common = {
    logicalKey: prior.logicalKey,
    attempts,
    ...(result.providerRequestId || prior.providerRequestId
      ? { providerRequestId: result.providerRequestId ?? prior.providerRequestId }
      : {}),
  };
  if (result.state === 'in-progress') {
    return {
      ...common,
      state: 'retry-wait',
      retryClass: 'ambiguous',
      retryAfterMs: result.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
    };
  }
  if (result.state === 'destroyed') {
    return {
      ...common,
      state: 'absent',
      ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
      deletionConfirmation: result.confirmation,
    };
  }
  return {
    ...common,
    state: result.state,
    ...(result.resource || prior.providerResource
      ? { providerResource: result.resource ?? prior.providerResource }
      : {}),
  };
}

async function persistCheckpoint(
  store: WorkspaceHostProvisioningStore,
  input: RunWorkspaceHostProvisioningInput,
  operationId: string,
  checkpoint: WorkspaceHostResourceCheckpoint,
): Promise<void> {
  await store.upsertCheckpoint({
    workspaceId: input.workspaceId,
    hostId: input.desired.hostId,
    operationId,
    checkpoint,
  });
}

async function observeAfterProvision(
  input: RunWorkspaceHostProvisioningInput,
  store: WorkspaceHostProvisioningStore,
  operationId: string,
  context: WorkspaceHostProviderContext,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): Promise<WorkspaceHostObservation | undefined> {
  try {
    const observation = await input.provider.observe(
      { hostId: input.desired.hostId, target: input.desired.target, resources: knownResources(checkpoints) },
      context,
    );
    await store.recordObservation(input.workspaceId, observation);
    return observation;
  } catch (error) {
    await store.appendEvent({
      workspaceId: input.workspaceId,
      hostId: input.desired.hostId,
      operationId,
      phase: 'observe',
      status: 'running',
      level: 'warn',
      message: 'Provider resources were applied, but the post-provision observation is pending',
      details: { error: message(error) },
    });
    return undefined;
  }
}

export async function runWorkspaceHostProvisioning(
  input: RunWorkspaceHostProvisioningInput,
): Promise<WorkspaceHostProvisioningResult> {
  const store = input.store ?? DEFAULT_STORE;
  const workspaceId = nonEmpty(input.workspaceId, 'workspaceId');
  const connectionId = nonEmpty(input.connectionId, 'connectionId');
  const name = nonEmpty(input.name, 'name');
  const operationId = nonEmpty(input.operationId ?? randomUUID(), 'operationId');
  const hostId = nonEmpty(input.desired.hostId, 'desired.hostId');

  const requestProblems: string[] = [];
  try {
    assertWorkspaceHostSecretIsolation(input.desired, 'workspaceHost.desiredSpec');
  } catch (error) {
    requestProblems.push(message(error));
  }
  if (input.provider.target !== input.desired.target) {
    requestProblems.push(
      `provider target '${input.provider.target}' does not match desired target '${input.desired.target}'`,
    );
  }
  if (input.connection.target !== input.desired.target) {
    requestProblems.push(
      `connection target '${input.connection.target}' does not match desired target '${input.desired.target}'`,
    );
  }
  const desiredCloudRef = input.desired.credentials?.cloudCredentialRef;
  if (desiredCloudRef?.kind !== 'cloud' || desiredCloudRef.ref !== input.connection.cloudCredentialRef.ref) {
    requestProblems.push('desired cloudCredentialRef must match the selected workspace-host connection');
  }
  if (requestProblems.length > 0) throw new WorkspaceHostProvisioningRequestError(requestProblems);

  const context: WorkspaceHostProviderContext = {
    workspaceId,
    requestId: operationId,
    connection: input.connection,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  let validation;
  try {
    validation = await input.provider.validateConnection(context);
  } catch {
    throw new WorkspaceHostProvisioningConnectionError(['provider connection validation failed']);
  }
  if (!validation.ok) {
    throw new WorkspaceHostProvisioningConnectionError(
      validation.errors.length > 0 ? validation.errors : ['provider connection is not usable'],
    );
  }

  let plan: WorkspaceHostPlan;
  try {
    plan = await input.provider.plan(
      {
        action: 'provision',
        operationId,
        idempotencyKey: `workspace-host:${workspaceId}:${hostId}:${operationId}:provision`,
        desired: input.desired,
      },
      context,
    );
  } catch (error) {
    throw new WorkspaceHostProvisioningRequestError([message(error)]);
  }
  const identityProblems: string[] = [];
  if (plan.operationId !== operationId) identityProblems.push('provider plan changed operationId');
  if (plan.hostId !== hostId) identityProblems.push('provider plan changed hostId');
  if (plan.target !== input.desired.target) identityProblems.push('provider plan changed target');
  if (identityProblems.length > 0) throw new WorkspaceHostProvisioningRequestError(identityProblems);

  const workflow = durableWorkflow(input, operationId, plan);
  let checkpoints = await store.readCheckpoints(workspaceId, hostId, operationId);

  // No checkpoints means no provider mutation has been admitted for this operation. Persist the
  // exact desired spec before creating the operation/resource graph it governs.
  if (checkpoints.length === 0) {
    await store.upsertHost({
      workspaceId,
      id: hostId,
      name,
      connectionId,
      target: input.desired.target,
      scopeLabel: input.desired.scope.id,
      region: input.desired.region,
      size: input.desired.size,
      image: input.desired.image.id,
      diskGiB: input.desired.data.volumeGiB,
      network: networkLabel(input.desired),
      desiredState: 'provisioning',
      observedState: 'provisioning',
      desiredSpec: input.desired,
    });
  }

  await store.beginOperation({
    workspaceId,
    operationId,
    hostId,
    action: 'provision',
    status: 'running',
    message: 'Workspace-host provisioning started',
    request: { connectionId, name, desired: input.desired },
  });

  for (let transition = 0; transition < MAX_CONTROLLER_TRANSITIONS_PER_REQUEST; transition += 1) {
    const action = nextWorkspaceHostControllerAction(workflow, checkpoints);
    if (action.kind === 'record-plan') {
      for (const resource of action.resources) {
        const checkpoint: WorkspaceHostResourceCheckpoint = {
          logicalKey: resource.logicalKey,
          state: 'planned',
          attempts: 0,
        };
        await persistCheckpoint(store, input, operationId, checkpoint);
        checkpoints = replaceCheckpoint(checkpoints, checkpoint);
      }
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: 'plan',
        status: 'running',
        message: `Recorded ${action.resources.length} provider resource plan(s) before mutation`,
      });
      continue;
    }

    if (action.kind === 'apply' || action.kind === 'retry' || action.kind === 'reconcile') {
      const prior = checkpoints.find((entry) => entry.logicalKey === action.resource.logicalKey);
      if (!prior) throw new Error(`Missing checkpoint '${action.resource.logicalKey}' selected by controller`);
      const attempts = prior.attempts + 1;
      const beforeCall: WorkspaceHostResourceCheckpoint = {
        logicalKey: prior.logicalKey,
        state: action.kind === 'reconcile' ? 'reconciling' : 'applying',
        attempts,
        ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
        ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
      };
      await persistCheckpoint(store, input, operationId, beforeCall);
      checkpoints = replaceCheckpoint(checkpoints, beforeCall);

      const applyRequest = {
        planId: plan.planId,
        operationId,
        step: action.resource.step,
        knownResources: knownResources(checkpoints),
      };
      let providerResult: WorkspaceHostApplyResult;
      try {
        providerResult =
          action.kind === 'reconcile'
            ? await input.provider.reconcile(
                {
                  ...applyRequest,
                  reason: 'resume',
                  ...(prior.providerRequestId ? { previousProviderRequestId: prior.providerRequestId } : {}),
                },
                context,
              )
            : await input.provider.apply(applyRequest, context);
      } catch (error) {
        // A thrown provider call is ambiguous: the provider may have accepted the mutation before
        // the response was lost. Persist that uncertainty and make the next request reconcile.
        const failed: WorkspaceHostResourceCheckpoint = {
          logicalKey: prior.logicalKey,
          state: 'failed',
          attempts,
          retryClass: 'ambiguous',
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
          ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
          ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
          error: message(error),
        };
        await persistCheckpoint(store, input, operationId, failed);
        checkpoints = replaceCheckpoint(checkpoints, failed);
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'running',
          percent: progress(checkpoints, plan.steps.length),
          message: `Provider outcome for '${prior.logicalKey}' is uncertain; reconciliation required`,
        });
        await store.appendEvent({
          workspaceId,
          hostId,
          operationId,
          phase: prior.logicalKey,
          status: 'running',
          level: 'warn',
          message: 'Provider outcome is uncertain; the next request will reconcile before applying',
          details: { error: message(error) },
        });
        return {
          status: 'in-progress',
          operationId,
          hostId,
          plan,
          checkpoints,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        };
      }

      const afterCall = resultCheckpoint(prior, attempts, providerResult);
      await persistCheckpoint(store, input, operationId, afterCall);
      checkpoints = replaceCheckpoint(checkpoints, afterCall);
      const waiting = providerResult.state === 'in-progress';
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: progress(checkpoints, plan.steps.length),
        message: waiting
          ? `Provider step '${prior.logicalKey}' is still in progress`
          : `Provider step '${prior.logicalKey}' ${providerResult.state}`,
      });
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: prior.logicalKey,
        status: 'running',
        message: waiting ? 'Provider step is still in progress' : `Provider step ${providerResult.state}`,
        details: { state: providerResult.state },
      });
      if (providerResult.state === 'in-progress') {
        return {
          status: 'in-progress',
          operationId,
          hostId,
          plan,
          checkpoints,
          retryAfterMs: providerResult.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        };
      }
      continue;
    }

    if (action.kind === 'complete') {
      if (action.status === 'succeeded') {
        await observeAfterProvision(input, store, operationId, context, checkpoints);
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'succeeded',
          percent: 100,
          message: 'Workspace-host provider resources are provisioned',
        });
        await store.appendEvent({
          workspaceId,
          hostId,
          operationId,
          phase: 'complete',
          status: 'succeeded',
          message: 'Workspace-host provider resources are provisioned',
        });
        return { status: 'succeeded', operationId, hostId, plan, checkpoints };
      }
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'failed',
        percent: progress(checkpoints, plan.steps.length),
        message: 'Workspace-host provisioning could not complete',
        error: { reason: action.status },
      });
      return { status: 'failed', operationId, hostId, plan, checkpoints };
    }

    // No cancellation surface is exposed by this runner, so a compensation action is not an
    // admissible state. Likewise, a dependency block after a validated plan means persisted state
    // is inconsistent. Fail closed and leave the graph available for audit/recovery.
    const reason = action.kind === 'blocked' ? action.reason : 'unexpected-compensation';
    await store.updateOperation({
      workspaceId,
      operationId,
      status: 'failed',
      percent: progress(checkpoints, plan.steps.length),
      message: 'Workspace-host provisioning controller is blocked',
      error: { reason },
    });
    return { status: 'failed', operationId, hostId, plan, checkpoints };
  }

  throw new Error('Workspace-host provisioning exceeded its bounded controller transition budget');
}

function durableDestroyWorkflow(
  input: RunWorkspaceHostDestroyInput,
  operationId: string,
  plan: WorkspaceHostPlan,
  target: StoredWorkspaceHostDestroyTarget,
): WorkspaceHostDurableWorkflowSpec {
  const resources: WorkspaceHostDurableResourcePlan[] = plan.steps.map((step) => {
    if (!step.destructive || step.action !== 'destroy') {
      throw new WorkspaceHostProvisioningRequestError([`discard destroy plan contains non-delete step '${step.id}'`]);
    }
    // Resolve this before any plan checkpoint is written. That preserves an exact registered
    // provider identity on every absence receipt and prevents the destroy oracle's provider-id
    // match from becoming vacuous.
    destroyResourceForStep(
      step,
      target.resources.map((entry) => entry.resource),
    );
    return {
      logicalKey: step.id,
      step,
      createdByOperation: false,
      deleteOnDestroy: true,
    };
  });
  return {
    identity: {
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      planId: plan.planId,
      target: plan.target,
      desiredGeneration: 1,
    },
    action: 'destroy',
    resources,
    maxApplyAttempts: 3,
  };
}

function destroyProgress(checkpoints: readonly WorkspaceHostResourceCheckpoint[], total: number): number {
  if (total === 0) return 0;
  const confirmed = checkpoints.filter(
    (entry) => entry.state === 'absent' && entry.deletionConfirmation?.source === 'provider-read',
  ).length;
  return Math.max(0, Math.min(99, Math.floor((confirmed / total) * 100)));
}

function deterministicInventoryRequest(
  input: RunWorkspaceHostDestroyInput,
  target: StoredWorkspaceHostDestroyTarget,
  destroyTargets: readonly WorkspaceHostResourceRef[],
): GcpWorkspaceHostInventoryRequest {
  const names = (kind: string): string[] =>
    destroyTargets
      .filter((resource) => resource.kind === kind)
      .map((resource) => resource.providerId)
      .sort();
  const networks = names('network');
  const subnetworks = names('subnetwork');
  const firewalls = names('firewall');
  const routers = names('router');
  const natResources = destroyTargets.filter((resource) => resource.kind === 'nat');
  const nats = natResources
    .map((resource) => ({
      routerName: destroyTargets.find((candidate) => candidate.kind === 'router')?.providerId ?? '',
      name: resource.providerId,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const missing = [
    ['network', networks],
    ['subnetwork', subnetworks],
    ['firewall', firewalls],
    ['router', routers],
    ['nat', nats],
  ]
    .filter(([, entries]) => entries.length === 0)
    .map(([kind]) => kind);
  if (missing.length > 0 || nats.some((entry) => !entry.routerName)) {
    throw new WorkspaceHostProvisioningRequestError([
      `destroy census requires registered managed network identities: ${missing.join(', ') || 'NAT router'}`,
    ]);
  }
  const projectId =
    destroyTargets.find((resource) => resource.parentProviderId)?.parentProviderId ?? target.desired.scope.id;
  return {
    projectId: nonEmpty(projectId, 'destroy census projectId'),
    region: nonEmpty(target.desired.region, 'destroy census region'),
    workspaceId: input.canary.workspaceId,
    deterministicNames: { networks, subnetworks, firewalls, routers, nats },
  };
}

function restoreCanaryLedger(
  input: RunWorkspaceHostDestroyInput,
  target: StoredWorkspaceHostDestroyTarget,
  destroyTargets: readonly WorkspaceHostResourceRef[],
): WorkspaceHostLiveCanaryHarness {
  const tags = assertDestroyCanaryLabels(target.desired, input.canary);
  const ledger = new WorkspaceHostLiveCanaryHarness({
    runId: input.canary.runId,
    workspaceId: input.canary.workspaceId,
    target: input.provider.target,
    scope: target.desired.scope,
    cloudCredentialRef: input.connection.cloudCredentialRef,
    contractApproval: input.canary.contractApproval,
    ...(input.canary.maxSpendCents !== undefined ? { maxSpendCents: input.canary.maxSpendCents } : {}),
    teardownDeadlineAt: input.canary.teardownDeadlineAt,
  });
  for (const resource of destroyTargets) {
    const persisted = target.resources.find(
      (entry) =>
        entry.resource.target === resource.target &&
        entry.resource.kind === resource.kind &&
        entry.resource.providerId === resource.providerId,
    );
    if (!persisted) {
      throw new WorkspaceHostProvisioningRequestError([
        `destroy resource '${resource.providerId}' is absent from the durable canary population`,
      ]);
    }
    ledger.restoreRegisteredResource({ resource, tags, createdAt: persisted.registeredAt });
  }
  ledger.recordObservedSpend(input.canary.preRunZeroBaseline);
  for (const evidence of input.canary.costEvidence) ledger.recordObservedSpend(evidence);
  for (const evidence of input.canary.lateObservedSpend ?? []) ledger.recordObservedSpend(evidence);
  return ledger;
}

async function finalizeDestroyEvidence(
  input: RunWorkspaceHostDestroyInput,
  store: WorkspaceHostDestroyStore,
  target: StoredWorkspaceHostDestroyTarget,
  workflow: WorkspaceHostDurableWorkflowSpec,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): Promise<WorkspaceHostDestroyEvidenceResult> {
  const destroyTargets = workflow.resources.map((resource) =>
    destroyResourceForStep(
      resource.step,
      target.resources.map((entry) => entry.resource),
    ),
  );
  if (destroyTargets.length === 0) {
    throw new WorkspaceHostProvisioningRequestError([
      'destroy evidence cannot be produced over an empty resource population',
    ]);
  }
  const ledger = restoreCanaryLedger(input, target, destroyTargets);
  const manualDestroyReceipts: WorkspaceHostManualDestroyReceipt[] = [];
  for (const checkpoint of checkpoints) {
    const confirmation = checkpoint.deletionConfirmation;
    if (!confirmation || checkpoint.state !== 'absent') {
      throw new Error(`Destroy checkpoint '${checkpoint.logicalKey}' has no provider-read absence receipt`);
    }
    ledger.confirmResourceAbsent(confirmation);
    if (input.canary.emergencyManualDestroy) {
      const resource = destroyTargets.find((candidate) => candidate.providerId === confirmation.providerResourceId);
      if (!resource)
        throw new Error(`Manual destroy confirmation '${confirmation.providerResourceId}' is unregistered`);
      const receipt = createWorkspaceHostManualDestroyReceipt({
        runId: input.canary.runId,
        resource,
        actorId: input.canary.emergencyManualDestroy.actorId,
        reason: input.canary.emergencyManualDestroy.reason,
        procedureRef: input.canary.emergencyManualDestroy.procedureRef,
        issuedAt: confirmation.confirmedAbsentAt,
        confirmation,
        providerEvidence: {
          source: 'workspace-host-destroy-checkpoint',
          logicalKey: checkpoint.logicalKey,
          providerRequestId: checkpoint.providerRequestId,
        },
      });
      ledger.recordManualDestroyReceipt(receipt);
      manualDestroyReceipts.push(receipt);
    }
  }

  const inventory = await inventoryProvider(input.provider).inventoryManagedResources(
    deterministicInventoryRequest(input, target, destroyTargets),
  );
  if (!inventory.complete) throw new Error('Provider managed-resource inventory is incomplete');
  const observed = inventory.observed.map((entry) => ({ resource: entry.resource, tags: entry.labels }));
  const providerCensus = censusGcpWorkspaceHostResources({
    hostId: input.hostId,
    workspaceId: input.canary.workspaceId,
    expected: [],
    observed: inventory.observed,
    inventoryEvidence: inventory.inventoryEvidence,
    evaluatedAt: new Date().toISOString(),
    orphanGraceMs: 60_000,
  });
  const orphanCensus = ledger.orphanCensus(observed);
  if (!providerCensus.clean || !orphanCensus.clean) {
    throw new Error('Workspace-host destroy orphan census is not clean');
  }
  const completionReceipt = ledger.finalize(observed);
  if (completionReceipt.resourceCount === 0) {
    throw new Error('Workspace-host destroy completion receipt has an empty resource population');
  }
  const result: WorkspaceHostDestroyEvidenceResult = {
    completionReceipt,
    orphanCensus,
    providerCensus,
    budgetEvidenceRef: input.canary.budgetEvidenceRef,
    preRunZeroBaseline: { ...input.canary.preRunZeroBaseline },
    manualDestroyReceipts,
  };
  await store.recordSignals({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    costSignals: [
      {
        kind: 'workspace-host-canary-cost-evidence-v1',
        runId: input.canary.runId,
        budgetEvidenceRef: input.canary.budgetEvidenceRef,
        preRunZeroBaseline: input.canary.preRunZeroBaseline,
        cumulative: input.canary.costEvidence,
        lateObservedSpend: input.canary.lateObservedSpend ?? [],
        completion: completionReceipt,
      },
    ],
  });
  return result;
}

/**
 * Production discard teardown through the same replay-safe controller and host-scoped DBOS mutex
 * as provisioning. No caller may report success from accepted delete requests alone: every owned
 * resource needs a matching provider-read receipt and an independent all-kind inventory must be
 * clean before the host becomes absent.
 */
export async function runWorkspaceHostDestroy(
  input: RunWorkspaceHostDestroyInput,
): Promise<WorkspaceHostDestroyResult> {
  const store = input.store ?? DEFAULT_DESTROY_STORE;
  const workspaceId = nonEmpty(input.workspaceId, 'workspaceId');
  const hostId = nonEmpty(input.hostId, 'hostId');
  const operationId = nonEmpty(input.operationId ?? randomUUID(), 'operationId');
  if (input.disposition !== 'discard') {
    throw new WorkspaceHostProvisioningRequestError([
      'production destroy currently permits disposition=discard only; snapshot and backup teardown are not complete',
    ]);
  }
  if (input.confirmation.expectedHostId !== hostId) {
    throw new WorkspaceHostProvisioningRequestError(['destroy confirmation expectedHostId must match hostId']);
  }
  nonEmpty(input.confirmation.confirmedBy, 'destroy confirmation confirmedBy');
  isoTimestamp(input.confirmation.confirmedAt, 'destroy confirmation confirmedAt');
  validateDestroyCanaryEvidence(input.canary, workspaceId);

  const target = await store.readTarget(workspaceId, hostId);
  if (!target) throw new WorkspaceHostProvisioningRequestError([`workspace host '${hostId}' was not found`]);
  if (target.id !== hostId || target.desired.hostId !== hostId) {
    throw new WorkspaceHostProvisioningRequestError(['stored workspace-host identity does not match destroy hostId']);
  }
  if (target.target !== 'gcp' || target.desired.target !== 'gcp' || input.provider.target !== 'gcp') {
    throw new WorkspaceHostProvisioningRequestError(['production discard destroy is implemented for GCP only']);
  }
  if (input.connection.target !== target.target) {
    throw new WorkspaceHostProvisioningRequestError(['workspace-host connection target does not match stored host']);
  }
  assertDestroyCanaryLabels(target.desired, input.canary);

  const context: WorkspaceHostProviderContext = {
    workspaceId,
    requestId: operationId,
    connection: { ...input.connection, scope: target.desired.scope },
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  let validation;
  try {
    validation = await input.provider.validateConnection(context);
  } catch {
    throw new WorkspaceHostProvisioningConnectionError(['provider connection validation failed']);
  }
  if (!validation.ok) {
    throw new WorkspaceHostProvisioningConnectionError(
      validation.errors.length > 0 ? validation.errors : ['provider connection is not usable'],
    );
  }

  const host = {
    hostId,
    target: target.desired.target,
    resources: target.resources.map((entry) => entry.resource),
  } as const;
  let plan: WorkspaceHostPlan;
  try {
    plan = await input.provider.plan(
      {
        action: 'destroy',
        operationId,
        idempotencyKey: `workspace-host:${workspaceId}:${hostId}:${operationId}:destroy`,
        host,
        disposition: 'discard',
        confirmation: input.confirmation,
      },
      context,
    );
  } catch (error) {
    throw new WorkspaceHostProvisioningRequestError([message(error)]);
  }
  const identityProblems: string[] = [];
  if (plan.operationId !== operationId) identityProblems.push('provider destroy plan changed operationId');
  if (plan.hostId !== hostId) identityProblems.push('provider destroy plan changed hostId');
  if (plan.target !== target.desired.target) identityProblems.push('provider destroy plan changed target');
  if (identityProblems.length > 0) throw new WorkspaceHostProvisioningRequestError(identityProblems);

  const workflow = durableDestroyWorkflow(input, operationId, plan, target);
  let checkpoints = await store.readCheckpoints(workspaceId, hostId, operationId);
  if (checkpoints.length === 0) {
    await store.updateHostState({ workspaceId, hostId, state: 'destroying' });
  }
  await store.beginOperation({
    workspaceId,
    operationId,
    hostId,
    action: 'destroy',
    status: 'running',
    message: 'Workspace-host discard teardown started',
    request: {
      disposition: 'discard',
      confirmation: input.confirmation,
      canary: input.canary,
    },
  });

  for (let transition = 0; transition < MAX_CONTROLLER_TRANSITIONS_PER_REQUEST; transition += 1) {
    const action = nextWorkspaceHostControllerAction(workflow, checkpoints);
    if (action.kind === 'record-plan') {
      for (const resource of action.resources) {
        const checkpoint: WorkspaceHostResourceCheckpoint = {
          logicalKey: resource.logicalKey,
          state: 'planned',
          attempts: 0,
          providerResource: destroyResourceForStep(
            resource.step,
            target.resources.map((entry) => entry.resource),
          ),
        };
        await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint });
        checkpoints = replaceCheckpoint(checkpoints, checkpoint);
      }
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: 'plan',
        status: 'running',
        message: `Recorded ${action.resources.length} discard resource plan(s) before mutation`,
      });
      continue;
    }

    if (action.kind === 'apply' || action.kind === 'retry' || action.kind === 'reconcile') {
      const prior = checkpoints.find((entry) => entry.logicalKey === action.resource.logicalKey);
      if (!prior) throw new Error(`Missing destroy checkpoint '${action.resource.logicalKey}'`);
      const attempts = prior.attempts + 1;
      const beforeCall: WorkspaceHostResourceCheckpoint = {
        logicalKey: prior.logicalKey,
        state: action.kind === 'reconcile' ? 'reconciling' : 'applying',
        attempts,
        ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
        ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
      };
      await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: beforeCall });
      checkpoints = replaceCheckpoint(checkpoints, beforeCall);
      const applyRequest = {
        planId: plan.planId,
        operationId,
        step: action.resource.step,
        knownResources: knownResources(checkpoints),
      };
      let providerResult: WorkspaceHostApplyResult;
      try {
        providerResult =
          action.kind === 'reconcile'
            ? await input.provider.reconcile(
                {
                  ...applyRequest,
                  reason: 'resume',
                  ...(prior.providerRequestId ? { previousProviderRequestId: prior.providerRequestId } : {}),
                },
                context,
              )
            : await input.provider.apply(applyRequest, context);
      } catch (error) {
        const failed: WorkspaceHostResourceCheckpoint = {
          logicalKey: prior.logicalKey,
          state: 'failed',
          attempts,
          retryClass: 'ambiguous',
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
          ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
          ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
          error: message(error),
        };
        await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: failed });
        checkpoints = replaceCheckpoint(checkpoints, failed);
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'running',
          percent: destroyProgress(checkpoints, plan.steps.length),
          message: `Destroy outcome for '${prior.logicalKey}' is uncertain; reconciliation required`,
        });
        await store.appendEvent({
          workspaceId,
          hostId,
          operationId,
          phase: prior.logicalKey,
          status: 'running',
          level: 'warn',
          message: 'Destroy outcome is uncertain; the next request will reconcile before deleting',
          details: { error: message(error) },
        });
        return { status: 'in-progress', operationId, hostId, plan, checkpoints, retryAfterMs: DEFAULT_RETRY_AFTER_MS };
      }

      const afterCall = resultCheckpoint(prior, attempts, providerResult);
      await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: afterCall });
      checkpoints = replaceCheckpoint(checkpoints, afterCall);
      const waiting = providerResult.state === 'in-progress';
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: destroyProgress(checkpoints, plan.steps.length),
        message: waiting
          ? `Provider delete '${prior.logicalKey}' is still in progress`
          : `Provider delete '${prior.logicalKey}' confirmed ${providerResult.state}`,
      });
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: prior.logicalKey,
        status: 'running',
        message: waiting ? 'Provider delete is still in progress' : `Provider delete ${providerResult.state}`,
        details: {
          state: providerResult.state,
          ...(providerResult.state === 'destroyed' ? { confirmation: providerResult.confirmation } : {}),
        },
      });
      if (providerResult.state === 'in-progress') {
        return {
          status: 'in-progress',
          operationId,
          hostId,
          plan,
          checkpoints,
          retryAfterMs: providerResult.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        };
      }
      continue;
    }

    if (action.kind === 'complete' && action.status === 'succeeded') {
      try {
        const evidence = await finalizeDestroyEvidence(input, store, target, workflow, checkpoints);
        const completedAt = evidence.completionReceipt.completedAt;
        await store.updateHostState({ workspaceId, hostId, state: 'absent', observedAt: completedAt, discard: true });
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'succeeded',
          percent: 100,
          message: 'Workspace-host discard teardown and evidence census completed',
        });
        await store.appendEvent({
          workspaceId,
          hostId,
          operationId,
          phase: 'destroy-evidence',
          status: 'succeeded',
          message: 'Every registered resource is absent and the provider census is clean',
          details: evidence,
        });
        return { status: 'succeeded', operationId, hostId, plan, checkpoints, evidence };
      } catch (error) {
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'failed',
          percent: 99,
          message: 'Workspace-host resources were deleted, but terminal evidence is incomplete',
          error: { reason: message(error) },
        });
        await store.appendEvent({
          workspaceId,
          hostId,
          operationId,
          phase: 'destroy-evidence',
          status: 'failed',
          level: 'error',
          message: 'Destroy cannot complete without provider-read receipts, cost evidence, and a clean census',
          details: { error: message(error) },
        });
        return { status: 'failed', operationId, hostId, plan, checkpoints };
      }
    }

    const reason = action.kind === 'blocked' ? action.reason : action.kind === 'complete' ? action.status : action.kind;
    await store.updateOperation({
      workspaceId,
      operationId,
      status: 'failed',
      percent: destroyProgress(checkpoints, plan.steps.length),
      message: 'Workspace-host destroy controller is blocked',
      error: { reason },
    });
    return { status: 'failed', operationId, hostId, plan, checkpoints };
  }

  throw new Error('Workspace-host destroy exceeded its bounded controller transition budget');
}
