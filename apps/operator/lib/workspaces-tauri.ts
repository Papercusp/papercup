// Browser-side wrapper around the workspace tauri commands defined in
// papercusp-desktop/src-tauri/src/main.rs. The operator UI is built in two
// modes: web (papercuspai.com — no Tauri runtime) and desktop (Tauri shell
// injects __TAURI_INTERNALS__). All exports are no-ops in web mode so the
// operator can render its workspace switcher conditionally without breaking
// the web build.

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

export interface WorkspaceRegistry {
  current: string;
  workspaces: Workspace[];
}

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function tauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export function isDesktop(): boolean {
  return tauri() !== null;
}

export async function listWorkspaces(): Promise<WorkspaceRegistry> {
  const t = tauri();
  if (!t) return { current: '', workspaces: [] };
  return t.invoke<WorkspaceRegistry>('workspaces_list');
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const t = tauri();
  if (!t) throw new Error('not in desktop mode');
  return t.invoke<Workspace>('workspaces_create', { name });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const t = tauri();
  if (!t) throw new Error('not in desktop mode');
  return t.invoke<void>('workspaces_rename', { id, name });
}

export async function deleteWorkspace(id: string): Promise<void> {
  const t = tauri();
  if (!t) throw new Error('not in desktop mode');
  return t.invoke<void>('workspaces_delete', { id });
}

/**
 * Switch to a different workspace. The Tauri shell will kill the sidecar
 * and pglite-server, then call app.restart() — so the returned promise
 * never actually resolves; the page reloads under us.
 */
export async function switchWorkspace(id: string): Promise<void> {
  const t = tauri();
  if (!t) throw new Error('not in desktop mode');
  return t.invoke<void>('workspaces_switch', { id });
}
