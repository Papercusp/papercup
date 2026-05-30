/**
 * Browser-side workspace identity + localStorage key scoping.
 *
 * Per `workspace-localstorage-isolation-2026-05-27`. The Tauri webview loads
 * the operator at a fixed origin (`http://127.0.0.1:3070`), so localStorage is
 * shared across every workspace. Every workspace-relevant key must be
 * namespaced with the active workspace id.
 *
 * Id source precedence (D-001):
 *   1. `window.__PAPERCUSP_WS__` — injected into index.html by the
 *      workspace-specific operator host (see host-spa). Navigation-independent
 *      and correct on cold start, unlike `?ws=`.
 *   2. `?ws=` query param — back-compat / deep-link fallback.
 *   3. `'default'`.
 *
 * Callers MUST compute keys at call time — read the id per call, never capture
 * `wsLocalKey(...)` in a module-level constant. The injected global / URL may
 * not be set when a module is first evaluated.
 */

declare global {
  interface Window {
    /** Active workspace id, injected by the operator host into index.html. */
    __PAPERCUSP_WS__?: string;
  }
}

/** The active workspace id as seen by the browser. Falls back to 'default'. */
export function getBrowserWorkspaceId(): string {
  if (typeof window === 'undefined') return 'default';
  try {
    const injected = window.__PAPERCUSP_WS__;
    if (injected && injected.trim()) return injected;
  } catch {
    /* ignore */
  }
  try {
    const ws = new URL(window.location.href).searchParams.get('ws');
    if (ws && ws.trim()) return ws;
  } catch {
    /* ignore */
  }
  return 'default';
}

/** Namespace a localStorage key to the active workspace: `pc:ws:<id>:<key>`. */
export function wsLocalKey(key: string): string {
  return `pc:ws:${getBrowserWorkspaceId()}:${key}`;
}
