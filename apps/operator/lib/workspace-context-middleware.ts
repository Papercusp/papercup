/**
 * Request-scoped workspace middleware (per-window-workspace-context-2026-05-31,
 * P-011 / D-002 / D-007).
 *
 * Reads the `x-papercusp-workspace` header a browser window stamps on each
 * request (see the operator-vite fetch wrapper + `getBrowserWorkspaceId`) and
 * runs the downstream handler chain inside `runWithWorkspace`, so
 * `activeWorkspaceId()` resolves to *this window's* workspace instead of the
 * process-global `reg.current`.
 *
 * Header semantics (D-007):
 *   - missing  → no ALS; `activeWorkspaceId()` falls back to the global default.
 *     (legacy clients, background/non-window requests — acceptable.)
 *   - present-but-unknown → 400. A present id we don't recognise is exactly the
 *     silent-corruption mode this plan exists to kill, so we reject loudly
 *     rather than fall back.
 *   - present and known → wrap the handler in `runWithWorkspace`.
 *
 * NOTE (D-001): streamed transports (`EventSource`/`IpcEventSource`, WS) cannot
 * set a custom header, so SSE/WS endpoints carry their workspace another way
 * (P-015). This middleware covers the request/fetch path.
 */
import type { MiddlewareHandler } from 'hono';
import { runWithWorkspace } from './workspace-als';
import { isKnownWorkspace } from './workspace-registry';

export const WORKSPACE_HEADER = 'x-papercusp-workspace';

export const workspaceContextMiddleware: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header(WORKSPACE_HEADER);
  const ws = raw?.trim();
  if (!ws) {
    // Missing header → global fallback (background/legacy callers).
    return next();
  }
  if (!isKnownWorkspace(ws)) {
    return c.json({ error: 'unknown_workspace', workspace: ws }, 400);
  }
  return runWithWorkspace(ws, () => next());
};
