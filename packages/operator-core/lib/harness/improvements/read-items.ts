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
import { isSignalOrigin, originAllowed, ORGANIC_ONLY, type SignalOrigin } from './provenance';

/** The built-in capture/triage lens topic (D-003). */
export const IMPROVEMENT_TOPIC = 'papercusp-improvement';

/**
 * The observation-lane topic (turn-end-reflection-observations-2026-06-14 D-005).
 * Observations are PRE-IDEAS — a turn-end reflection's sensor reading. They reuse
 * the engineer_issues store but are tagged THIS distinct topic, so they are
 * invisible to every `topic: IMPROVEMENT_TOPIC` reader (the digest, triage, the
 * auto-implement lane, the `/adv/create` improvement facet) BY CONSTRUCTION — no
 * per-consumer exclusion filter to maintain. The ONLY consumers are Scout's
 * corpus-digest (via `readObservationItems`, unioned into the friction lane) and
 * the browse-only Observations pane. An observation reaches work solely by Scout
 * clustering a RECURRING one and promoting it to a real `improvements:capture`
 * idea — a one-off reflection can never enter the work queue.
 */
export const OBSERVATION_TOPIC = 'papercusp-observation';

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
  /** P-010 source-tag: Queen, bee, system, or human — tracks who filed this improvement. */
  sourceRole?: unknown;
  /** Idea-lifecycle journey (self-learning P-030/P-031) — written by capture/triage-core/resolve-core/decay. */
  ideaLifecycle?: unknown;
  /** Stable watchdog signal identity ('<source>:<key>' — watchdog-audit P-004). */
  watchdogKey?: unknown;
  /** Machine-readable finding class ('<miner>:<shape>' — frontier P-044/D-008). */
  findingClass?: unknown;
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
  const sourceRole = typeof p.sourceRole === 'string' ? (p.sourceRole as 'Queen' | 'bee' | 'system' | 'Scout' | 'human') : undefined;
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
    ...(sourceRole ? { sourceRole } : {}),
    ...(isIdeaLifecycle(p.ideaLifecycle) ? { ideaLifecycle: p.ideaLifecycle } : {}),
    ...(typeof p.watchdogKey === 'string' && p.watchdogKey ? { watchdogKey: p.watchdogKey } : {}),
    ...(typeof p.findingClass === 'string' && p.findingClass ? { findingClass: p.findingClass } : {}),
    ...(isSignalOrigin(issue.signalOrigin) ? { origin: issue.signalOrigin } : {}),
  };
}

/** Narrow an unknown payload field to the lifecycle shape (cheap structural check). */
function isIdeaLifecycle(v: unknown): v is import('./lifecycle').IdeaLifecyclePayload {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { state?: unknown }).state === 'string' &&
    typeof (v as { stateUpdatedAt?: unknown }).stateUpdatedAt === 'string'
  );
}

export interface ReadImprovementOpts {
  /** Restrict to a lifecycle state (default: all states, so rollups + dedup see resolved too). */
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
  /** (P-010) Restrict to a specific harness scope. Omit for all scopes (papercusp + all harnesses). */
  harnessSlug?: string;
  /**
   * Signal-provenance allowlist (frontier P-002/D-002). DEFAULT: organic only —
   * synthetic rows (drill/replay/shadow) never reach a learning consumer unless
   * it explicitly opts in here (e.g. the vaccination measurement loop passes
   * ['drill']; an all-origins inspection read passes SIGNAL_ORIGINS).
   */
  origins?: readonly SignalOrigin[];
}

/** Injectable dependency seam so the adapter is unit-testable without PG. */
export interface ReadImprovementDeps {
  listIssues: (filter: ListIssuesFilter) => Promise<EngineerIssue[]>;
}

const defaultDeps: ReadImprovementDeps = { listIssues };

/**
 * Read every captured improvement (tagged the `papercusp-improvement` topic) as
 * storage-agnostic candidates. THE repoint point for any future storage move.
 * (P-010) Supports per-Hive scope filtering via harnessSlug.
 */
export async function readImprovementItems(
  opts: ReadImprovementOpts = {},
  deps: ReadImprovementDeps = defaultDeps,
): Promise<ImprovementCandidate[]> {
  return readByTopic(IMPROVEMENT_TOPIC, opts, deps);
}

/**
 * Read observation-lane records (turn-end-reflection-observations-2026-06-14
 * D-005) as storage-agnostic candidates. Separate topic from
 * `readImprovementItems` so observations NEVER enter the work/triage pipeline —
 * the ONLY callers are Scout's corpus-digest (unioned into the friction lane,
 * P-021) and the Observations pane's sync resolver (P-044).
 */
export async function readObservationItems(
  opts: ReadImprovementOpts = {},
  deps: ReadImprovementDeps = defaultDeps,
): Promise<ImprovementCandidate[]> {
  return readByTopic(OBSERVATION_TOPIC, opts, deps);
}

/** Shared body for the topic-scoped candidate readers (improvement + observation). */
async function readByTopic(
  topic: string,
  opts: ReadImprovementOpts,
  deps: ReadImprovementDeps,
): Promise<ImprovementCandidate[]> {
  const origins = opts.origins ?? ORGANIC_ONLY;
  const issues = await deps.listIssues({
    topic,
    state: opts.state,
    limit: opts.limit ?? 500,
    signalOrigins: origins,
  });

  // Origin gate (frontier P-002/D-002): enforced HERE as well as in the SQL
  // filter above, so an injected/legacy listIssues that ignores signalOrigins
  // still can't leak a synthetic row into an organic consumer. Exact-match
  // allowlist — junk values fail closed; a row with NO origin reads organic
  // (the migration-DEFAULT backfill semantics, see provenance.ts).
  const originGated = issues.filter((issue) => originAllowed(issue.signalOrigin, origins));

  // (P-010) Filter by scope if harnessSlug is specified
  if (opts.harnessSlug) {
    const targetScope = `harness:${opts.harnessSlug}`;
    return originGated
      .filter(issue => issue.scope === targetScope)
      .map(issueToCandidate);
  }

  return originGated.map(issueToCandidate);
}
