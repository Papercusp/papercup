import { DISPLAY_TERMINAL_LAUNCH } from '../../../adv-sessions';

/**
 * The shape bootstrap-su reads when deciding whether a PRE-PINNED coord owner id
 * (`psu --owner-id=…`) may be used: every un-ended `adv_sessions` row currently
 * carrying that id.
 */
export type PrePinnedOwnerRow = {
  id: string;
  display: string | null;
  has_session: boolean;
};

/**
 * Split the live rows for a pre-pinned owner into the launcher's own PRECURSOR
 * rows and genuine CONFLICTS.
 *
 * A precursor is the starting row `launch-su` writes for the very launch that is
 * now booting (WI-6376: `display='terminal'`, no `session_id` yet, so the board can
 * render the session during its boot window). bootstrap-su ADOPTS it instead of
 * inserting a second row. A conflict is anything else — which is the split-identity
 * case the freshness guard exists to refuse (WI-5002/EI-13277).
 *
 * ⚠ Why this is ONE pass and not two filters. The original shape was:
 *
 *     const precursors = live.filter(isPrecursor);
 *     const conflicts  = live.filter((r) => !precursors.includes(r));
 *
 * which quietly requires that iterating the query result TWICE yields the SAME
 * object references. Nothing in the data promises that — it is a property of the
 * driver. postgres.js satisfies it today, but this pool is reached through the
 * `withWorkspace` acquire seam, and any lazily-mapped, proxied, or instrumented
 * result would hand back fresh objects on the second traversal. `includes` would
 * then miss for EVERY row, every precursor would be reclassified as a conflict, and
 * psu would be refused adoption of its own starting row — the exact owner-facing
 * symptom of WI-37743 ("+ New session" dies with "its terminal closed before the
 * session came online"), reappearing with no code change to blame.
 *
 * Classifying by VALUE in a single pass cannot express that bug. Note the branches
 * are exhaustive on purpose: every row lands in exactly one bucket, so a row can
 * never be silently dropped from both.
 */
export function classifyPrePinnedOwnerRows<T extends PrePinnedOwnerRow>(
  live: Iterable<T>,
): { precursors: T[]; conflicts: T[] } {
  const precursors: T[] = [];
  const conflicts: T[] = [];
  for (const row of live) {
    if (row.display === DISPLAY_TERMINAL_LAUNCH && !row.has_session) precursors.push(row);
    else conflicts.push(row);
  }
  return { precursors, conflicts };
}

/**
 * The per-row evidence appended to a refusal, e.g.
 * `14746(display=terminal,session=bound)`.
 *
 * The refusal is launch-blocking and owner-visible (psu prints it, and since
 * WI-37841 it lands in `~/.papercusp/psu-launch-logs/<owner>.log`), so it must
 * explain ITSELF. Naming only a row id cost a full forensic session on WI-37858:
 * the row named in the message satisfied the precursor predicate by the time anyone
 * read it, leaving no way to tell a real conflict from a misclassified precursor.
 */
export function describePrePinnedConflicts(conflicts: readonly PrePinnedOwnerRow[]): string {
  return conflicts
    .map((c) => `${c.id}(display=${c.display ?? 'null'},session=${c.has_session ? 'bound' : 'none'})`)
    .join(', ');
}
