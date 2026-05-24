/**
 * The `papercusp-workspace` sentinel — papercusp-dogfood-v5 §1 + P-006.
 *
 * One workspace per Papercusp install, with the literal name/id
 * `papercusp-workspace`, dedicated to dogfooding papercup itself
 * (Phase 4 et al). This module is the single source of truth for
 * the literal id, the predicate, and the bootstrap helper. UI bindings
 * land later when the create-harness UI uses Entry 3 to register
 * papercup as the first harness in this workspace.
 *
 * Why a literal id, not generated:
 *   - Phase 4 dogfood needs to address it by name across boots.
 *   - The Cupboard sharing layer (Phase 9) will reference shared
 *     harnesses by `{workspaceId, slug}`; making the dogfood
 *     workspace id stable is necessary for the public-shared catalog.
 *   - Users on multiple machines hit the same sentinel name, so the
 *     same-name dogfood harness on each lands in the same workspace
 *     when they re-import.
 *
 * Behavior on ensure:
 *   - Creates the registry entry if missing. Idempotent.
 *   - NEVER changes `registry.current` — leaves whatever the user has
 *     selected alone. Boot-time bootstrap may add the sentinel without
 *     hijacking the user's active workspace.
 *   - Returns the entry (existing or newly-created).
 */

import { readRegistry, writeRegistry, type WorkspaceEntry } from '@/lib/workspace-registry';

/** The literal id + name of the sentinel workspace. */
export const PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace' as const;

/** True if `id` is the sentinel workspace id. */
export function isPapercuspWorkspace(id: string | null | undefined): boolean {
  return id === PAPERCUSP_WORKSPACE_ID;
}

/**
 * Ensure the sentinel workspace exists in the registry. Idempotent —
 * safe to call on every boot. Returns the entry. Does NOT change
 * `registry.current`.
 */
export function ensurePapercuspWorkspace(): WorkspaceEntry {
  const reg = readRegistry();
  const existing = reg.workspaces.find((w) => w.id === PAPERCUSP_WORKSPACE_ID);
  if (existing) return existing;

  const entry: WorkspaceEntry = {
    id: PAPERCUSP_WORKSPACE_ID,
    name: PAPERCUSP_WORKSPACE_ID,
    createdAt: Date.now(),
  };
  reg.workspaces.push(entry);
  // If the registry was previously empty (fresh install), this is the
  // first workspace — set it as current so the user lands somewhere
  // valid. If there's already a `current` selection, leave it alone.
  if (!reg.current) reg.current = PAPERCUSP_WORKSPACE_ID;
  writeRegistry(reg);
  return entry;
}
