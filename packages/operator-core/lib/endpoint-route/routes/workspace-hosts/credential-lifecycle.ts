/** POST /workspace-hosts/:hostId/credential-lifecycle — durable rotate/revoke/reconnect/rebind. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  encodeWorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
} from '../../../workspace-host/initialization-operations-resolver';
import {
  runWorkspaceHostCredentialLifecycle,
  type WorkspaceHostCredentialLifecycleRunInput,
} from '../../../workspace-host/credential-lifecycle-runner';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

interface LifecycleBody extends Record<string, unknown> {
  action?: unknown;
  operationId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireObjects(
  body: LifecycleBody,
  fields: readonly string[],
): Response | undefined {
  const missing = fields.filter((field) => !isRecord(body[field]));
  return missing.length > 0
    ? Response.json(
        { ok: false, error: `missing or ill-typed required object field(s): ${missing.join(', ')}` },
        { status: 400 },
      )
    : undefined;
}

export interface WorkspaceHostCredentialLifecycleRouteDependencies {
  activeWorkspaceId: typeof activeWorkspaceId;
  resolveControllerProfile: typeof resolveWorkspaceHostInitializationControllerProfile;
  resolveOperationsForHost: typeof resolveWorkspaceHostInitializationOperationsForHost;
  runLifecycle: typeof runWorkspaceHostCredentialLifecycle;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostCredentialLifecycleRouteDependencies = {
  activeWorkspaceId,
  resolveControllerProfile: resolveWorkspaceHostInitializationControllerProfile,
  resolveOperationsForHost: resolveWorkspaceHostInitializationOperationsForHost,
  runLifecycle: runWorkspaceHostCredentialLifecycle,
};

export function createWorkspaceHostCredentialLifecycleRoute(
  dependencies: WorkspaceHostCredentialLifecycleRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/credential-lifecycle',
    auth: 'loopback',
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!SAFE_ID.test(hostId)) {
        return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
      }

      let body: LifecycleBody;
      try {
        body = (await req.json()) as LifecycleBody;
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      if (!isRecord(body)) {
        return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
      }
      if (body.operationId !== undefined &&
          (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return Response.json({ ok: false, error: 'invalid operationId' }, { status: 400 });
      }

      let shapeError: Response | undefined;
      switch (body.action) {
        case 'rotate':
          shapeError = requireObjects(body, [
            'currentCredentialRefs', 'currentDelivery', 'nextCredentialRefs', 'nextDelivery',
          ]);
          break;
        case 'revoke':
          shapeError = requireObjects(body, ['currentCredentialRefs', 'currentDelivery']);
          if (!shapeError &&
              (!Array.isArray(body.channels) || body.channels.some((channel) => typeof channel !== 'string'))) {
            shapeError = Response.json(
              { ok: false, error: 'channels must be an array of strings' },
              { status: 400 },
            );
          }
          break;
        case 'reconnect':
          shapeError = requireObjects(body, ['currentCredentialRefs', 'currentDelivery']);
          break;
        case 'restore-rebind':
          shapeError = requireObjects(body, ['backup', 'nextCredentialRefs', 'nextDelivery']);
          break;
        default:
          return Response.json(
            { ok: false, error: 'action must be rotate, revoke, reconnect, or restore-rebind' },
            { status: 400 },
          );
      }
      if (shapeError) return shapeError;

      const workspaceId = dependencies.activeWorkspaceId();
      let controller;
      try {
        controller = dependencies.resolveControllerProfile();
      } catch (error) {
        if (error instanceof WorkspaceHostInitializationControllerProfileError) {
          return Response.json(
            { ok: false, error: 'workspace-host credential lifecycle is not configured', problems: error.problems },
            { status: 503 },
          );
        }
        throw error;
      }

      let hostOperations;
      try {
        ({ operations: hostOperations } = await dependencies.resolveOperationsForHost({
          workspaceId,
          hostId,
          controller,
        }));
      } catch (error) {
        if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
          return Response.json(
            {
              ok: false,
              error: error.reason === 'host-not-found'
                ? 'workspace host not found'
                : 'workspace host has no recorded provisioning intent',
              reason: error.reason,
            },
            { status: error.reason === 'host-not-found' ? 404 : 409 },
          );
        }
        if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
          return Response.json(
            { ok: false, error: 'workspace-host credential lifecycle target is not implemented', target: error.target },
            { status: 501 },
          );
        }
        throw error;
      }

      const operations = {
        async execute(step: WorkspaceHostCredentialLifecycleStep) {
          // The shared encoder is the only definition of lifecycle-on-initializer wire carriage.
          return hostOperations.execute(
            encodeWorkspaceHostCredentialLifecycleStep(step) as unknown as WorkspaceHostInitializationStep,
          );
        },
      };
      const common = {
        workspaceId,
        hostId,
        operations,
        ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
      };
      let planned = false;

      try {
        let input: WorkspaceHostCredentialLifecycleRunInput;
        switch (body.action) {
          case 'rotate':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
              nextCredentialRefs: body.nextCredentialRefs as never,
              nextDelivery: body.nextDelivery as never,
            };
            break;
          case 'revoke':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
              channels: body.channels as never,
            };
            break;
          case 'reconnect':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
            };
            break;
          case 'restore-rebind':
            input = {
              ...common,
              action: body.action,
              backup: body.backup as never,
              nextCredentialRefs: body.nextCredentialRefs as never,
              nextDelivery: body.nextDelivery as never,
            };
            break;
        }
        input.onPlanned = () => {
          planned = true;
        };
        const result = await dependencies.runLifecycle(input);
        return Response.json({
          ok: true,
          operationId: result.operationId,
          hostId,
          action: result.plan.action,
          steps: result.plan.steps.map((step) => ({ id: step.id, kind: step.kind, channel: step.channel })),
          receipts: result.receipts.map((receipt) => ({
            stepId: receipt.stepId,
            channel: receipt.evidence.channel,
            operation: receipt.evidence.operation,
            generation: receipt.evidence.generation,
            referenceDigest: receipt.evidence.referenceDigest,
          })),
        });
      } catch (error) {
        if (!planned) {
          return Response.json(
            { ok: false, error: 'credential lifecycle request rejected', detail: (error as Error).message },
            { status: 422 },
          );
        }
        return Response.json(
          { ok: false, error: 'workspace host credential lifecycle failed; see the host timeline for details', hostId },
          { status: 500 },
        );
      }
    },
  });
}

export default createWorkspaceHostCredentialLifecycleRoute();
