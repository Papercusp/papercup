/**
 * UI display-projection for the `workItems.byHarness` sync feed
 * (precompute-sync-reads-phase2-compute-latency-2026-07-19 P-006).
 *
 * `workItems.byHarness` was the single largest sync payload found (3.79MB at
 * limit 2000). A prior audit already nulled the per-row `payload` /
 * `terminalCompletionRef` / `terminalCompletionEvidence` blobs in the SHARED
 * listEnrichedWorkItems assembly (both transports). The dominant field that
 * remained is `summary` — measured avg ~694 chars, max ~346KB on the papercusp
 * harness — which the WorkItemsPanel GRID does not render, filter, or search
 * (its quick-search covers id/title/state/assignee only; its column filters use
 * id/kind/title/state/spineRole/assignee/severity/priority). ONLY the DetailPanel
 * prose block renders `summary`, and it now fetches the selected row's FULL detail
 * on demand via the `workItems.detail` query.
 *
 * So this projection drops `summary` from the LIST rows at the SYNC RESOLVER
 * boundary ONLY, leaving the shared loader + the /api HTTP route (pui TUI)
 * untouched — the same "slim at the UI boundary, never the shared loader" pattern
 * as coord-ui-projection.ts. Every other (light) field is kept verbatim, and the
 * list `_meta` (the authoritative total on row[0]) is preserved.
 */

/**
 * Drop the heavy `summary` from each work-item list row (the grid never shows it;
 * DetailPanel loads it on demand via workItems.detail). A non-array passes
 * through defensively; row[0]._meta (the list total) rides along untouched.
 */
export function projectWorkItemsListForUi(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return rows as unknown[];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    // Keep the key present (consumers type summary as string) but empty, so the
    // wire cost is a few bytes instead of hundreds; _meta and every other field
    // are preserved by the spread.
    return { ...(row as Record<string, unknown>), summary: '' };
  });
}
