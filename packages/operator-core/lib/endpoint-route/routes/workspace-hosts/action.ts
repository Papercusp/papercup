/** POST /workspace-hosts/action — durable lifecycle admission used by the cloud-workspaces UI. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  startWorkspaceHostDestroyWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostDestroyInput,
} from '../../../dbos/workspace-host-provision-workflow';
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
  type WorkspaceHostDestroyCanaryEvidence,
} from '../../../workspace-host/provisioning-runner';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

interface WorkspaceHostActionBody {
  action?: unknown;
  workspaceId?: unknown;
  disposition?: unknown;
  operationId?: unknown;
  confirmation?: unknown;
  canary?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface WorkspaceHostActionRouteDependencies {
  activeWorkspaceId: () => string;
  provisioningAvailable: () => boolean;
  readTarget: (workspaceId: string, hostId: string) => Promise<StoredWorkspaceHostDestroyTarget | null>;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  startDestroy: (input: StartWorkspaceHostDestroyInput) => ReturnType<typeof startWorkspaceHostDestroyWorkflow>;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostActionRouteDependencies = {
  activeWorkspaceId,
  provisioningAvailable: dbosStarted,
  readTarget: readWorkspaceHostDestroyTarget,
  readConnection: readWorkspaceHostConnection,
  startDestroy: startWorkspaceHostDestroyWorkflow,
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
      if (body.action !== 'destroy') {
        return requestError('workspace-host lifecycle action is not implemented', 501, {
          action: typeof body.action === 'string' ? body.action : null,
        });
      }

      const hostId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
      if (!SAFE_ID.test(hostId)) return requestError('invalid workspaceId');
      if (body.disposition !== 'discard') {
        return requestError('production destroy currently requires disposition=discard', 422);
      }
      if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return requestError('invalid operationId');
      }
      if (!isRecord(body.confirmation)) return requestError('destroy confirmation is required');
      const expectedHostId =
        typeof body.confirmation.expectedHostId === 'string' ? body.confirmation.expectedHostId.trim() : '';
      const confirmedBy = typeof body.confirmation.confirmedBy === 'string' ? body.confirmation.confirmedBy.trim() : '';
      const confirmedAt = typeof body.confirmation.confirmedAt === 'string' ? body.confirmation.confirmedAt.trim() : '';
      if (expectedHostId !== hostId || !confirmedBy || !Number.isFinite(Date.parse(confirmedAt))) {
        return requestError('destroy confirmation must name this host, an actor, and an ISO timestamp');
      }
      if (!isRecord(body.canary)) return requestError('destroy canary evidence is required');
      if (!dependencies.provisioningAvailable()) {
        return requestError('workspace-host provisioning workflow is unavailable on this operator', 503);
      }

      const workspaceId = dependencies.activeWorkspaceId();
      const target = await dependencies.readTarget(workspaceId, hostId);
      if (!target) return requestError('workspace host not found', 404);
      const stored = await dependencies.readConnection(workspaceId, target.connectionId);
      if (!stored) return requestError('workspace-host connection not found', 404);
      if (stored.status !== 'connected') {
        return requestError('workspace-host connection is not ready', 409, {
          status: stored.status,
          ...(stored.statusDetail ? { detail: stored.statusDetail } : {}),
        });
      }
      if (stored.target !== target.target || target.target !== 'gcp') {
        return requestError('workspace-host destroy target is not implemented', 501, { target: target.target });
      }

      try {
        const result = await dependencies.startDestroy({
          workspaceId,
          hostId,
          connectionId: target.connectionId,
          connection: { ...stored.connection, scope: target.desired.scope },
          disposition: 'discard',
          confirmation: { expectedHostId, confirmedBy, confirmedAt },
          canary: body.canary as unknown as WorkspaceHostDestroyCanaryEvidence,
          ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
          actorId: confirmedBy,
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
          ...(result.evidence ? { evidence: result.evidence } : {}),
          message:
            result.status === 'succeeded'
              ? 'Workspace-host discard teardown completed with terminal evidence'
              : result.status === 'in-progress'
                ? 'Workspace-host discard teardown is in progress'
                : 'Workspace-host discard teardown failed; see the host timeline for details',
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
        if (error instanceof WorkspaceHostProvisioningRequestError) {
          return requestError('workspace-host destroy request rejected', 422, { problems: error.problems });
        }
        return requestError('workspace-host destroy failed; see the host timeline for details', 500);
      }
    },
  });
}

export default createWorkspaceHostActionRoute();
