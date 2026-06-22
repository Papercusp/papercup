/**
 * list-meta — the "carry page metadata on a flat sync read" convention, in one
 * place. Pure (no React, no PG) so the SERVER resolver and the CLIENT panel both
 * import it.
 *
 * Why it exists: every `useSyncQuery` resolver returns a BARE array (the flat-row
 * sync contract — no `{rows,total}` envelope). So a capped read (`LIMIT n`) has no
 * channel to tell the UI the TRUE total, and panels end up showing the downloaded
 * length as if it were the total (e.g. "(300)" when 404 exist). The fix is to
 * stash the metadata on the FIRST row's `_meta` — the array stays a flat array,
 * but row[0] carries `{ total }`. `coord.feed` pioneered this; these helpers make
 * it reusable and symmetric (attach on the server, read on the client).
 *
 * Usage (server, in a resolver):
 *   const [rows, total] = await Promise.all([listX({limit}), countX()]);
 *   return attachListMeta(rows, { total });
 *
 * Usage (client, in a panel):
 *   const total = readListTotal(items);                 // the true count
 *   api.setTitle(`X (${listCountLabel(items.length, total)})`);  // "N" or "N of TOTAL"
 */

/** Page metadata stashed on the first row. `total` = the true store count for the
 *  read's filter, independent of any LIMIT. Open-ended for future fields. */
export interface ListMeta {
  total?: number;
  [k: string]: unknown;
}

/** A row that MAY carry list metadata (only row[0] does, by convention). */
export type WithListMeta<T> = T & { _meta?: ListMeta };

/**
 * Stash `meta` on the first row's `_meta` (merging with any existing `_meta`),
 * preserving the flat-array contract. No-op (returns the same array) when empty —
 * an empty read has nothing to carry metadata on, and the client falls back to a
 * length of 0. Does not mutate the input rows (clones row[0]).
 */
export function attachListMeta<T extends object>(rows: T[], meta: ListMeta): T[] {
  if (rows.length === 0) return rows;
  return rows.map((r, i) =>
    i === 0 ? { ...r, _meta: { ...(r as WithListMeta<T>)._meta, ...meta } } : r,
  );
}

/** Read the metadata stashed on row[0], or undefined when absent. */
export function readListMeta<T extends object>(
  rows: ReadonlyArray<WithListMeta<T>> | null | undefined,
): ListMeta | undefined {
  return rows && rows.length > 0 ? rows[0]._meta : undefined;
}

/**
 * The true total for the read. Prefers `_meta.total`; falls back to the
 * downloaded length (so a resolver that doesn't attach a total still yields a
 * sensible number, just not a capped-aware one).
 */
export function readListTotal<T extends object>(
  rows: ReadonlyArray<WithListMeta<T>> | null | undefined,
): number {
  if (!rows) return 0;
  return readListMeta(rows)?.total ?? rows.length;
}

/**
 * Honest count label: "N of TOTAL" when the read was capped (total exceeds the
 * shown rows), else just the total. Never lets the downloaded length read as the
 * total. `shown` is the rendered/filtered row count; `total` the true store count
 * (from `readListTotal`).
 */
export function listCountLabel(shown: number, total: number | undefined): string {
  return total != null && total > shown ? `${shown} of ${total}` : `${total ?? shown}`;
}
