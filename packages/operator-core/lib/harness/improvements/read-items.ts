/**
 * read-items.ts — the SINGLE repointable seam between the self-improvement loop
 * and the work-unit storage (papercusp-self-improvement-loop-2026-06-04 +
 * close-the-self-improvement-loop-2026-06-05 D-002).
 *
 * The capture unit is an `engineer_issue` = work_item[kind ∈ bug|change]
 * (unify-work-items migration 142/152). The loop reads candidates through
 * `readImprovementItems`, so any future storage move stays a one-function repoint.
 *
 * `kind` is the REAL `engineer_issues.kind` column now (close-loop D-002) — the
 * old `[kind]` title-prefix convention + its `deriveKind` parser are RETIRED
 * (legacy prefixed rows were backfilled + stripped by the close-loop migration).
 * Two payload refinements ride `engineer_issues.payload`:
 *   - `improvementKind: 'feature'` — a net-new capture (display refinement of
 *     kind='change'; the feature *family* lives in the features base table).
 *   - `paths: string[]` — candidate implementation paths (the protected-path gate).
 *   - `implementAttempts` / `needsHuman` — the auto-implement loop's lifecycle
 *     (anti-re-dispatch counter + the explicit human-routing flag, D-001).
 */

import { listIssues, type EngineerIssue, type ListIssuesFilter } from '../../issues-engineer';
import type { ImprovementCandidate, WorkItemKind } from './policy';

/** The built-in capture/triage lens topic (D-003). */
export const IMPROVEMENT_TOPIC = 'papercusp-improvement';

/** Typed view over the kind-specific payload the improvement loop writes. */
interface ImprovementPayload {
  improvementKind?: string;
  paths?: unknown;
  implementAttempts?: unknown;
  needsHuman?: unknown;
  /** One-line "already decided: <reason>" recall for the recurrence matcher
   *  (self-learning P-003) — set when an item is resolved/closed with a durable
   *  rationale worth recalling on the next same-signature capture. */
  decidedReason?: unknown;
}

function payloadOf(issue: EngineerIssue): ImprovementPayload {
  return issue.payload && typeof issue.payload === 'object' ? (issue.payload as ImprovementPayload) : {};
}

/** Map an engineer_issue → the storage-agnostic ImprovementCandidate. */
export function issueToCandidate(issue: EngineerIssue): ImprovementCandidate {
  const p = payloadOf(issue);
  const kind: WorkItemKind = p.improvementKind === 'feature' ? 'feature' : (issue.kind as WorkItemKind);
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : undefined;
  const attempts = typeof p.implementAttempts === 'number' ? p.implementAttempts : undefined;
  const decidedReason = typeof p.decidedReason === 'string' && p.decidedReason.trim() ? p.decidedReason : undefined;
  return {
    id: issue.id,
    kind,
    scope: issue.scope,
    title: issue.title,
    body: issue.body,
    severity: issue.severity,
    state: issue.state,
    assignee: issue.assignee,
    assignedAt: issue.assignedAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(paths?.length ? { paths } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(p.needsHuman === true ? { needsHuman: true } : {}),
    ...(decidedReason ? { decidedReason } : {}),
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
 * storage-agnostic candidates. THE repoint point for any future storage move.
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
