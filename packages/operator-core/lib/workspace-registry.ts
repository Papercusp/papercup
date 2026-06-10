/**
 * Workspace registry helpers — read/write ~/.papercusp-workspaces/registry.json.
 *
 * Adds the `companyId` field per spec/workspace-scoping. Existing
 * registries without companyId continue to work. (The hindsight:recall
 * consumer of companyId was removed — audit P-047.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Absolute path to the workspaces root (`~/.papercusp-workspaces`).
 *
 * This directory holds the registry + every per-workspace dir, and it
 * lives ABOVE the per-workspace isolation boundary. In the packaged
 * desktop the operator sidecar runs with `HOME` remapped to the *active
 * workspace dir*, so `homedir()` points INSIDE a workspace — resolving
 * the root via `homedir()` would land in a nested per-workspace registry
 * that disagrees with the one the Rust shell owns (the cause of the
 * "switch failed: workspace dir ... missing" class of bug). The desktop
 * passes the real root as `PAPERCUSP_WORKSPACES_ROOT`; prefer it. The
 * `homedir()` fallback is correct in dev, where HOME is not remapped.
 */
export function workspacesRoot(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

function registryPath(): string {
  return join(workspacesRoot(), 'registry.json');
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

/**
 * The literal 'default' workspace id — fallback when no registry exists
 * or no workspace is selected. Re-exported from the client-safe module
 * so legacy importers from this path keep working; new client code
 * should import from './workspace-id-constant' directly to avoid
 * pulling node:fs into client chunks.
 */
// Import the local binding (used by `activeWorkspaceId` below) AND re-export
// it, so legacy importers from this path keep working. A bare
// `export { X } from './y'` re-export does NOT create a local binding, which
// left `activeWorkspaceId`'s fallback referencing an undefined name.
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';
export { DEFAULT_WORKSPACE_ID };
import { currentRequestWorkspaceId, isInRequestScope } from './workspace-als';

// P-021 diagnostic dedupe — warn once per call site so a hot path can't flood
// the dev console. Module-global; reset in tests via the export below.
const warnedRequestFallbackSites = new Set<string>();

/** Test-only: clear the P-021 fall-through warning dedupe set. */
export function __resetWorkspaceFallbackWarnings(): void {
  warnedRequestFallbackSites.clear();
}

function warnGlobalFallbackInRequest(global: string): void {
  // Frame [3] of the stack is the caller of activeWorkspaceId() (the site that
  // resolved the global inside a request) — [0]=Error [1]=this [2]=activeWorkspaceId.
  const site = (new Error().stack ?? '').split('\n')[3]?.trim() ?? 'unknown';
  if (warnedRequestFallbackSites.has(site)) return;
  warnedRequestFallbackSites.add(site);
  // eslint-disable-next-line no-console
  console.warn(
    `[workspace] activeWorkspaceId() fell back to the global '${global}' INSIDE a ` +
      `request scope — the request carried no x-papercusp-workspace/?ws=, so it resolved ` +
      `the process-global workspace, not the window's. This is the silent-wrong-workspace ` +
      `mode per-window-workspace-context exists to kill (P-021). Site: ${site}`,
  );
}

export function activeWorkspaceId(): string {
  // Precedence (per-window-workspace-context-2026-05-31, D-002/D-005):
  // 1. The request-scoped workspace — a browser window stamped its workspace on
  //    the request (`x-papercusp-workspace` header → ALS). Most specific; this is
  //    what makes one shared sidecar serve many windows on different workspaces
  //    without following the process-global `reg.current`.
  const req = currentRequestWorkspaceId();
  if (req && req.trim()) return req.trim();
  // 2. Process pin — a dedicated single-workspace process (orchestrator agent,
  //    durable-pipeline dispatcher) that must not follow the desktop UI's
  //    volatile switches. Mirrors the orchestrator's `activeWorkspaceId()`.
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) return env.trim();
  // 3. Global default — the workspace a new window opens into / background work
  //    uses when not told otherwise. No longer authoritative for request work.
  const reg = readRegistry();
  const global = reg.current ?? reg.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
  // P-021: if we landed here while INSIDE a request/tool scope, the request
  // failed to carry its workspace. Surface it when developing (NODE_ENV
  // 'development', or an explicit opt-in) — never in 'test' (would trip
  // fail-on-console) or 'production' (no log spam).
  const warnEnabled =
    process.env.NODE_ENV === 'development' || process.env.PAPERCUSP_DEBUG_WORKSPACE === '1';
  if (warnEnabled && isInRequestScope()) {
    warnGlobalFallbackInRequest(global);
  }
  return global;
}

export function workspaceById(id: string): WorkspaceEntry | undefined {
  return readRegistry().workspaces.find((w) => w.id === id);
}

/**
 * The workspace set a BACKGROUND job must cover — per-window-workspace-context
 * P-020. A background reader (interval sweeper, boot-time re-registration,
 * scheduled dispatcher) has no request to scope it, so it must decide which
 * workspaces it serves instead of silently following the global:
 *   1. `PAPERCUSP_WORKSPACE_ID` pin → just that one (a dedicated
 *      single-workspace process — orchestrator agent, durable dispatcher).
 *   2. Shared-operator model (`PAPERCUSP_SHARED_OPERATOR=1`, set only by the
 *      desktop shell, D-008) → EVERY registered workspace; wrap each unit of
 *      work in `runWithWorkspace(ws, …)` so nested `activeWorkspaceId()`
 *      reads resolve that workspace.
 *   3. Dev / legacy single-active model → the one global active workspace —
 *      today's behavior, unchanged (D-009).
 * Canonical policy shared by the DBOS dispatcher (`orchestratorWorkspaceIds`),
 * the await-event sweeper, and the pot wake-rule boot registration.
 */
export function backgroundWorkspaceIds(): string[] {
  const pin = process.env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (pin) return [pin];
  if (process.env.PAPERCUSP_SHARED_OPERATOR === '1') {
    const ids = readRegistry()
      .workspaces.map((w) => w.id)
      .filter(Boolean);
    if (ids.length) return ids;
  }
  return [activeWorkspaceId()];
}

/**
 * Is `id` a workspace this host knows about? Used by the request-scope
 * middleware to distinguish a *missing* header (→ global fallback) from a
 * *present-but-unknown* one (→ hard error, D-007). The literal default
 * workspace is always known (the desktop guarantees it exists), even if a
 * sparse registry hasn't listed it.
 */
export function isKnownWorkspace(id: string): boolean {
  if (!id || !id.trim()) return false;
  if (id === DEFAULT_WORKSPACE_ID) return true;
  return !!workspaceById(id);
}

/**
 * Absolute path to a workspace's data dir — the directory the desktop
 * sidecar is spawned with as HOME (see papercusp-desktop workspaces.rs
 * `workspace_dir`). Mirrors the Rust layout: `<root>/<id>`.
 */
export function workspaceDir(id: string): string {
  return join(workspacesRoot(), id);
}

/**
 * Ensure a workspace's data dir exists on disk. The desktop `switch()`
 * guard refuses to switch to a registered workspace whose directory is
 * missing, so any code path that adds a registry entry MUST also provision
 * the directory. Idempotent. Returns the dir path.
 */
export function ensureWorkspaceDir(id: string): string {
  const dir = workspaceDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
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
