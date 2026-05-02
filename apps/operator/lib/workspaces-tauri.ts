// Browser-side wrapper around the workspace tauri commands defined in
// papercusp-desktop/src-tauri/src/main.rs.
//
// Two modes:
//   - desktop (Tauri shell injects __TAURI_INTERNALS__): use the native
//     commands, which also kill the sidecar + pglite-server on switch.
//   - webapp (no Tauri runtime): fall back to the operator's
//     /api/workspaces HTTP endpoints, which write the same registry.json
//     and let papercuspRoot() pick up the change on its next call.

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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(((j as { error?: string }).error) ?? `HTTP ${r.status}`);
  return j as T;
}

export async function listWorkspaces(): Promise<WorkspaceRegistry> {
  const t = tauri();
  if (t) return t.invoke<WorkspaceRegistry>('workspaces_list');
  return http<WorkspaceRegistry>('/api/workspaces');
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const t = tauri();
  if (t) return t.invoke<Workspace>('workspaces_create', { name });
  return http<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const t = tauri();
  if (t) return t.invoke<void>('workspaces_rename', { id, name });
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  const t = tauri();
  if (t) return t.invoke<void>('workspaces_delete', { id });
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Switch to a different workspace.
 *
 * In desktop mode, the Tauri shell kills the sidecar + pglite-server and
 * then calls app.restart() — the returned promise never resolves; the
 * page reloads under us.
 *
 * In webapp mode, just write the new `current` to registry.json. The
 * operator's papercuspRoot() invalidates on registry mtime, so the next
 * request transparently reads from the new workspace. We then reload the
 * page so client-side state (cached fetches, plugin host snapshots in
 * the panels) doesn't lag behind.
 */
export async function switchWorkspace(id: string, opts?: { resetTo?: string }): Promise<void> {
  const t = tauri();
  if (t) return t.invoke<void>('workspaces_switch', { id });
  await http<unknown>('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ id }) });
  if (typeof window !== 'undefined') {
    // Navigate to a clean URL so panel/modal/filter URL state from the
    // previous workspace doesn't carry over (e.g. ?panel=experts pointing
    // at a panel that doesn't exist in the new workspace).
    window.location.href = opts?.resetTo ?? `/harness?ws=${encodeURIComponent(id)}`;
  }
}
