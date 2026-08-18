/**
 * bounded-list-read.ts — the rows+count read, BOUNDED once for every list
 * resolver that does it (WI-39825).
 *
 * ## The shape this replaces
 *
 * A paged list resolver reads twice: a LIMITed window of rows, and an unlimited
 * `count(*)` for the same filter, so the UI can say "N of TOTAL" instead of
 * mistaking the page length for the store (`attachListMeta` / `readListTotal`).
 * Both legs go out under one `Promise.all`, which waits for the slowest — so a
 * wedged COUNT, the leg the view can perfectly well live without, took the whole
 * list past the sync layer's `RESOLVER_READ_TIMEOUT_MS` and the panel rendered
 * nothing. Three resolvers had hand-written copies of that fan-out; this is the
 * one place it now lives.
 *
 * ## Why a shared helper rather than three extractions
 *
 * The other sites in this class each got their own `*-read.ts` module, because a
 * budget can only be proved to fire by MOVING it and a resolver's only input is
 * its wire `argsSchema` — so the knob has to be a function parameter somewhere
 * off the wire. That reasoning applies to the PATTERN as readily as to a site:
 * with the fan-out extracted here, `budgetMs` is a parameter on THIS function,
 * the deadline is guarded once in `bounded-list-read.test.ts`, and each call
 * site collapses to passing two promises and a label. Guarding N copies of a
 * fan-out proves the same fact N times; guarding the fan-out proves it once and
 * leaves the sites with nothing left to get wrong.
 *
 * ## The count leg's failure mode is the whole reason this is careful
 *
 * `readListTotal()` falls back to the PAGE LENGTH when no total is carried, and
 * the pre-existing hand-written copies coded that fallback themselves
 * (`totalRows[0]?.n ?? rows.length`). So a failed count did not render as
 * "unknown" — it rendered as a CONFIDENT WRONG TOTAL equal to the window size:
 * a 27,514-row corpus reporting exactly "500 of 500" and a UI with no way to
 * tell that from a store that really holds 500. A lapsed or failed count
 * therefore sets `_meta.totalUnavailable` and never substitutes the page length;
 * that flag is why it exists.
 */

import { attachListMeta } from './list-meta';
import { createReadDeadline } from './read-deadline';
import { reasonOf } from './degraded-snapshot';

/**
 * Deadline for a rows+count fan-out — the budget the other bounded reads carry
 * (see `adv-roster-read.ts` for the measurement), and, as there, deliberately
 * under the sync layer's `RESOLVER_READ_TIMEOUT_MS` ceiling: a budget at or
 * above it cannot prevent the timeout it exists to prevent.
 */
export const LIST_READ_BUDGET_MS = 6_000;

export interface BoundedListRead<Row extends object> {
  /**
   * The LIMITed window. A lapse or failure PROPAGATES — the rows ARE the list,
   * and an empty list is not a degraded answer but a wrong one.
   */
  rows: Promise<Row[]>;
  /**
   * The true corpus total for the same filter, unscoped by the window's LIMIT.
   * A lapse or failure is SOFT: the rows still ship, flagged
   * `_meta.totalUnavailable`. Resolve `null` to say "no total" deliberately.
   */
  count: Promise<number | null | undefined>;
  /**
   * Prefix for the two deadline labels (`<label> rows` / `<label> count`) and
   * the degraded-count warning. Name the QUERY, e.g. `'workItems.byHarness'` —
   * a bare timeout that cannot say which leg wedged is the first thing anyone
   * triaging this needs and the reason the labels are mandatory.
   */
  label: string;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so the guard can prove the deadline fires without waiting
   * {@link LIST_READ_BUDGET_MS} out. Defaults to {@link LIST_READ_BUDGET_MS}.
   */
  budgetMs?: number;
}

/**
 * Run a rows+count list read under one shared deadline and return the rows with
 * their list `_meta` attached.
 *
 * Rejects only when the rows leg fails or lapses. A failed count degrades to
 * `_meta.totalUnavailable` — never to the page length.
 */
export async function readBoundedList<Row extends object>(
  read: BoundedListRead<Row>,
): Promise<Row[]> {
  const { rows, count, label, budgetMs = LIST_READ_BUDGET_MS } = read;
  const withinBudget = createReadDeadline(budgetMs);
  const [rowList, total] = await Promise.all([
    withinBudget(rows, `${label} rows`),
    withinBudget(count, `${label} count`).catch((err) => {
      // Logged, not swallowed: a total that silently stops being carried is
      // invisible from the payload alone, since its absence is also what a
      // genuinely-empty read looks like.
      console.warn(`[${label}] count read failed:`, reasonOf(err));
      return null;
    }),
  ]);
  return attachListMeta(
    rowList,
    total == null ? { totalUnavailable: true } : { total },
  );
}
