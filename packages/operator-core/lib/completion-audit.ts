/**
 * completion-audit — the ONE predicate both work-item families use to answer
 * "was this unit actually verified, or did it just assert done?" (EI-10867).
 *
 * ## The bug this exists to prevent
 *
 * `work_items:list { audit: 'no-evidence' }` is the DRAIN leader's stale-done
 * spot-audit — the check that is supposed to catch a unit closed on a bare
 * assertion. It keyed on `terminal_completion_ref IS NULL`.
 *
 * But `terminal_completion_ref` is not evidence. It is the completion-integrity
 * gate's OWN bookkeeping: `setWorkItemState` / `setIssueState` REJECT any terminal
 * transition that does not carry a `completionRef`, and `work_items:complete`
 * auto-fills it from `completion.summary`. So for every item closed through the
 * sanctioned path the column is non-null BY CONSTRUCTION — regardless of whether
 * the agent ever said how (or whether) it verified anything.
 *
 * The audit was therefore structurally incapable of returning the thing it is named
 * for. Measured on the live store when this was found: of 5,979 terminal rows
 * carrying a completion ref, 4,119 (69%) had NO structured verification evidence at
 * all, and the audit reported every one of them as clean. The leader who ran it saw
 * an empty list and concluded the fleet's completions were sound. A completion-
 * integrity check with a 69% false-negative rate is worse than none: it launders
 * unverified work as audited.
 *
 * The root cause is a classic write/read split-brain: the WRITERS agreed on
 * `payload._completionEvidence` (declared twice, privately, in work-items.ts and
 * issues-engineer.ts) while the READER keyed on a different column entirely. Nothing
 * forced them to agree. Now one module owns the key AND the predicate, and both
 * families import it — so a write and an audit cannot drift apart again.
 */

import { getOrgPg } from '@papercusp/db-org';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from './coord-lifecycle/records';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * The completion-integrity audits. Two DISTINCT defects — keep both:
 *
 *  - `no-evidence` — terminal, but no structured verification evidence
 *    (`payload._completionEvidence` absent). The unit asserted done without ever
 *    stating HOW it was verified. This is the stale-done close, and the common case.
 *
 *  - `no-completion-record` — terminal with `terminal_completion_ref IS NULL`: a bare
 *    `set_state` close that bypassed the completion path altogether (this was the OLD
 *    `no-evidence` predicate). Rarer, and mostly pre-gate legacy rows — but a real and
 *    separate defect, so it keeps its own name instead of being silently dropped.
 */
export const COMPLETION_AUDITS = ['no-evidence', 'no-completion-record'] as const;
export type CompletionAudit = (typeof COMPLETION_AUDITS)[number];

/**
 * The audit's WHERE fragment. Callers AND it with their own terminal-state predicate
 * (the two families spell their state column differently — `status` vs `state`).
 *
 * `payload ? key` is the jsonb key-existence operator; both payload columns are jsonb
 * (verified against information_schema), and a NULL payload correctly fails the test,
 * so a row that never carried a payload reads as "no evidence" rather than dropping
 * out of the audit.
 */
export function auditPredicateSql(sql: OrgSql, audit: CompletionAudit) {
  return audit === 'no-completion-record'
    ? sql`terminal_completion_ref IS NULL`
    : sql`NOT (COALESCE(payload, '{}'::jsonb) ? ${TERMINAL_COMPLETION_EVIDENCE_KEY})`;
}

/** Same fragment, for a query that aliases the table (e.g. `ei.payload`). */
export function auditPredicateSqlFor(sql: OrgSql, audit: CompletionAudit, alias: string) {
  const col = sql.unsafe(`${alias}.payload`);
  const ref = sql.unsafe(`${alias}.terminal_completion_ref`);
  return audit === 'no-completion-record'
    ? sql`${ref} IS NULL`
    : sql`NOT (COALESCE(${col}, '{}'::jsonb) ? ${TERMINAL_COMPLETION_EVIDENCE_KEY})`;
}

/**
 * EI-13424 — `no-evidence`'s OWN false-positive rate.
 *
 * The predicate above is exact and cheap (it must stay that way — see the module
 * doc), but it answers a narrower question than its name implies: "does this row
 * carry the STRUCTURED `_completionEvidence` key", not "was this work actually
 * verified". `work_items:complete`'s free-text `completion.summary` is exactly where
 * an agent naturally writes real verification detail instead of the structured
 * fields — a cited commit sha, a specific file:line, an observed tool call + its
 * result, a measured test-count ratio, a drillId/session id. Three such completions
 * were nearly RE-OPENED by a DRAIN leader mechanically following the "re-open bare
 * assertions" mandate on every `no-evidence` hit, because the audit has no way to
 * tell "never said how" apart from "said how, in prose".
 *
 * This is a SEPARATE, best-effort SIGNAL — not a replacement for the SQL predicate,
 * and not itself proof of verification. A caller (the DRAIN leader's spot-audit, or
 * any consumer of `work_items:list { audit }`) checks it on each returned row BEFORE
 * acting: `looksLikeCitedProseEvidence(row.terminalCompletionRef)` true means the
 * ref itself cites something a fabricated one-line "done" would not contain, and the
 * row deserves a read before a reopen, not a mechanical one.
 *
 * Deliberately biased toward NOT flagging a ref as evidenced: the harm this exists to
 * prevent is over-detecting BARENESS on well-evidenced prose (the false positive that
 * burns fleet time re-doing verified work and erodes trust in the audit) — so both the
 * length floor and the citation-pattern requirement lean toward the direction that is
 * safe to get wrong here (an under-flagged genuinely-bare close stays correctly
 * flagged with no evidence signal; it is not silently waved through by this function —
 * it is still a `no-evidence` audit hit either way, just without the extra signal).
 */
