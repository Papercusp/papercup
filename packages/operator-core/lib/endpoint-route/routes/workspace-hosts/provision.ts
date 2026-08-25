/** POST /workspace-hosts/provision — start or resume one durable GCP host provision. */
import { defineTool } from '@papercusp/agent-mcp';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import {
  startWorkspaceHostProvisioningWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostProvisioningInput,
} from '../../../dbos/workspace-host-provision-workflow';
import { dbosStarted } from '../../../dbos/bootstrap';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  readWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
} from '../../../workspace-host/observability-store';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../../../workspace-host/provisioning-runner';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

interface ProvisionBody {
  connectionId?: unknown;
  name?: unknown;
  desired?: unknown;
  operationId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface WorkspaceHostProvisionRouteDependencies {
  activeWorkspaceId: () => string;
  provisioningAvailable: () => boolean;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  startProvisioning: (
    input: StartWorkspaceHostProvisioningInput,
  ) => ReturnType<typeof startWorkspaceHostProvisioningWorkflow>;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostProvisionRouteDependencies = {
  activeWorkspaceId,
  provisioningAvailable: dbosStarted,
  readConnection: readWorkspaceHostConnection,
  startProvisioning: startWorkspaceHostProvisioningWorkflow,
};

export function createWorkspaceHostProvisionRoute(
  dependencies: WorkspaceHostProvisionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/provision',
    auth: 'loopback',
    async handler(req) {
      let body: ProvisionBody;
      try {
        body = (await req.json()) as ProvisionBody;
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      if (!isRecord(body)) return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });

      const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!SAFE_ID.test(connectionId)) {
        return Response.json({ ok: false, error: 'invalid connectionId' }, { status: 400 });
      }
      if (!name || name.length > 160) {
        return Response.json(
          { ok: false, error: 'name must be a non-empty string of at most 160 characters' },
          { status: 400 },
        );
      }
      if (!isRecord(body.desired)) {
        return Response.json({ ok: false, error: 'desired must be an object' }, { status: 400 });
      }
      const desired = body.desired as unknown as WorkspaceHostDesiredSpec;
      if (typeof desired.hostId !== 'string' || !SAFE_ID.test(desired.hostId)) {
        return Response.json({ ok: false, error: 'invalid desired.hostId' }, { status: 400 });
      }
      if (typeof desired.target !== 'string' || !desired.target.trim()) {
        return Response.json({ ok: false, error: 'desired.target must be a non-empty string' }, { status: 400 });
      }
      if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return Response.json({ ok: false, error: 'invalid operationId' }, { status: 400 });
      }
      if (!dependencies.provisioningAvailable()) {
        return Response.json(
          { ok: false, error: 'workspace-host provisioning workflow is unavailable on this operator' },
          { status: 503 },
        );
      }

      const workspaceId = dependencies.activeWorkspaceId();
      const stored = await dependencies.readConnection(workspaceId, connectionId);
      if (!stored) {
        return Response.json({ ok: false, error: 'workspace-host connection not found' }, { status: 404 });
      }
      if (stored.status !== 'connected') {
        return Response.json(
          {
            ok: false,
            error: 'workspace-host connection is not ready',
            status: stored.status,
            ...(stored.statusDetail ? { detail: stored.statusDetail } : {}),
          },
          { status: 409 },
        );
      }
      if (stored.target !== desired.target) {
        return Response.json({ ok: false, error: 'connection target does not match desired.target' }, { status: 422 });
      }
      if (desired.target !== 'gcp') {
        return Response.json(
          { ok: false, error: 'workspace-host provisioning target is not implemented', target: desired.target },
          { status: 501 },
        );
      }

      try {
        const result = await dependencies.startProvisioning({
          workspaceId,
          connectionId,
          name,
          desired,
          connection: { ...stored.connection, scope: desired.scope },
          ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
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
          })),
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        };
        return Response.json(response, {
          status: result.status === 'succeeded' ? 201 : result.status === 'in-progress' ? 202 : 500,
        });
      } catch (error) {
        if (error instanceof WorkspaceHostProvisioningConflictError) {
          return Response.json(
            { ok: false, error: 'workspace host already has a provisioning operation in progress' },
            { status: 409 },
          );
        }
        if (error instanceof WorkspaceHostProvisioningConnectionError) {
          return Response.json(
            { ok: false, error: 'workspace-host connection validation failed', problems: error.problems },
            { status: 409 },
          );
        }
        if (error instanceof WorkspaceHostProvisioningRequestError) {
          return Response.json(
            { ok: false, error: 'workspace-host provisioning request rejected', problems: error.problems },
            { status: 422 },
          );
        }
        return Response.json(
          { ok: false, error: 'workspace-host provisioning failed; see the host timeline for details' },
          { status: 500 },
        );
      }
    },
  });
}

export default createWorkspaceHostProvisionRoute();
