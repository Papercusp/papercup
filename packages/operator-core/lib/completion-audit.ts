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
