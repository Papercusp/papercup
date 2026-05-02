/**
 * Workspace registry helpers — read/write ~/.papercusp-workspaces/registry.json.
 *
 * Adds the `companyId` field per spec/workspace-scoping. Existing
 * registries without companyId continue to work; hindsight:recall
 * returns degraded for those workspaces.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorkspaceEntry {
  id: string;
  name: string;
  createdAt: number;
  /** Paperclip company id for Hindsight bank derivation. */
  companyId?: string | null;
}

export interface WorkspaceRegistry {
  current?: string;
  workspaces: WorkspaceEntry[];
}

function registryPath(): string {
  return join(homedir(), '.papercusp-workspaces', 'registry.json');
}

export function readRegistry(): WorkspaceRegistry {
  const p = registryPath();
  if (!existsSync(p)) return { workspaces: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkspaceRegistry;
  } catch {
    return { workspaces: [] };
  }
}

export function writeRegistry(reg: WorkspaceRegistry): void {
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

export function activeWorkspaceId(): string {
  const reg = readRegistry();
  return reg.current ?? reg.workspaces[0]?.id ?? 'default';
}

export function workspaceById(id: string): WorkspaceEntry | undefined {
  return readRegistry().workspaces.find((w) => w.id === id);
}

export function setCompanyId(workspaceId: string, companyId: string | null): void {
  const reg = readRegistry();
  const ws = reg.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    throw new Error(`unknown workspace ${workspaceId}`);
  }
  if (companyId == null) {
    delete (ws as any).companyId;
  } else {
    ws.companyId = companyId;
  }
  writeRegistry(reg);
}

export function companyIdFor(workspaceId: string): string | null {
  return workspaceById(workspaceId)?.companyId ?? null;
}
