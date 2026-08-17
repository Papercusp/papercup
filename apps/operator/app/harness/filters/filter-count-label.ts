/**
 * filterCountLabel — the ONE count label every filterable pane renders beside its
 * filter bar.
 *
 * Lifted verbatim (plus a `noun`) out of WorkItemsPanel, where it shipped as
 * `workItemCountLabel`, because the Learning tab was asked to "mimic how it works
 * in the work queue in the work tab" [owner 2026-08-17] and three of its panes had
 * each hand-rolled a DIFFERENT label. It lives beside `useColumnFilters` /
 * `ColumnFilterBar` because it is the third member of that contract: the hook owns
 * the filter state, the bar renders the controls, and this states the RESULT.
 *
 * The rule, unchanged from the Work Queue's original comment:
 *
 *   Users care about the STORE total, not how many rows happen to be in memory
 *   right now — infinite scroll loads the rest on demand — so the label always
 *   reports the true `total` (row[0]._meta.total, the DB count), never the
 *   downloaded length. There is no "loaded of total" / capped distinction:
 *   unfiltered shows "1821 items"; a filter/search shows "N of total match".
 *
 * ⚠ THE PRECONDITION, and why a caller may not adopt this label alone. "N of
 * total" is only true if the filter can actually REACH `total` — i.e. the pane
 * grows its fetch window (`onEndReached` → a larger `limit`, or the next cursor)
 * until the client holds the whole store. A pane that filters ONE fixed page and
 * prints this label reports a page-scoped numerator against a corpus denominator,
 * which is exactly the bug this helper was extracted to kill: Observations
 * rendered "10 observations match, of 36,096 total" for a search whose real answer
 * was 305, because it had searched 200 rows. So: adopt the growing window and this
 * label together, or neither.
 *
 * Pure — no React, no I/O. Exported for tests.
 */

export interface FilterCountLabel {
  /** Compact form for a tab/panel title — "42 of 905" or "1821". */
  title: string;
  /** Prose form for the in-pane badge — "42 of 905 match" or "1821 items". */
  summary: string;
}

/**
 * @param shown   rows surviving the column filters + quick-search
 * @param total   the TRUE store count (readListTotal(rows) — row[0]._meta.total)
 * @param filtered whether any filter/search is currently active
 * @param noun    singular noun for the unfiltered form ("item" → "1821 items")
 */
export function filterCountLabel(
  shown: number,
  total: number,
  filtered: boolean,
  noun = 'item',
): FilterCountLabel {
  if (filtered) {
    return { title: `${shown} of ${total}`, summary: `${shown} of ${total} match` };
  }
  return { title: `${total}`, summary: `${total} ${noun}${total === 1 ? '' : 's'}` };
}
