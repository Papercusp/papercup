/** POST /workspace-hosts/action — durable lifecycle admission used by the cloud-workspaces UI. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  startWorkspaceHostDestroyWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
} from '../../../dbos/workspace-host-provision-workflow';
import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostImageRef,
  WorkspaceHostSnapshotRef,
} from '@papercusp/deployment-driver';
import { dbosStarted } from '../../../dbos/bootstrap';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  readWorkspaceHostConnection,
  readWorkspaceHostDestroyTarget,
  type StoredWorkspaceHostConnection,
  type StoredWorkspaceHostDestroyTarget,
} from '../../../workspace-host/observability-store';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  WorkspaceHostProvisioningTransientError,
  type WorkspaceHostDestroyCanaryEvidence,
} from '../../../workspace-host/provisioning-runner';
import {
  defaultWorkspaceHostRequestForwarder,
  type WorkspaceHostRequestForwarder,
} from '../../../workspace-host/controller-forwarding';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

interface WorkspaceHostActionBody {
  action?: unknown;
  workspaceId?: unknown;
  disposition?: unknown;
  operationId?: unknown;
  confirmation?: unknown;
  canary?: unknown;
  name?: unknown;
  image?: unknown;
  rollbackImage?: unknown;
  snapshot?: unknown;
  desired?: unknown;
}

const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart', 'repair', 'snapshot', 'upgrade', 'restore'] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
const DESTROY_DISPOSITIONS = ['snapshot', 'backup', 'discard'] as const;
type DestroyDisposition = (typeof DESTROY_DISPOSITIONS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isCostEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.cents === 'number' &&
    typeof value.observedAt === 'string' &&
    typeof value.providerEvidenceRef === 'string' &&
    (value.reservationId === undefined || typeof value.reservationId === 'string')
  );
}

/**
 * A teardown after a FAILED canary run. It carries the audit context in place of the economic
 * evidence such a run can never produce; it waives nothing about identity.
 */
function isFailedRunTeardown(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.actorId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.procedureRef === 'string' &&
    Array.isArray(value.failedOperationIds) &&
    value.failedOperationIds.length > 0 &&
    value.failedOperationIds.every((entry) => typeof entry === 'string')
  );
}

/**
 * The spend has not settled with the provider yet (D-274). Orthogonal to authorization: it answers
 * "is the cost knowable at teardown time", which for a short-lived canary is normally NO.
 */
function isSpendSettlement(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.status === 'deferred' &&
    typeof value.actorId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.procedureRef === 'string' &&
    typeof value.reconcileAfter === 'string' &&
    Number.isFinite(Date.parse(value.reconcileAfter))
  );
}

function parseCanaryEvidence(value: unknown): WorkspaceHostDestroyCanaryEvidence | null {
  if (!isRecord(value) || !isCostEvidence(value.preRunZeroBaseline)) return null;
  if (!Array.isArray(value.costEvidence) || !value.costEvidence.every(isCostEvidence)) return null;
  if (
    value.lateObservedSpend !== undefined &&
    (!Array.isArray(value.lateObservedSpend) || !value.lateObservedSpend.every(isCostEvidence))
  ) {
    return null;
  }
  if (
    value.emergencyManualDestroy !== undefined &&
    (!isRecord(value.emergencyManualDestroy) ||
      typeof value.emergencyManualDestroy.actorId !== 'string' ||
      typeof value.emergencyManualDestroy.reason !== 'string' ||
      typeof value.emergencyManualDestroy.procedureRef !== 'string')
  ) {
    return null;
  }
  if (value.failedRunTeardown !== undefined && !isFailedRunTeardown(value.failedRunTeardown)) return null;
  if (value.spendSettlement !== undefined && !isSpendSettlement(value.spendSettlement)) return null;
  if (value.failedRunTeardown !== undefined) {
    // The two authorizations are mutually exclusive: a request may not present an approved contract
    // report AND claim the run failed. Accepting both would make the audit record ambiguous about
    // which evidence the destroy was actually admitted on.
    if (value.contractApproval !== undefined) return null;
  } else if (
    !isRecord(value.contractApproval) ||
    value.contractApproval.status !== 'approved' ||
    typeof value.contractApproval.suiteVersion !== 'string' ||
    typeof value.contractApproval.reportRef !== 'string' ||
    typeof value.contractApproval.approvedBy !== 'string' ||
    typeof value.contractApproval.approvedAt !== 'string'
  ) {
    return null;
  }
  if (
    typeof value.runId !== 'string' ||
    typeof value.workspaceId !== 'string' ||
    typeof value.teardownDeadlineAt !== 'string' ||
    typeof value.budgetEvidenceRef !== 'string' ||
    (value.maxSpendCents !== undefined && typeof value.maxSpendCents !== 'number')
  ) {
    return null;
  }
  return value as unknown as WorkspaceHostDestroyCanaryEvidence;
}

