/**
 * forced-past-stamp.ts — record on the plan that a ship was FORCED past the
 * acceptance gate's code-truth checks.
 *
 * WHY. `plan-acceptance-gate.ts` returns `forcedPast` whenever an explicit
 * `force:{ reason }` waived one or more code-truth checks (D-003/D-005), and its
 * own contract says of that field: "The caller stamps this on the plan so the
 * waiver is permanent and visible, never a silent bypass — a force that is easy
 * to hide is worth very little."
 *
 * Nothing stamped it. `set-plan-status.ts` read only `gate.satisfied` /
 * `gate.code` / `gate.message` / `gate.rubricId`, so a forced ship succeeded and
 * left the plan indistinguishable from one that passed the gate honestly. That
 * is the exact failure the gate's comment names: the waiver was easy to hide, so
 * it was worth very little. A reader (or an auditor asking "was this plan ever
 * really audited?") had no surface to consult.
 *
 * WHERE THE STAMP LIVES, and why not the `## Now` block. The Now block is the
 * most-read field on a plan, but it is also REWRITABLE — `plans:set-now`
 * replaces it wholesale, and `stampTerminalNowBlock` rewrites it on every
 * terminal flip. A waiver parked there is one ordinary write away from being
 * erased, which fails the "permanent" half of the contract. So the waiver gets
 * its own append-only section that no existing writer touches.
 *
 * APPEND-ONLY, never rewrite. Each force is a distinct historical event: a plan
 * forced twice must show both, because "which checks were waived, and why" is
 * not answerable from the latest waiver alone. Re-running the SAME call is still
 * idempotent (an identical entry is not appended twice), so the caller's own
 * idempotent-re-application path cannot inflate the history.
 *
 * Pure — no I/O, no clock beyond the injected `today` — so callers splice the
 * result into the same locked write as the status flip and the waiver can never
 * disagree with the status it waived, not even transiently.
 */

/** Heading of the append-only waiver log. */
export const FORCED_PAST_SECTION_HEADING = '## Acceptance waiver';

/** Shape returned by the acceptance gate when a force waived checks. */
export interface ForcedPastRecord {
  reason: string;
  checks: readonly string[];
}

/**
 * Flatten caller free-text to a single safe markdown line.
 *
 * The reason is arbitrary caller input landing in a markdown document, so it is
 * neutralised rather than trusted: newlines collapse (a multi-line reason must
 * not fragment the entry into sibling blocks) and leading `#`/`-` are defanged
 * so a reason can never forge a heading or a sibling list entry — i.e. cannot
 * fabricate a SECOND waiver, or a section that outranks this one.
 */
function flattenReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(no reason given)';
  return oneLine.replace(/^[#>\-*\s]+/, '').trim() || '(no reason given)';
}

/**
 * Render the single log entry for one waiver event.
 *
 * Exported so tests — and any future reader/parser of the log — agree on the
 * shape by construction instead of by a duplicated literal.
 */
export function forcedPastEntry(forcedPast: ForcedPastRecord, today: Date = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  const checks = [...forcedPast.checks].sort();
  const rendered = checks.length > 0 ? checks.map((c) => `\`${c}\``).join(', ') : '(none recorded)';
  return `- **${iso}** — shipped past ${rendered}. Reason: ${flattenReason(forcedPast.reason)}`;
}

/**
 * Return the plan body with the waiver appended, or `null` when there is nothing
 * to do:
 *   - no waiver (the ship passed the gate honestly — the common case)
 *   - the waiver has no waived checks (a `force` that waived nothing is not a
 *     bypass, so recording one would overstate what happened)
 *   - this exact entry is already present (idempotent re-application)
 */
export function stampForcedPastWaiver(
  body: string,
  forcedPast: ForcedPastRecord | undefined | null,
  today: Date = new Date(),
): string | null {
  if (!forcedPast) return null;
  if (!Array.isArray(forcedPast.checks) || forcedPast.checks.length === 0) return null;

  const entry = forcedPastEntry(forcedPast, today);
  // Idempotency is per-ENTRY, not per-section: a second, genuinely different
  // waiver must still append beneath an existing heading.
  if (body.includes(entry)) return null;

  const trimmed = body.replace(/\s+$/, '');
  if (trimmed.includes(FORCED_PAST_SECTION_HEADING)) {
    // The section exists — append this entry to the END of the document. The
    // heading is append-only and nothing writes below it, so document-end IS
    // the end of the log.
    return `${trimmed}\n${entry}\n`;
  }

  const preamble =
    `_This plan was shipped without fully satisfying the acceptance gate. Each entry records ` +
    `an explicit, reasoned waiver — what was skipped, and why — so the exception stays visible ` +
    `to anyone who later treats this plan as evidence that the work was verified._`;

  return `${trimmed}\n\n${FORCED_PAST_SECTION_HEADING}\n\n${preamble}\n\n${entry}\n`;
}
