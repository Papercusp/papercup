/**
 * work-item-checkpoint — the bee's work-item-scoped in-flight CHECKPOINT
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010; D-002, D-003).
 *
 * As of su-cold-auto-mode-2026-07-03 P-001 this is a thin ADAPTER over the ONE
 * shared carry-note substrate ({@link ./carry-note}, mig 472): the bee checkpoint,
 * the Queen carry-journal, and the su loop carry-note are now the SAME store +
 * shape, keyed by scope. The bee's scope is {@link workItemScope} — WORK-ITEM
 * scoped (D-002), so an evicted bee's successor inherits the checkpoint. The
 * public signatures are UNCHANGED, so the spawn-hydration + bee-wake-dossier
 * re-injection seams and the work_items:checkpoint tool need no change.
 *
 * A bee writes a compressed snapshot of its in-flight state at a task boundary /
 * on graceful eviction; the next invocation on the SAME work-item re-injects it
 * (P-011) so a re-woken bee — OR a successor after eviction/death — resumes from
 * the checkpoint instead of a cold start. This is what lets the Phase-1
 * fresh-context warm-inject (D-001) drop the grown transcript without losing
 * continuity.
 *
 * Semantics are the shared carry-note contract (setCarryNote): any length,
 * replace-on-write, blank/omitted/null ⇒ cleared. LOCAL working state, never
 * federated.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { setCarryNote, getCarryNote, workItemScope } from './carry-note';

export interface WorkItemCheckpointRef {
  harness: string;
  workItemId: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

/**
 * Write (or clear) a work-item's checkpoint. Delegates to the shared carry-note
 * store under {@link workItemScope}. Returns the stored checkpoint (trimmed) or
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
  // journal:false — the bee checkpoint is a pure note (no trajectory ring): a
  // clear DELETES the row (the next invocation re-derives from the dossier —
  // graceful degradation, mig 281 semantics), byte-identical to the pre-P-001 store.
  const stored = await setCarryNote(
    { scope: workItemScope(ref.harness, ref.workItemId), workspaceId: ws },
    checkpoint,
    { journal: false },
  );
  // P-008 (autonomous-loop-prod-audit-2026-07-02): a checkpoint IS progress — bump
  // the work item's progress anchor so the stale-claims STALLED leg (holder alive,
  // last_progress_at > window) never frees a claim from a bee that is checkpointing.
  // Best-effort: the checkpoint write must not fail on a progress-bump hiccup.
  if (stored !== null) {
    try {
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.work_items
           SET last_progress_at = now()
         WHERE workspace_id = ${ws} AND harness_slug = ${ref.harness} AND feature_id = ${ref.workItemId}`;
      // Issue-family rows live in engineer_issues and do not yet have a separate
      // last_progress_at column. Refresh assigned_at for claimed, open issues so
      // checkpoint progress keeps the same stale-claim anchor alive.
      await sql`
        UPDATE harness_shared.engineer_issues
           SET assigned_at = now(), updated_at = now()
         WHERE workspace_id = ${ws}
           AND issue_id = ${ref.workItemId}
           AND assignee IS NOT NULL
           AND assignee <> ''
           AND state = 'open'`;
    } catch {
      /* best-effort */
    }
  }
  return stored;
}

/**
 * Read a work-item's checkpoint — the P-011 re-injection / successor-handoff
 * source. Returns the trimmed checkpoint, or `null` when none is stored.
 * Workspace-scoped.
 */
export async function getWorkItemCheckpoint(ref: WorkItemCheckpointRef): Promise<string | null> {
  const ws = ref.workspaceId ?? activeWorkspaceId();
  if (!ws || !ref.harness || !ref.workItemId) return null;
  return getCarryNote({ scope: workItemScope(ref.harness, ref.workItemId), workspaceId: ws });
}
