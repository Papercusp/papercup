/**
 * work-item-checkpoint — the bee's work-item-scoped in-flight CHECKPOINT store
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010; D-002, D-003). The bee
 * translation of the Queen's self-authored carry-note
 * ({@link ./hive/wake}.setHiveCarryNote, queen-brief-cache P-015): a bee writes a
 * compressed snapshot of its in-flight state at a task boundary / on graceful
 * eviction; the next invocation on the SAME work-item re-injects it (P-011) so a
 * re-woken bee — OR a SUCCESSOR bee after the prior one is evicted/dies —
 * resumes from the checkpoint instead of a cold start (a cheap handoff). This is
 * what lets the Phase-1 fresh-context warm-inject (D-001) drop the grown
 * transcript without losing continuity.
 *
 * Semantics mirror `setHiveCarryNote` EXACTLY (D-003): any length (no cap),
 * replace-on-write, omitted/blank ⇒ CLEARED (the row is deleted; the next
 * invocation re-derives from the dossier alone — graceful degradation).
 *
 * WORK-ITEM-scoped (D-002), keyed by (workspaceId, harness, workItemId) — so an
 * evicted bee's successor inherits the checkpoint (it lives on the work-item, not
 * the bee). LOCAL working state — never federated (migration 281: no
 * author_pubkey/origin/fed_ts, no sync/hyperbee projection). Backs the bee write
 * path + the P-011 re-injection seam (the read/write shape is coordinated with
 * the directed-wake P-021 one spawn/wake-hydration seam — D-009).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface WorkItemCheckpointRef {
  harness: string;
  workItemId: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

/**
 * Write (or clear) a work-item's checkpoint. `setHiveCarryNote` semantics: a
 * non-empty string (trimmed) REPLACES the stored checkpoint; `null` / `undefined`
 * / blank CLEARS it (deletes the row). Returns the stored checkpoint (trimmed) or
 * `null` when cleared. Workspace-scoped.
 */
export async function setWorkItemCheckpoint(
  ref: WorkItemCheckpointRef,
  checkpoint: string | null | undefined,
): Promise<string | null> {
  const ws = ref.workspaceId ?? activeWorkspaceId();
  if (!ws || !ref.harness || !ref.workItemId) {
    throw new Error('setWorkItemCheckpoint — workspaceId, harness, and workItemId are required');
  }
  const { sql } = getOrgPg();
  const trimmed = (checkpoint ?? '').trim();
  if (trimmed.length === 0) {
    // Blank / omitted ⇒ clear (delete the row; next invocation re-derives from the dossier).
    await sql`
      DELETE FROM harness_shared.work_item_checkpoints
       WHERE workspace_id = ${ws} AND harness_slug = ${ref.harness} AND work_item_id = ${ref.workItemId}`;
    return null;
  }
  await sql`
    INSERT INTO harness_shared.work_item_checkpoints (workspace_id, harness_slug, work_item_id, checkpoint, updated_ts)
    VALUES (${ws}, ${ref.harness}, ${ref.workItemId}, ${trimmed}, ${Date.now()})
    ON CONFLICT (workspace_id, harness_slug, work_item_id)
    DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_ts = EXCLUDED.updated_ts`;
  return trimmed;
}

/**
 * Read a work-item's checkpoint — the P-011 re-injection / successor-handoff
 * source. Returns the trimmed checkpoint, or `null` when none is stored.
 * Workspace-scoped.
 */
export async function getWorkItemCheckpoint(ref: WorkItemCheckpointRef): Promise<string | null> {
  const ws = ref.workspaceId ?? activeWorkspaceId();
  if (!ws || !ref.harness || !ref.workItemId) return null;
  const { sql } = getOrgPg();
  const rows = await sql<{ checkpoint: string | null }[]>`
    SELECT checkpoint FROM harness_shared.work_item_checkpoints
     WHERE workspace_id = ${ws} AND harness_slug = ${ref.harness} AND work_item_id = ${ref.workItemId}
     LIMIT 1`;
  const cp = (rows[0]?.checkpoint ?? '').trim();
  return cp.length > 0 ? cp : null;
}
