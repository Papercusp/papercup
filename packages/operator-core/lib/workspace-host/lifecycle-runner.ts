/** Replay-safe production controller for an already-provisioned workspace host. */
import { randomUUID } from 'node:crypto';
import {
  nextWorkspaceHostControllerAction,
  workspaceHostActionInvalidatesInitialization,
  workspaceHostProviderRetryClass,
  type WorkspaceHostApplyResult,
  type WorkspaceHostImageRef,
  type WorkspaceHostObservation,
  type WorkspaceHostPlan,
  type WorkspaceHostPlanRequest,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostProviderContext,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
  type WorkspaceHostSnapshotRef,
} from '@papercusp/deployment-driver';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  readWorkspaceHostDestroyTarget,
  readWorkspaceHostResourceCheckpoints,
  recordWorkspaceHostObservation,
  updateWorkspaceHostOperation,
  upsertWorkspaceHostResourceCheckpoint,
  type StoredWorkspaceHostDestroyTarget,
} from './observability-store';
import {
  assertProviderConnectionUsable,
  WorkspaceHostProvisioningRequestError,
  type WorkspaceHostProvisioningResult,
} from './provisioning-runner';

const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_CONTROLLER_TRANSITIONS_PER_REQUEST = 256;

export type WorkspaceHostExistingLifecycleAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'repair'
  | 'snapshot'
  | 'upgrade'
  | 'restore';

export interface RunWorkspaceHostLifecycleInput {
  workspaceId: string;
  hostId: string;
  connection: WorkspaceHostProviderConnection;
  provider: WorkspaceHostProvider;
  action: WorkspaceHostExistingLifecycleAction;
  name?: string;
  image?: WorkspaceHostImageRef;
  rollbackImage?: WorkspaceHostImageRef;
  snapshot?: WorkspaceHostSnapshotRef;
  desired?: StoredWorkspaceHostDestroyTarget['desired'];
  operationId?: string;
  actorId?: string;
  signal?: AbortSignal;
  store?: WorkspaceHostLifecycleStore;
}

export interface WorkspaceHostLifecycleStore {
  readTarget: typeof readWorkspaceHostDestroyTarget;
  beginOperation: typeof beginWorkspaceHostOperation;
  updateOperation: typeof updateWorkspaceHostOperation;
  readCheckpoints: typeof readWorkspaceHostResourceCheckpoints;
  upsertCheckpoint: typeof upsertWorkspaceHostResourceCheckpoint;
  appendEvent: typeof appendWorkspaceHostEvent;
  recordObservation: typeof recordWorkspaceHostObservation;
}

const DEFAULT_STORE: WorkspaceHostLifecycleStore = {
  readTarget: readWorkspaceHostDestroyTarget,
  beginOperation: beginWorkspaceHostOperation,
  updateOperation: updateWorkspaceHostOperation,
  readCheckpoints: readWorkspaceHostResourceCheckpoints,
  upsertCheckpoint: upsertWorkspaceHostResourceCheckpoint,
  appendEvent: appendWorkspaceHostEvent,
  recordObservation: recordWorkspaceHostObservation,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkspaceHostProvisioningRequestError([`${label} must not be empty`]);
  return trimmed;
}

function replaceCheckpoint(
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  checkpoint: WorkspaceHostResourceCheckpoint,
): WorkspaceHostResourceCheckpoint[] {
  return [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), checkpoint].sort((a, b) =>
    a.logicalKey.localeCompare(b.logicalKey),
  );
}

function knownResources(
  target: StoredWorkspaceHostDestroyTarget,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): WorkspaceHostResourceRef[] {
  const byIdentity = new Map<string, WorkspaceHostResourceRef>();
  for (const resource of target.resources.map((entry) => entry.resource)) {
    byIdentity.set(`${resource.target}:${resource.kind}:${resource.providerId}`, resource);
  }
  for (const checkpoint of checkpoints) {
    const resource = checkpoint.providerResource;
    if (resource && (checkpoint.state === 'applied' || checkpoint.state === 'unchanged')) {
      byIdentity.set(`${resource.target}:${resource.kind}:${resource.providerId}`, resource);
    }
  }
  return [...byIdentity.values()];
}

