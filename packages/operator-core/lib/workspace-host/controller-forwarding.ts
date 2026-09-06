import {
  collectSiblingManagedTimers,
  DEFAULT_SIBLING_FANOUT_BUDGET_MS,
  DEFAULT_SIBLING_PROBE_TIMEOUT_MS,
  type SiblingManagedTimers,
} from '../schedule-federation';
import { requestOnlyHost } from '../background-workers';

export type WorkspaceHostRequestPath =
  | '/api/workspace-hosts/action'
  | '/api/workspace-hosts/provision';

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
  const rows = await collectControllers().catch(() => []);
  const controller = selectController(rows);
  if (!controller) return null;

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
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type');
    return new Response(await response.text(), {
      status: response.status,
      headers: contentType ? { 'content-type': contentType } : undefined,
    });
  } catch {
    return null;
  }
}

export const defaultWorkspaceHostRequestForwarder: WorkspaceHostRequestForwarder = (
  path,
  body,
) => forwardWorkspaceHostRequest(path, body);
