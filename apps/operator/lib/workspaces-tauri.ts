// Browser-side wrapper around the workspace tauri commands defined in
// papercusp-desktop/src-tauri/src/main.rs.
//
// Two modes:
//   - desktop (Tauri shell injects __TAURI_INTERNALS__): use the native
//     commands, which also kill the sidecar + per-workspace PG backend
//     (embedded-postgres-server by default, or pglite-server in legacy
//     mode) on switch.
//   - webapp (no Tauri runtime): fall back to the operator's
//     /api/workspaces HTTP endpoints, which write the same registry.json
//     and let papercuspRoot() pick up the change on its next call.
//
// Tauri-side calls go through the typed tauri-bindings produced by
// tauri-specta; the public API of this file is unchanged.

import { commands, type Workspace as BindingsWorkspace, type Registry } from './tauri-bindings';
import { navigateClient } from './client-navigation';

export type Workspace = BindingsWorkspace;

export interface WorkspaceRegistry {
  current: string;
  workspaces: Workspace[];
}

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isDesktop(): boolean {
  return isDesktopRuntime();
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
  if (isDesktopRuntime()) {
    return commands.workspacesList() as Promise<Registry>;
  }
  return http<WorkspaceRegistry>('/api/workspaces');
}

export async function createWorkspace(name: string): Promise<Workspace> {
  if (isDesktopRuntime()) {
    const r = await commands.workspacesCreate(name);
    if (r.status === 'error') throw new Error(r.error);
    return r.data;
  }
  return http<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  if (isDesktopRuntime()) {
    const r = await commands.workspacesRename(id, name);
    if (r.status === 'error') throw new Error(r.error);
    return;
  }
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  if (isDesktopRuntime()) {
    const r = await commands.workspacesDelete(id);
    if (r.status === 'error') throw new Error(r.error);
    return;
  }
  await http<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Switch to a different workspace.
 *
 * In desktop mode, the Tauri shell kills the sidecar + per-workspace PG
 * backend (embedded-postgres-server by default, pglite-server legacy)
 * and then calls app.restart() — the returned promise never resolves;
 * the page reloads under us.
 *
 * In webapp mode, just write the new `current` to registry.json. The
 * operator's papercuspRoot() invalidates on registry mtime, so the next
 * request transparently reads from the new workspace. We then reload the
 * page so client-side state (cached fetches, plugin host snapshots in
 * the panels) doesn't lag behind.
 */

export function resolveWorkspaceSwitchTarget(id: string, opts?: { resetTo?: string }): string {
  return opts?.resetTo ?? `/harness?ws=${encodeURIComponent(id)}`;
}
export async function switchWorkspace(id: string, opts?: { resetTo?: string }): Promise<void> {
  if (isDesktopRuntime()) {
    const r = await commands.workspacesSwitch(id);
    if (r.status === 'error') throw new Error(r.error);
    return;
  }
  await http<unknown>('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ id }) });
  if (typeof window !== 'undefined') {
    navigateClient(resolveWorkspaceSwitchTarget(id, opts));
  }
}