function progress(checkpoints: readonly WorkspaceHostResourceCheckpoint[], total: number): number {
  if (total === 0) return 100;
  const settled = checkpoints.filter((entry) =>
    ['applied', 'unchanged', 'absent'].includes(entry.state),
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

function planRequest(
  input: RunWorkspaceHostLifecycleInput,
  target: StoredWorkspaceHostDestroyTarget,
  operationId: string,
): WorkspaceHostPlanRequest {
  const base = {
    operationId,
    idempotencyKey: `workspace-host:${input.workspaceId}:${input.hostId}:${operationId}:${input.action}`,
    host: {
      hostId: input.hostId,
      target: target.desired.target,
      resources: target.resources.map((entry) => entry.resource),
    },
  } as const;
  if (input.action === 'snapshot') return { ...base, action: input.action, ...(input.name ? { name: input.name } : {}) };
  if (input.action === 'upgrade') {
    if (!input.image) throw new WorkspaceHostProvisioningRequestError(['upgrade image is required']);
    return {
      ...base,
      action: input.action,
      image: input.image,
      ...(input.rollbackImage ? { rollbackImage: input.rollbackImage } : {}),
    };
  }
  if (input.action === 'restore') {
    if (!input.snapshot) throw new WorkspaceHostProvisioningRequestError(['restore snapshot is required']);
    if (!input.desired) throw new WorkspaceHostProvisioningRequestError(['restore desired host spec is required']);
    if (input.desired.hostId === input.hostId) {
      throw new WorkspaceHostProvisioningRequestError(['restore must target a distinct desired.hostId']);
    }
    return { ...base, action: input.action, snapshot: input.snapshot, desired: input.desired };
  }
  return { ...base, action: input.action };
}

function matchingExistingResource(
  target: StoredWorkspaceHostDestroyTarget,
  step: WorkspaceHostPlan['steps'][number],
): WorkspaceHostResourceRef | undefined {
  const providerId = [step.input.instanceName, step.input.resourceName]
    .find((value): value is string => typeof value === 'string');
  return target.resources
    .map((entry) => entry.resource)
    .find((resource) => resource.kind === step.resourceKind && (!providerId || resource.providerId === providerId));
}

async function observe(
  input: RunWorkspaceHostLifecycleInput,
  target: StoredWorkspaceHostDestroyTarget,
  store: WorkspaceHostLifecycleStore,
  context: WorkspaceHostProviderContext,
): Promise<WorkspaceHostObservation | undefined> {
  try {
    const observation = await input.provider.observe(
      {
        hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
        target: target.desired.target,
        resources: target.resources.map((entry) => entry.resource),
      },
      context,
    );
    await store.recordObservation(input.workspaceId, observation);
    return observation;
  } catch (error) {
    await store.appendEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId: context.requestId,
      phase: 'observe',
      status: 'running',
      level: 'warn',
      message: `Provider lifecycle mutation completed, but observation is pending: ${message(error)}`,
    });
    return undefined;
  }
}

