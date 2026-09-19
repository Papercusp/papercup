/**
 * POST /workspace-hosts/:hostId/initialize — initialize an ALREADY-PROVISIONED workspace host.
 *
 * This is the production surface over `runWorkspaceHostInitialization` (P-046 / WI-40474). The
 * contract library, the GCP IAP adapter, the durable replay store and the run assembly were all
 * complete and tested before this route existed; none of it was reachable, which is what this
 * closes.
 *
 * The route deliberately owns only three things — identity, configuration, and the mapping from
 * failure to status code. It does NOT re-validate the initialization request: the contract's
 * planner is the single validator, and duplicating its rules here would create a second, drifting
 * copy of them. What the route adds is the ability to tell the caller WHICH kind of failure
 * happened, which the planner alone cannot express through a thrown error:
 *
 *   400  the body is not a usable request (bad JSON, missing/ill-typed required fields)
 *   404  no such host in this workspace
 *   409  the host exists but has no recorded provisioning intent, so the instance to reach is
 *        unknown — see migration 956; the fix is on the provisioner, not the caller
 *   422  the contract rejected the request; retrying it unchanged cannot succeed
 *   500  the request was valid and execution failed — the operation row and timeline hold why
 *   501  no initialization adapter for this host's target (AWS/Azure are separate plan items)
 *   503  the controller itself is not configured to initialize anything
 *
 * 422-vs-500 is decided by the runner's `onPlanned` seam rather than by inspecting the error,
 * because planning happens before any row exists: if the callback never fired, the request was
 * never valid. Guessing from an error message is the fragile alternative that rots silently.
 *
 * Errors are never echoed verbatim. A failure raised deep in the run may quote host output, so
 * the human-facing field is a fixed sentence and the detail goes to the durable timeline, which
 * the audit route already exports with redaction applied.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveWorkspaceHostRequestedAgents } from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
} from '../../../workspace-host/initialization-operations-resolver';
import { createOperatorWorkspaceHostCredentialMaterialSource } from '../../../workspace-host/credential-material-source';
import { runWorkspaceHostInitialization } from '../../../workspace-host/initialization-runner';

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

interface InitializeBody {
  source?: unknown;
  credentialRefs?: unknown;
  credentialDelivery?: unknown;
  publicMetadata?: unknown;
  operationId?: unknown;
  requestedAgents?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export default defineTool({
  method: 'POST',
  path: '/workspace-hosts/:hostId/initialize',
  auth: 'loopback',
  async handler(req, ctx) {
    const hostId = String(ctx.params.hostId ?? '').trim();
    if (!HOST_ID.test(hostId)) {
      return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
    }

    let body: InitializeBody;
    try {
      body = (await req.json()) as InitializeBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
    }

    // Presence/shape only. Everything about what these values MEAN is the planner's to judge.
    const missing = (['source', 'credentialRefs', 'credentialDelivery'] as const).filter(
      (key) => !isRecord(body[key]),
    );
    if (missing.length > 0) {
      return Response.json(
        { ok: false, error: `missing or ill-typed required object field(s): ${missing.join(', ')}` },
        { status: 400 },
      );
    }
    if (body.operationId !== undefined && typeof body.operationId !== 'string') {
      return Response.json({ ok: false, error: 'operationId must be a string' }, { status: 400 });
    }
    if (body.publicMetadata !== undefined && !isRecord(body.publicMetadata)) {
      return Response.json({ ok: false, error: 'publicMetadata must be an object' }, { status: 400 });
    }

    let requestedAgents;
    try {
      requestedAgents = body.requestedAgents === undefined ? undefined : resolveWorkspaceHostRequestedAgents(body.requestedAgents);
    } catch (error) {
      return Response.json({ ok: false, error: 'initialization request rejected', detail: (error as Error).message }, { status: 422 });
    }

    const workspaceId = activeWorkspaceId();

    let controller;
    try {
      controller = resolveWorkspaceHostInitializationControllerProfile();
    } catch (error) {
      if (error instanceof WorkspaceHostInitializationControllerProfileError) {
        return Response.json(
          { ok: false, error: 'workspace-host initialization is not configured', problems: error.problems },
          { status: 503 },
        );
      }
      throw error;
    }

    let operations;
    let deliveryCapabilities;
    const credentialMaterialSource = createOperatorWorkspaceHostCredentialMaterialSource();
    try {
      ({ operations, deliveryCapabilities } = await resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId,
        hostId,
        controller,
        // D-216. The route does NOT accept material in its body and must not: the request carries
        // public binding metadata that the planner asserts secret isolation over. The bytes are
        // resolved from the operator's encrypted store, under a key derived from the reference the
        // caller DID send.
        credentialMaterialSource,
      }));
    } catch (error) {
      if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
        return Response.json(
          { ok: false, error: error.message, reason: error.reason },
          { status: error.reason === 'host-not-found' ? 404 : 409 },
        );
      }
      if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
        return Response.json({ ok: false, error: error.message, target: error.target }, { status: 501 });
      }
      throw error;
    }

    // Flipped by the runner the instant the request validates — see the header note on 422/500.
    let planned = false;

    try {
      const result = await runWorkspaceHostInitialization({
        workspaceId,
        hostId,
        operations,
        deliveryCapabilities,
        source: body.source as never,
        credentialRefs: body.credentialRefs as never,
        credentialDelivery: body.credentialDelivery as never,
        ...(requestedAgents !== undefined ? { requestedAgents } : {}),
        credentialMaterialSource,
        ...(body.operationId ? { operationId: body.operationId } : {}),
        ...(body.publicMetadata ? { publicMetadata: body.publicMetadata as Record<string, unknown> } : {}),
        onPlanned: () => {
          planned = true;
        },
      });

      return Response.json({
        ok: true,
        operationId: result.operationId,
        hostId,
        steps: result.plan.steps.map((step) => ({ id: step.id, kind: step.kind })),
        receipts: result.receipts.length,
      });
    } catch (error) {
      if (!planned) {
        // Rejected by the contract before anything was recorded. The planner's own message names
        // the offending field and carries no host output, so it is safe and useful to return.
        return Response.json(
          { ok: false, error: 'initialization request rejected', detail: (error as Error).message },
          { status: 422 },
        );
      }
      return Response.json(
        {
          ok: false,
          error: 'workspace host initialization failed; see the host timeline for details',
          hostId,
        },
        { status: 500 },
      );
    }
  },
});
