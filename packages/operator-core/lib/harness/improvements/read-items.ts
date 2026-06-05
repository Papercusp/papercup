/**
 * read-items.ts — the SINGLE repointable seam between the self-improvement loop
 * and the work-unit storage (papercusp-self-improvement-loop-2026-06-04).
 *
 * Today the capture unit is an `engineer_issue` (issues:*). After
 * unify-work-items-2026-06-04 lands, it becomes a `work_item[kind=bug|change]`.
 * EVERYTHING in the loop reads candidates through `readImprovementItems` so the
 * migration is a ONE-FUNCTION repoint here — swap `listIssues({topic})` for
 * `work_items:list({topic, kind})` and read the native `kind` column instead of
 * the title-prefix derivation below. (Coordinated with su-0cbc6, the
 * unify-work-items owner: topic tags survive the migration on the capability
 * layer, and the read stays topic-scoped.)
 *
 * `kind` derivation TODAY: engineer_issues has no `kind` column (it's
 * severity/source/state). The capture convention prefixes the title with
 * `[bug]` / `[change]` / `[feature]`; we parse that, defaulting to `change` (the
 * "a desired improvement" kind — human-tier, the safe default). When the real
 * `kind` column exists, delete `deriveKind` and read the column.
 */

import { listIssues, type EngineerIssue, type ListIssuesFilter } from '../../issues-engineer';
import type { ImprovementCandidate, WorkItemKind } from './policy';

/** The built-in capture/triage lens topic (D-003). */
export const IMPROVEMENT_TOPIC = 'papercusp-improvement';

const KIND_PREFIX = /^\s*\[(bug|change|feature|research-task)\]\s*/i;

/** Parse a `[kind]` title prefix → { kind, cleanTitle }. Default kind = change. */
export function deriveKind(title: string): { kind: WorkItemKind; cleanTitle: string } {
  const m = title.match(KIND_PREFIX);
  if (m) {
    return { kind: m[1].toLowerCase() as WorkItemKind, cleanTitle: title.replace(KIND_PREFIX, '').trim() };
  }
  return { kind: 'change', cleanTitle: title.trim() };
}

/** Map an engineer_issue → the storage-agnostic ImprovementCandidate. */
export function issueToCandidate(issue: EngineerIssue): ImprovementCandidate {
  const { kind, cleanTitle } = deriveKind(issue.title);
  return {
    id: issue.id,
    kind,
    scope: issue.scope,
    title: cleanTitle,
    body: issue.body,
    severity: issue.severity,
    state: issue.state,
    assignee: issue.assignee,
    createdAt: issue.createdAt,
  };
}

export interface ReadImprovementOpts {
  /** Restrict to a lifecycle state (default: all states, so rollups + dedup see resolved too). */
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
}

/** Injectable dependency seam so the adapter is unit-testable without PG. */
export interface ReadImprovementDeps {
  listIssues: (filter: ListIssuesFilter) => Promise<EngineerIssue[]>;
}

const defaultDeps: ReadImprovementDeps = { listIssues };

/**
 * Read every captured improvement (tagged the `papercusp-improvement` topic) as
 * storage-agnostic candidates. THE repoint point for unify-work-items.
 */
export async function readImprovementItems(
  opts: ReadImprovementOpts = {},
  deps: ReadImprovementDeps = defaultDeps,
): Promise<ImprovementCandidate[]> {
  const issues = await deps.listIssues({
    topic: IMPROVEMENT_TOPIC,
    state: opts.state,
    limit: opts.limit ?? 500,
  });
  return issues.map(issueToCandidate);
}