export interface WorkspaceHostActionRouteDependencies {
  activeWorkspaceId: () => string;
  provisioningAvailable: () => boolean;
  readTarget: (workspaceId: string, hostId: string) => Promise<StoredWorkspaceHostDestroyTarget | null>;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  startDestroy: (input: StartWorkspaceHostDestroyInput) => ReturnType<typeof startWorkspaceHostDestroyWorkflow>;
  startLifecycle: (input: StartWorkspaceHostLifecycleInput) => ReturnType<typeof startWorkspaceHostLifecycleWorkflow>;
  forwardRequest?: WorkspaceHostRequestForwarder;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostActionRouteDependencies = {
  activeWorkspaceId,
  provisioningAvailable: dbosStarted,
  readTarget: readWorkspaceHostDestroyTarget,
  readConnection: readWorkspaceHostConnection,
  startDestroy: startWorkspaceHostDestroyWorkflow,
  startLifecycle: startWorkspaceHostLifecycleWorkflow,
};

function requestError(error: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, message: error, ...extra }, { status });
}

export function createWorkspaceHostActionRoute(
  dependencies: WorkspaceHostActionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/action',
    auth: 'loopback',
    async handler(req) {
      let body: WorkspaceHostActionBody;
      try {
        body = (await req.json()) as WorkspaceHostActionBody;
      } catch {
        return requestError('invalid json');
      }
      if (!isRecord(body)) return requestError('body must be an object');
      const action = typeof body.action === 'string' ? body.action : '';
      if (action !== 'destroy' && !LIFECYCLE_ACTIONS.includes(action as LifecycleAction)) {
        return requestError('workspace-host lifecycle action is not implemented', 501, {
          action: action || null,
        });
      }

      const hostId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
      if (!SAFE_ID.test(hostId)) return requestError('invalid workspaceId');
      if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return requestError('invalid operationId');
      }
      let destroyAdmission:
        | {
            disposition: DestroyDisposition;
            expectedHostId: string;
            confirmedBy: string;
            confirmedAt: string;
            canary?: WorkspaceHostDestroyCanaryEvidence;
          }
        | undefined;
      if (action === 'destroy') {
        if (!DESTROY_DISPOSITIONS.includes(body.disposition as DestroyDisposition)) {
          return requestError('destroy disposition must be snapshot, backup, or discard', 422);
        }
        if (!isRecord(body.confirmation)) return requestError('destroy confirmation is required');
        const expectedHostId =
          typeof body.confirmation.expectedHostId === 'string' ? body.confirmation.expectedHostId.trim() : '';
        const confirmedBy = typeof body.confirmation.confirmedBy === 'string' ? body.confirmation.confirmedBy.trim() : '';
        const confirmedAt = typeof body.confirmation.confirmedAt === 'string' ? body.confirmation.confirmedAt.trim() : '';
        if (expectedHostId !== hostId || !confirmedBy || !Number.isFinite(Date.parse(confirmedAt))) {
          return requestError('destroy confirmation must name this host, an actor, and an ISO timestamp');
        }
        const canary = body.canary === undefined ? undefined : parseCanaryEvidence(body.canary);
        if (body.canary !== undefined && !canary) return requestError('destroy canary evidence is malformed');
        destroyAdmission = {
          disposition: body.disposition as DestroyDisposition,
          expectedHostId,
          confirmedBy,
          confirmedAt,
          ...(canary ? { canary } : {}),
        };
      }
      if (!dependencies.provisioningAvailable()) {
        try {
          const forwarded = await (dependencies.forwardRequest ?? defaultWorkspaceHostRequestForwarder)(
            '/api/workspace-hosts/action',
            body,
          );
          if (forwarded) return forwarded;
        } catch {
          // A controller transport failure is reported through the same typed 503
          // admission response as an undiscovered controller.
        }
        return requestError('workspace-host provisioning workflow is unavailable on this operator', 503);
      }

      const workspaceId = dependencies.activeWorkspaceId();
      const target = await dependencies.readTarget(workspaceId, hostId);
      if (!target) return requestError('workspace host not found', 404);
      const stored = await dependencies.readConnection(workspaceId, target.connectionId);
      if (!stored) return requestError('workspace-host connection not found', 404);
      // 'degraded' means the LAST INSPECTION could not reach the provider, not that the connection
      // is bad — and the runner re-validates it live before it mutates anything, so that fresh read
      // is the authority here. Refusing on a stale cached status would let one transport blip during
      // an unrelated inspection lock every later lifecycle action out (WI-1743793).
      if (stored.status !== 'connected' && stored.status !== 'degraded') {
        return requestError('workspace-host connection is not ready', 409, {
          status: stored.status,
          ...(stored.statusDetail ? { detail: stored.statusDetail } : {}),
        });
      }
      if (stored.target !== target.target || target.target !== 'gcp') {
        return requestError('workspace-host lifecycle target is not implemented', 501, { target: target.target });
      }

      try {
        const common = {
          workspaceId,
          hostId,
          connection: { ...stored.connection, scope: target.desired.scope },
          ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
        };
        const result = action === 'destroy'
          ? await dependencies.startDestroy({
              ...common,
              connectionId: target.connectionId,
              disposition: destroyAdmission!.disposition,
              confirmation: {
                expectedHostId: destroyAdmission!.expectedHostId,
                confirmedBy: destroyAdmission!.confirmedBy,
                confirmedAt: destroyAdmission!.confirmedAt,
              },
              ...(destroyAdmission!.canary ? { canary: destroyAdmission!.canary } : {}),
              actorId: destroyAdmission!.confirmedBy,
            })
          : await dependencies.startLifecycle({
              ...common,
              action: action as LifecycleAction,
              ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
              ...(isRecord(body.image) ? { image: body.image as unknown as WorkspaceHostImageRef } : {}),
              ...(isRecord(body.rollbackImage)
                ? { rollbackImage: body.rollbackImage as unknown as WorkspaceHostImageRef }
                : {}),
              ...(isRecord(body.snapshot) ? { snapshot: body.snapshot as unknown as WorkspaceHostSnapshotRef } : {}),
              ...(isRecord(body.desired) ? { desired: body.desired as unknown as WorkspaceHostDesiredSpec } : {}),
            });
        const response = {
          ok: result.status !== 'failed',
          status: result.status,
          operationId: result.operationId,
          hostId: result.hostId,
          planId: result.plan.planId,
          resources: result.checkpoints.map((checkpoint) => ({
            logicalKey: checkpoint.logicalKey,
            state: checkpoint.state,
            attempts: checkpoint.attempts,
            ...(checkpoint.deletionConfirmation ? { deletionConfirmation: checkpoint.deletionConfirmation } : {}),
          })),
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          ...('evidence' in result && result.evidence ? { evidence: result.evidence } : {}),
          // Read the runner's own verdict rather than re-deriving readiness from `action` here.
          // An initialization-invalidating action succeeds while leaving the host unable to serve
          // until initialization is run again (WI-2143797/WI-2146639). The runner already decided
          // that; a second copy of the rule here is what let the ledger and HTTP response disagree.
          ...(result.requiresInitialization ? { requiresInitialization: true } : {}),
          message: result.status === 'succeeded'
            ? action === 'destroy'
              ? 'Workspace-host discard teardown completed with terminal evidence'
              : result.requiresInitialization
                ? `Workspace-host ${action} completed its provider steps, but the host CANNOT SERVE yet: ` +
                  `${action} invalidated the host's initialized state, so initialization must be run again before use`
                : `Workspace-host ${action} completed`
            : result.status === 'in-progress'
              ? `Workspace-host ${action} is in progress`
              : `Workspace-host ${action} failed; see the host timeline for details`,
        };
        return Response.json(response, {
          status: result.status === 'succeeded' ? 200 : result.status === 'in-progress' ? 202 : 500,
        });
      } catch (error) {
        if (error instanceof WorkspaceHostProvisioningConflictError) {
          return requestError('workspace host already has an operation in progress', 409);
        }
        if (error instanceof WorkspaceHostProvisioningConnectionError) {
          return requestError('workspace-host connection validation failed', 409, { problems: error.problems });
        }
        if (error instanceof WorkspaceHostProvisioningTransientError) {
          // The provider API could not be reached, so the connection was never disproved. 503 (not
          // 409) so the caller retries instead of going to audit a credential that is fine.
          return requestError('workspace-host provider is temporarily unreachable', 503, {
            problems: error.problems,
            retryable: true,
          });
        }
        if (error instanceof WorkspaceHostProvisioningRequestError) {
          return requestError(`workspace-host ${action} request rejected`, 422, { problems: error.problems });
        }
        return requestError(`workspace-host ${action} failed; see the host timeline for details`, 500);
      }
    },
  });
}

export default createWorkspaceHostActionRoute();
