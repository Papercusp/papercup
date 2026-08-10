/**
 * doc-section-anchor — the continuation-chunk convention for
 * `harness_shared.doc_sections.anchor`.
 *
 * A doc section longer than the per-row cap is stored as SEVERAL rows so its
 * tail is embedded (and therefore matchable) instead of sliced off. The table's
 * primary key is (source_key, slug, anchor), so those sibling rows need
 * distinct anchors — but `anchor` is ALSO the navigation target a caller gets
 * back (docs:get accepts it as `heading`). Those two jobs are reconciled here
 * rather than at each call site:
 *
 *   chunkAnchor('setup', 0) -> 'setup'      (the real heading anchor)
 *   chunkAnchor('setup', 1) -> 'setup~2'    (continuation row, storage only)
 *   sectionAnchorBase('setup~2') -> 'setup' (what a caller may navigate to)
 *
 * `~` is a safe separator because it can never occur in a real anchor:
 * slugifyAnchor collapses every non-`[a-z0-9]` run to `-`, so its output is
 * drawn from `[a-z0-9-]` alone. A continuation anchor is therefore
 * unambiguously distinguishable from a heading anchor that happens to end in a
 * digit ('step-2' is a real heading; 'step~2' is a chunk of 'step').
 *
 * Kept dependency-free and separate from doc-embed-sync so the READ side
 * (semantic-leg) can strip a suffix without importing the sync module's PG +
 * module-singleton surface.
 */

/** Separator between a heading anchor and its continuation index. */
export const CHUNK_ANCHOR_SEP = '~';

/**
 * The stored anchor for chunk `index` (0-based) of the section anchored at
 * `anchor`. Chunk 0 keeps the bare heading anchor, so a page whose sections all
 * fit under the cap produces byte-identical anchors to the pre-chunking
 * splitter — the common case is untouched.
 */
export function chunkAnchor(anchor: string, index: number): string {
  return index === 0 ? anchor : `${anchor}${CHUNK_ANCHOR_SEP}${index + 1}`;
}

/**
 * The navigable heading anchor behind a stored anchor — the inverse of
 * chunkAnchor, and a no-op on an anchor that carries no continuation suffix.
 * Call this on ANY anchor read out of doc_sections before handing it to a
 * caller as a link target.
 */
export function sectionAnchorBase(anchor: string): string {
  const i = anchor.lastIndexOf(CHUNK_ANCHOR_SEP);
  return i === -1 ? anchor : anchor.slice(0, i);
}

/** True when this row is a continuation chunk rather than a heading's first row. */
export function isContinuationAnchor(anchor: string): boolean {
  return anchor.includes(CHUNK_ANCHOR_SEP);
}