export async function runWorkspaceHostLifecycle(
  input: RunWorkspaceHostLifecycleInput,
): Promise<WorkspaceHostProvisioningResult> {
  const store = input.store ?? DEFAULT_STORE;
  const workspaceId = nonEmpty(input.workspaceId, 'workspaceId');
  const hostId = nonEmpty(input.hostId, 'hostId');
  const operationId = nonEmpty(input.operationId ?? randomUUID(), 'operationId');
  const target = await store.readTarget(workspaceId, hostId);
  if (!target) throw new WorkspaceHostProvisioningRequestError([`workspace host '${hostId}' was not found`]);
  if (target.observedState === 'absent') {
    throw new WorkspaceHostProvisioningRequestError(['workspace host is absent']);
  }
  if (target.resources.length === 0) {
    throw new WorkspaceHostProvisioningRequestError(['workspace host has no registered provider resource population']);
  }
  if (target.id !== hostId || target.desired.hostId !== hostId) {
    throw new WorkspaceHostProvisioningRequestError(['stored workspace-host identity does not match hostId']);
  }
  if (input.connection.target !== target.target || input.provider.target !== target.target) {
    throw new WorkspaceHostProvisioningRequestError(['workspace-host provider and connection must match stored target']);
  }

  const context: WorkspaceHostProviderContext = {
    workspaceId,
    requestId: operationId,
    connection: { ...input.connection, scope: target.desired.scope },
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  await assertProviderConnectionUsable(input.provider, context);

  let plan: WorkspaceHostPlan;
  try {
    plan = await input.provider.plan(planRequest(input, target, operationId), context);
  } catch (error) {
    if (error instanceof WorkspaceHostProvisioningRequestError) throw error;
    throw new WorkspaceHostProvisioningRequestError([message(error)]);
  }
  const resultHostId = input.action === 'restore' ? input.desired!.hostId : hostId;
  const identityProblems: string[] = [];
  if (plan.operationId !== operationId) identityProblems.push('provider lifecycle plan changed operationId');
  if (plan.hostId !== resultHostId) identityProblems.push('provider lifecycle plan changed hostId');
  if (plan.target !== target.target) identityProblems.push('provider lifecycle plan changed target');
  if (identityProblems.length > 0) throw new WorkspaceHostProvisioningRequestError(identityProblems);

  const workflow = {
    identity: {
      workspaceId,
      hostId: resultHostId,
      operationId,
      planId: plan.planId,
      target: plan.target,
      desiredGeneration: 1,
    },
    action: input.action,
    resources: plan.steps.map((step) => ({
      logicalKey: step.id,
      step,
      createdByOperation: input.action === 'snapshot' || input.action === 'restore',
      deleteOnDestroy: input.action === 'snapshot' || input.action === 'restore',
      retainOnCancel: true,
    })),
    maxApplyAttempts: 3,
  } as const;
  let checkpoints = await store.readCheckpoints(workspaceId, resultHostId, operationId);
  await store.beginOperation({
    workspaceId,
    operationId,
    hostId: resultHostId,
    action: input.action,
    status: 'running',
    message: `Workspace-host ${input.action} started`,
    request: { sourceHostId: hostId, ...(input.name ? { name: input.name } : {}) },
  });

  for (let transition = 0; transition < MAX_CONTROLLER_TRANSITIONS_PER_REQUEST; transition += 1) {
    const action = nextWorkspaceHostControllerAction(workflow, checkpoints);
    if (action.kind === 'record-plan') {
      for (const resource of action.resources) {
        const existing = matchingExistingResource(target, resource.step);
        const checkpoint: WorkspaceHostResourceCheckpoint = {
          logicalKey: resource.logicalKey,
          state: 'planned',
          attempts: 0,
          ...(existing ? { providerResource: existing } : {}),
        };
        await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint });
        checkpoints = replaceCheckpoint(checkpoints, checkpoint);
      }
      await store.appendEvent({
        workspaceId,
        hostId: resultHostId,
        operationId,
        phase: 'plan',
        status: 'running',
        message: `Recorded ${action.resources.length} ${input.action} step(s) before mutation`,
      });
      continue;
    }

    if (action.kind === 'apply' || action.kind === 'retry' || action.kind === 'reconcile') {
      const prior = checkpoints.find((entry) => entry.logicalKey === action.resource.logicalKey);
      if (!prior) throw new Error(`Missing lifecycle checkpoint '${action.resource.logicalKey}'`);
      const attempts = prior.attempts + 1;
      const beforeCall: WorkspaceHostResourceCheckpoint = {
        logicalKey: prior.logicalKey,
        state: action.kind === 'reconcile' ? 'reconciling' : 'applying',
        attempts,
        ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
        ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
      };
      await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: beforeCall });
      checkpoints = replaceCheckpoint(checkpoints, beforeCall);
      const applyRequest = {
        planId: plan.planId,
        operationId,
        step: action.resource.step,
        knownResources: knownResources(target, checkpoints),
      };
      let providerResult: WorkspaceHostApplyResult;
      try {
        providerResult = action.kind === 'reconcile'
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
        // Classify the refusal; do not assume it is uncertain. A deterministic 4xx (an expired
        // credential, a quota denial, a retired image) will be refused identically forever, and
        // `ambiguous` is exempt from the attempt ceiling in workspaceHostRecoveryAction — so
        // recording every failure as ambiguous turned a hard failure into a permanent hang that
        // reconciled on every resume and never reached a terminal verdict. This is the same
        // defect WI-1743793 fixed in the provisioning runner; both now share one classifier.
        const retryClass = workspaceHostProviderRetryClass(error);
        const failed: WorkspaceHostResourceCheckpoint = {
          logicalKey: prior.logicalKey,
          state: 'failed',
          attempts,
          retryClass,
          ...(retryClass === 'terminal' ? {} : { retryAfterMs: DEFAULT_RETRY_AFTER_MS }),
          ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
          ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
          error: message(error),
        };
        await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: failed });
        checkpoints = replaceCheckpoint(checkpoints, failed);
        if (retryClass === 'terminal') {
          await store.updateOperation({
            workspaceId,
            operationId,
            status: 'failed',
            percent: progress(checkpoints, plan.steps.length),
            message: `Provider rejected step '${prior.logicalKey}'`,
            error: { reason: message(error) },
          });
          await store.appendEvent({
            workspaceId,
            hostId: resultHostId,
            operationId,
            phase: prior.logicalKey,
            status: 'failed',
            level: 'error',
            message: 'Provider rejected the request; retrying it unchanged cannot succeed',
            details: { error: message(error) },
          });
          return { status: 'failed', operationId, hostId: resultHostId, plan, checkpoints };
        }
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'running',
          percent: progress(checkpoints, plan.steps.length),
          message: `Provider outcome for '${prior.logicalKey}' is uncertain; reconciliation required`,
        });
        return { status: 'in-progress', operationId, hostId: resultHostId, plan, checkpoints, retryAfterMs: DEFAULT_RETRY_AFTER_MS };
      }

      const afterCall = resultCheckpoint(prior, attempts, providerResult);
      await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: afterCall });
      checkpoints = replaceCheckpoint(checkpoints, afterCall);
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: progress(checkpoints, plan.steps.length),
        message: providerResult.state === 'in-progress'
          ? `Provider ${input.action} step '${prior.logicalKey}' is still in progress`
          : `Provider ${input.action} step '${prior.logicalKey}' ${providerResult.state}`,
      });
      if (providerResult.state === 'in-progress') {
        return {
          status: 'in-progress',
          operationId,
          hostId: resultHostId,
          plan,
          checkpoints,
          retryAfterMs: providerResult.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        };
      }
      continue;
    }

    if (action.kind === 'complete' && action.status === 'succeeded') {
      await observe(input, target, store, context);
      /*
       * This branch is generic across every lifecycle action, so on its own it can only ever
       * describe the PROVIDER mutation — never whether the host can serve. For most actions
       * those coincide. For a boot-disk-replacing action they do not: `upgrade` recreates the
       * instance from the new image and `restore` builds a distinct host, so everything the
       * initialization leg installed is gone, and initialization is a SEPARATE operation the
       * caller must sequence. Saying only "completed" there is what let a ledger row read
       * succeeded|100 while the host was still minutes away from serving.
       *
       * Say it instead of probing for it: a readiness gate here would have to ask the provider,
       * and `attestHealth` cannot answer (GCP attests `unknown` — `agentOnline` has no producer),
       * so gating would replace a premature success with a permanent hang.
       */
      const requiresInitialization = workspaceHostActionInvalidatesInitialization(input.action);
      const message = requiresInitialization
        ? `Workspace-host ${input.action} completed its provider steps, but the host CANNOT SERVE yet: ` +
          `${input.action} replaced the boot disk, so initialization must be run again before use`
        : `Workspace-host ${input.action} completed`;
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'succeeded',
        percent: 100,
        message,
      });
      await store.appendEvent({
        workspaceId,
        hostId: resultHostId,
        operationId,
        phase: 'complete',
        status: 'succeeded',
        message,
      });
      return { status: 'succeeded', operationId, hostId: resultHostId, plan, checkpoints, requiresInitialization };
    }

    const reason = action.kind === 'blocked' ? action.reason : action.kind === 'complete' ? action.status : action.kind;
    await store.updateOperation({
      workspaceId,
      operationId,
      status: 'failed',
      percent: progress(checkpoints, plan.steps.length),
      message: `Workspace-host ${input.action} controller is blocked`,
      error: { reason },
    });
    return { status: 'failed', operationId, hostId: resultHostId, plan, checkpoints };
  }

  throw new Error(`Workspace-host ${input.action} exceeded its bounded controller transition budget`);
}
