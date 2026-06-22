/**
 * doc-steward-dispatch — the P-008 doc-steward dispatch (docs-corpus-audit WS2). Extracted from
 * sweep-after-sync so it's unit-testable without the sweep's git/PG/coord deps.
 *
 * When the post-git-sync freshness sweep flags newly-drifted docs, dispatch ONE doc-steward agent
 * (gated on `papercusp-doc-steward`) to re-sync them to the current code — the LLM counterpart of
 * the deterministic drift DETECTION. Mirrors git-sync → merge-resolution on conflict.
 */

/** A drifted doc handed to the doc-steward in its `--doc-drift` extra. */
export interface DriftedDoc {
  /** Doc-root-relative path of the stale doc. */
  docId: string;
  /** The CODE file(s) the doc documents — what drifted. */
  anchorPaths: string[];
  /** Why the sweep flagged it (which subject code changed). */
  reason: string;
  /** 'generated' | 'manual' | 'augmented'. */
  source: string;
  /**
   * P-005 (deterministic-commit-workitem-attribution): the work-item(s) that recently changed
   * this doc's anchored code — DERIVED from git_sync_commit_attribution (D-006: no extra agent
   * tool call). Tells the doc-steward WHY the code drifted, so it can read the work-item's intent
   * instead of reverse-engineering the diff. Absent when the change wasn't attributed.
   */
  workItems?: string[];
}

/**
 * Dispatch the doc-steward for a batch of newly-drifted docs. DETERMINISTIC trigger; best-effort
 * — a dispatch failure must NEVER wedge the sweep / git-sync. Fires the `docs:drift` launch
 * blueprint. Returns true iff a doc-steward was dispatched (for testability / observability).
 */
export async function dispatchDocStewardForDrift(
  harnessSlug: string,
  workspaceId: string,
  staleDocs: DriftedDoc[],
): Promise<boolean> {
  if (staleDocs.length === 0) return false;
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.DOC_STEWARD, harnessSlug))) return false;
    const { fireLaunchBlueprintForEvent } = await import('../../blueprint/launch-blueprint');
    await fireLaunchBlueprintForEvent('docs:drift', {
      installSlug: harnessSlug,
      workspaceId,
      kickoff: `Re-sync ${staleDocs.length} drifted doc(s) in ${harnessSlug} to the current code: ${staleDocs.map((d) => d.docId).join(', ')}`,
      extra: ['--doc-drift', JSON.stringify({ docs: staleDocs })],
    });
    return true;
  } catch {
    // best-effort: doc-steward dispatch must never break the sweep
    return false;
  }
}
