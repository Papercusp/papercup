/**
 * Request-scoped workspace context (per-window-workspace-context-2026-05-31, P-010).
 *
 * The window/request that made a call knows its workspace (`x-papercusp-workspace`
 * header → middleware). This AsyncLocalStorage carries that id through the whole
 * async handler stack so `activeWorkspaceId()` can return the *request's*
 * workspace instead of the process-global `reg.current`. Mirrors the existing
 * `runWithPluginExecCtx` / `currentPluginExecCtx` precedent in `log-events.ts`.
 *
 * A dedicated ALS (not a field on the plugin-exec context) because workspace
 * context must wrap EVERY request, whereas the plugin-exec context is set only
 * during a plugin handler's run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface WorkspaceRequestContext {
  workspaceId: string;
}

const workspaceCtx = new AsyncLocalStorage<WorkspaceRequestContext>();

/** The request-scoped workspace id, or undefined when not inside a request. */
export function currentRequestWorkspaceId(): string | undefined {
  return workspaceCtx.getStore()?.workspaceId;
}

/** Run `fn` with `workspaceId` attached to its async stack. */
export function runWithWorkspace<T>(workspaceId: string, fn: () => T): T {
  return workspaceCtx.run({ workspaceId }, fn);
}
