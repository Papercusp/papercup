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
import { resolveConcreteWorkspaceId } from './workspace-registry';
import { setCarryNote, setCarryNoteWithPrior, getCarryNote, workItemScope } from './carry-note';

export interface WorkItemCheckpointRef {
  /**
   * The harness the item lives under. May be `null` for a harness-null item — an
   * issue-family EI filed from an unscoped su session (EI-8805). Both write and read
   * MUST resolve to the same canonical key: null / '' / the unscoped-session wildcard
   * '*' collapse onto one namespace via {@link checkpointScopeHarness}, so a
   * harness-null item's checkpoint is keyed identically on every write/read seam.
   */
  harness: string | null;
  workItemId: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

/**
 * The sentinel namespace for a harness-null item's checkpoint. A harness-null item
 * (issue-family EI from an unscoped session) has no harness, and the unscoped su
 * session that writes it resolves its own harness to this wildcard — so null, empty,
 * and '*' must ALL key under one namespace or a write silently orphans its checkpoint
 * (EI-8805: the write keyed under the session harness while the read looked it up
 * under the item's own null harness). The work-item id is unique within the workspace,
 * so collapsing the harness component onto a single sentinel never collides.
 */
const CHECKPOINT_WILDCARD_HARNESS = '*';

/** Canonicalize the scope harness: null / '' / the '*' wildcard ⇒ the shared sentinel. */
function checkpointScopeHarness(harness: string | null | undefined): string {
  return harness && harness !== CHECKPOINT_WILDCARD_HARNESS ? harness : CHECKPOINT_WILDCARD_HARNESS;
}

/** P-008 (autonomous-loop-prod-audit-2026-07-02): a checkpoint IS progress — bump
 *  the work item's progress anchor so the stale-claims STALLED leg (holder alive,
 *  last_progress_at > window) never frees a claim from a bee that is checkpointing.
 *  Best-effort: the checkpoint write must not fail on a progress-bump hiccup. Shared
 *  by {@link setWorkItemCheckpoint} and {@link setWorkItemCheckpointWithPrior}. */
async function bumpCheckpointProgressAnchor(ref: WorkItemCheckpointRef, ws: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    // Feature-family progress anchor keys on a concrete harness_slug. A harness-null
    // item (issue-family EI) has no feature row, so skip this UPDATE — the
    // engineer_issues UPDATE below is its progress anchor (EI-8805).
    if (ref.harness && ref.harness !== CHECKPOINT_WILDCARD_HARNESS) {
      await sql`
        UPDATE harness_shared.work_items
           SET last_progress_at = now()
         WHERE workspace_id = ${ws} AND harness_slug = ${ref.harness} AND feature_id = ${ref.workItemId}`;
    }
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

/**
 * Write (or clear) a work-item's checkpoint. Delegates to the shared carry-note
 * store under {@link workItemScope}. Returns the stored checkpoint (trimmed) or
 * `null` when cleared. Workspace-scoped.
 */
export async function setWorkItemCheckpoint(
  ref: WorkItemCheckpointRef,
  checkpoint: string | null | undefined,
): Promise<string | null> {
  return (await setWorkItemCheckpointWithPrior(ref, checkpoint)).stored;
}

/** A checkpoint write's result plus the PRIOR checkpoint's length (EI-9325) — free,
 *  since the row is already SELECTed FOR UPDATE inside {@link setCarryNoteWithPrior}'s
 *  transaction. Lets a caller (work_items:checkpoint) warn — never block — on a
 *  suspicious shrink: a plain replace-on-write dramatically shorter than what was
 *  stored before usually means an accidental placeholder/truncated paste rather than
 *  an intentional rewrite. */
export interface WorkItemCheckpointWithPriorResult {
  stored: string | null;
  /** chars in the PRIOR checkpoint before this write replaced it (0 if none existed). */
  priorLength: number;
}

/** Same semantics + same progress-anchor bump as {@link setWorkItemCheckpoint}, plus
 *  the prior checkpoint's length. */
export async function setWorkItemCheckpointWithPrior(
  ref: WorkItemCheckpointRef,
  checkpoint: string | null | undefined,
): Promise<WorkItemCheckpointWithPriorResult> {
  // EI-9013: canonicalize the workspace AT THE SUBSTRATE — a caller that passes
  // the unscoped-session wildcard '*' (or nothing) must never key a row under a
  // literal '*' workspace (the EI-8824 class) or read from one. Fixing this here
  // (not per-caller) means NO write/read seam — the tool, the orient recovery
  // fold, carry-brief, park — can strand or miss a checkpoint via the wildcard.
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) {
    throw new Error('setWorkItemCheckpoint — workspaceId and workItemId are required');
  }
  // journal:false — the bee checkpoint is a pure note (no trajectory ring): a
  // clear DELETES the row (the next invocation re-derives from the dossier —
  // graceful degradation, mig 281 semantics), byte-identical to the pre-P-001 store.
  // The scope harness is CANONICALIZED (EI-8805) so a harness-null item keys under
  // one namespace on every write/read seam.
  const { stored, priorLength } = await setCarryNoteWithPrior(
    { scope: workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId), workspaceId: ws },
    checkpoint,
    { journal: false },
  );
  if (stored !== null) await bumpCheckpointProgressAnchor(ref, ws);
  return { stored, priorLength };
}

/**
 * Read a work-item's checkpoint — the P-011 re-injection / successor-handoff
 * source. Returns the trimmed checkpoint, or `null` when none is stored.
 * Workspace-scoped.
 */
export async function getWorkItemCheckpoint(ref: WorkItemCheckpointRef): Promise<string | null> {
  // EI-9013: same wildcard canonicalization as the write side — a read scoped by
  // the session's '*' must resolve to the concrete active workspace or it can
  // never see a row the (fixed) write path stored concretely.
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return null;
  // EI-8805: canonicalize the scope harness so a harness-null item reads back the
  // checkpoint it was written under (previously a null harness short-circuited to null).
  return getCarryNote({ scope: workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId), workspaceId: ws });
}

/** A work-item checkpoint plus its write instant — the staleness signal a reader
 *  needs (EI-8885): a checkpoint is only trustworthy relative to WHEN it was
 *  written (a stale carry-note read across a compaction or a multi-wake gap has
 *  bitten agents twice — WI-3578), so callers that need to judge "is this still
 *  current" get both in one query instead of the bare string alone. Mirrors
 *  {@link getLoopCarryNoteWithMeta}'s shape for the work-item scope. */
export interface WorkItemCheckpointWithMeta {
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write (carry_notes.updated_ts), null when none. */
  updatedAtMs: number | null;
}

/** Read a work-item's checkpoint WITH its write instant. Same scope-canonicalization
 *  as {@link getWorkItemCheckpoint}; one query. */
export async function getWorkItemCheckpointWithMeta(ref: WorkItemCheckpointRef): Promise<WorkItemCheckpointWithMeta> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId); // EI-9013 — see getWorkItemCheckpoint
  if (!ws || !ref.workItemId) return { checkpoint: null, updatedAtMs: null };
  const scope = workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ note: string | null; updated_ts: string | number | null }[]>`
      SELECT note, updated_ts FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    if (note.length === 0) return { checkpoint: null, updatedAtMs: null };
    const ts = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    return { checkpoint: note, updatedAtMs: Number.isFinite(ts) ? ts : null };
  } catch {
    return { checkpoint: null, updatedAtMs: null };
  }
}