export const PROSE_EVIDENCE_MIN_LENGTH = 100;

const PROSE_EVIDENCE_PATTERNS: readonly RegExp[] = [
  // A file:line / file(line — a specific source location, e.g. "run.ts:204" or "foo.tsx(12,".
  /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|sql|md|mdx|json|yml|yaml)[:(]\d+/i,
  // A tool call, colon-form, e.g. "session:carry-drill(" or "events:status { event }".
  /\b[a-z][a-z_]*(?::[a-z][a-z_-]*)+\s*[({]/i,
  // A measured test-count ratio, e.g. "9/9 green" or "26/26 passed".
  /\b\d{1,4}\s*\/\s*\d{1,4}\b/,
  // A uuid / drillId.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  // A commit sha (7+ hex chars) — long enough that a plain word collision is very rare.
  /\b[0-9a-f]{7,40}\b/i,
  // An ISO timestamp, e.g. "2026-07-17T03:2".
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
];

/**
 * Does this completion ref look like it cites verifiable evidence, despite carrying
 * no structured `_completionEvidence`? Pure, synchronous, no I/O — see the doc above
 * for what this is (a caller-facing signal) and is NOT (proof, or a replacement for
 * the SQL predicate).
 */
export function looksLikeCitedProseEvidence(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const text = ref.trim();
  if (text.length < PROSE_EVIDENCE_MIN_LENGTH) return false;
  return PROSE_EVIDENCE_PATTERNS.some((re) => re.test(text));
}

/**
 * EI-18676290701611705 — the synthetic `terminal_completion_ref` ANY `skipCompletionGate`
 * bypass stamps when the caller supplied none. `skipCompletionGate` exists for a small,
 * TRUSTED set of non-completion transitions (watchdog auto-close, hygiene sweep,
 * orphaned-dispatch reconciliation, a tripwire revert, a bee-exit reconcile) that must
 * NOT claim a genuine completion — by design they call `setWorkItemState`/`setIssueState`
 * with `completionRef` omitted. Before this, that meant the column was written NULL, so
 * the `no-completion-record` audit (`terminal_completion_ref IS NULL`) could fire on a
 * MAJOR, human-filed bug that closed through one of these paths, with nothing left to
 * distinguish "a sanctioned system bypass" from "a bare assertion no one investigated" —
 * exactly the ambiguity a DRAIN leader hit on EI-18673480587329034 (a real, verified fix,
 * closed with both `completion` and `terminal_completion_ref` empty).
 *
 * This is deliberately NOT prose evidence — it names the bypass + the closing actor + a
 * timestamp, so the audit can never again find a bare-NULL ref for a sanctioned system
 * write, while `looksLikeCitedProseEvidence` still correctly reads it as non-evidence
 * (it carries none of the file:line / test-ratio / sha / uuid citation patterns) — a
 * reader can tell at a glance "system bypass, not a real fix" rather than mistaking it
 * for genuine verification.
 */
export function skipGateCompletionRef(by: string | null | undefined): string {
  return (
    `[SYSTEM-BYPASS] non-completion state transition by '${by ?? 'unknown'}' at ${new Date().toISOString()}` +
    ' (skipCompletionGate — not a genuine completion; see work-item-completion-integrity-2026-07-01 WI-1403)'
  );
}

/**
 * Resolve the completionRef to actually WRITE for a terminal transition: the caller's own
 * ref when non-empty, else — ONLY when `skipCompletionGate` is set — the synthetic marker
 * above, so a sanctioned bypass never leaves the column truly empty. Returns the input
 * unchanged (including null/undefined) when the gate is NOT bypassed, matching the existing
 * `completionRef ?? null` write shape exactly for every caller that already enforces the
 * completion-integrity gate before calling this.
 */
export function resolveTerminalCompletionRef(
  completionRef: string | null | undefined,
  opts: { skipCompletionGate?: boolean; by?: string | null },
): string | null | undefined {
  if (completionRef && completionRef.trim()) return completionRef;
  if (opts.skipCompletionGate) return skipGateCompletionRef(opts.by);
  return completionRef;
}
