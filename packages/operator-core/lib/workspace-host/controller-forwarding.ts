import { randomUUID } from 'node:crypto';
import {
  collectSiblingManagedTimers,
  DEFAULT_SIBLING_FANOUT_BUDGET_MS,
  DEFAULT_SIBLING_PROBE_TIMEOUT_MS,
  type SiblingManagedTimers,
} from '../schedule-federation';
import { requestOnlyHost } from '../background-workers';

export type WorkspaceHostRequestPath =
  | '/api/workspace-hosts/action'
  | '/api/workspace-hosts/provision'
  | `/api/workspace-hosts/${string}/initialize`
  | `/api/workspace-hosts/${string}/desktop-pack`;

export type WorkspaceHostRequestForwarder = (
  path: WorkspaceHostRequestPath,
  body: unknown,
) => Promise<Response | null>;

export interface WorkspaceHostControllerForwardingOptions {
  isRequestOnly?: () => boolean;
  collectControllers?: () => Promise<readonly SiblingManagedTimers[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS = 3_000;

function isDirectBackgroundController(row: SiblingManagedTimers): boolean {
  return (
    row.ok &&
    row.process === 'bg-host' &&
    !row.label.includes('(primary via :')
  );
}

function selectController(rows: readonly SiblingManagedTimers[]): SiblingManagedTimers | null {
  return (
    rows
      .filter(isDirectBackgroundController)
      .sort((a, b) => a.port - b.port)[0] ?? null
  );
}

/** Keep discovery failures distinguishable from a mutation whose response was lost. */
function controllerUnavailable(
  reason: 'discovery-failed' | 'no-controller',
  rows: readonly SiblingManagedTimers[] = [],
): Response {
  const candidates = rows.slice(0, 8).map((row) => ({
    port: row.port,
    pid: row.pid,
    role: row.process === 'bg-host' || row.process === 'operator' ? row.process : 'unknown',
    reachable: row.ok,
    direct: !row.label.includes('(primary via :'),
    elapsedMs: row.elapsedMs,
  }));
  return Response.json({
    ok: false,
    error: 'workspace-host background controller unavailable',
    outcome: 'not-dispatched',
    controllerDiscovery: { reason, candidates, omittedCandidates: rows.length - candidates.length },
  }, { status: 503 });
}

/**
 * Request-only operator hosts (:3170 and clustered request workers) do not launch
 * DBOS. Discover the live background host through the existing per-port IPC
 * registry and its loopback process-role probe, then relay the typed route
 * request with a bounded transport deadline.
 */
export async function forwardWorkspaceHostRequest(
  path: WorkspaceHostRequestPath,
  body: unknown,
  options: WorkspaceHostControllerForwardingOptions = {},
): Promise<Response | null> {
  const isRequestOnly = options.isRequestOnly ?? (() => requestOnlyHost());
  if (!isRequestOnly()) return null;

  const collectControllers =
    options.collectControllers ??
    (() =>
      collectSiblingManagedTimers({
        timeoutMs: DEFAULT_SIBLING_PROBE_TIMEOUT_MS,
        budgetMs: DEFAULT_SIBLING_FANOUT_BUDGET_MS,
      }));
  let rows: readonly SiblingManagedTimers[];
  try {
    rows = await collectControllers();
  } catch {
    // Exceptions and probe error strings may carry private paths or credentials. Retain the
    // closed reason and public candidate metadata, never raw exception/provider bodies.
    return controllerUnavailable('discovery-failed');
  }
  const controller = selectController(rows);
  if (!controller) return controllerUnavailable('no-controller', rows);

  // Both callers validate an object before forwarding. Choose the operation ID
  // here, before crossing the transport boundary, so a lost response cannot also
  // lose the only identity with which to reconcile a possibly accepted mutation.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const operationId =
    'operationId' in body && typeof body.operationId === 'string'
      ? body.operationId
      : randomUUID();
  const forwardedBody = { ...body, operationId };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${controller.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
      ),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(forwardedBody),
    });
    const contentType = response.headers.get('content-type');
    const location = response.headers.get('location');
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(location ? { location } : {}),
      },
    });
  } catch {
    // The controller waits for the durable workflow's result, which can outlive
    // this transport deadline. Once dispatched, a timeout or lost response says
    // nothing about acceptance. Reserve null for local-controller bypass; otherwise the
    // route reports an unavailable executor even while its mutation is running.
    return Response.json(
      {
        ok: false,
        error: 'workspace-host controller response unavailable',
        outcome: 'unknown',
        operationId,
        message: `Operation ${operationId} may have been accepted. Check the workspace host timeline before retrying, and preserve this operation ID.`,
      },
      { status: 504 },
    );
  }
}

export const defaultWorkspaceHostRequestForwarder: WorkspaceHostRequestForwarder = (
  path,
  body,
) => forwardWorkspaceHostRequest(path, body);
