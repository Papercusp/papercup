/**
 * work-items — the UNIFIED work-item surface (plan unify-work-items-2026-06-04).
 *
 * One `work_item` TYPE discriminated by `kind` (D-001). This module is the canonical
 * code-level interface (D-007: "the type is the API, the table is an implementation
 * detail"); it is a facade over the two per-kind tables the codebase already has
 * (D-010=(b) — per-kind tables behind a unifying surface):
 *
 *   feature-family kinds {feature, research-task, chunk} → harness_features_consolidated
 *   issue-family    kinds {bug, change}                   → engineer_issues
 *
 * Reads MERGE across both tables; writes DISPATCH by kind. New ids are the
 * kind-independent WI-NNN scheme (D-008, allocated from harness_shared.work_item_seq
 * via next_work_item_id()); existing F-NNN / EI-NNN rows keep their ids (the bulk
 * in-place re-id is a supervised, pipeline-drained follow-on — see the plan Risks).
 *
 * Capabilities (D-003) ride the same coord substrate stores issues use — but keyed
 * on the per-family ObjectRef so the unified surface operates on the SAME coord rows
 * as features:* / issues:* (a true facade, not a parallel store):
 *   - issue-family  → ObjectRef {kind:'issue',   ref: id}                  (issues-engineer.ts)
 *   - feature-family→ ObjectRef {kind:'feature',  ref:'<harness>#<id>'}     (issue-blocks-merge.featureRef)
 * Cross-kind blocking (a bug blocks a feature) is a plain coord_links rel='blocks'
 * edge between the two ObjectRefs (D-003) — the substrate keys on (kind, ref), not
 * the physical table, so it works across kinds for free.
 *
 * Fan-out: issue-family writes fan out synchronously via issues-engineer.deliver();
 * feature-family writes fan out + federate via the hfc capture_substrate_outbox CDC
 * trigger (already wired) — so neither path needs an extra fan-out call here.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from './flag-distinct-id';
import { harnessScope, harnessOfScope } from './work-item-scope';
import {
  PgTaggableStore,
  PgThreadStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  LIFECYCLE_STATES,
  type ObjectRef,
  type DeliveryMode,
  type ThreadPostRow,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { activeWorkspaceId } from './workspace-registry';
import { checkAndEscalateSteeringChurn } from './steering-churn';
import { checkSteeringLease, recordSteeringProposal } from './steering-lease';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from './issue-blocks-merge';
import { type InjectEvent } from './agent-tools/coordination/fanout-delivery';
import { fanoutForObject } from './sync/hyperbee/fanout-projection';
import { boundedOrgTxn } from './pg-bounded-txn';
import {
  autoPickableWhereSql,
  isAutoPickable,
  isIssueLocallyClaimable,
  loadTrustedGithubUserIds,
} from './work-items-admission';
import { frontierPlacementKindClause } from './datatype-frontier-placement';
import { hasGenericKind } from './datatype-registry-store';
import {
  FEATURE_NON_REQUEUE_STATES,
  FEATURE_TERMINAL_STATES,
  normalizeFeatureStateInput,
} from './work-item-dispatch-states';
import { ISSUE_TERMINAL_STATUSES } from './work-item-blocking';
import { releaseWorkItemLease } from './work-item-claim-lease-wiring';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';
import {
  ISSUE_KIND,
  type IssueKind,
  type IssueStoreKind,
  type IssueState,
  type IssueSeverity,
  createIssue,
  getIssue,
  getIssueInWorkspace,
  getIssueDetail,
  listIssues,
  countIssues,
  setIssueState,
  claimIssue,
  releaseIssue,
  linkIssue,
  unlinkIssue,
  tagIssue,
  untagIssue,
  subscribeIssue,
  commentIssue,
  updateIssue,
  searchIssues,
  semanticSearchIssues,
  promoteIssue,
  issuesScopeWorkspace,
  mergeIssuePayload,
  markIssueProgress,
  type EngineerIssue,
} from './issues-engineer';

export { markIssueProgress };

// ── Kinds ───────────────────────────────────────────────────────────────────────
export type FeatureFamilyKind = 'feature' | 'chunk';
export type WorkItemKind = FeatureFamilyKind | IssueStoreKind;
export type WorkItemFamily = 'feature' | 'issue';

export const FEATURE_FAMILY_KINDS: readonly FeatureFamilyKind[] = ['feature', 'chunk'];
// research-task was MERGED INTO `task` 2026-07-05 (WI-2874): research is non-code
// work, which is what `task` now means. It is no longer a feature-family kind; the
// sentinel deep-delegate + Queen route-to-research now spawn `task` (issue-family),
// scoped by the `payload.deep_delegation` tag. Historical terminal research-task
// rows are left in place (harmless); active ones were migrated to task.
// `task` (collapse-delegate D-001) is an issue-family work_item kind — the operator's
// delegated-work record. It lives in engineer_issues alongside bug|change but is
// excluded from the issues:* surface (listIssues default).
export const ISSUE_FAMILY_KINDS: readonly IssueStoreKind[] = ['bug', 'change', 'task'];

/**
 * Hard ceiling for a single work-items LIST read (both families). Local desktop
 * app + a virtualized grid (RichGrid `virtualMode`) means render cost no longer
 * scales with row count, so this is generous — it exists only to bound the
 * per-invalidation re-assembly + serialization of the LIVE sync query, not the
 * UI. A read that hits this ceiling is reported honestly via `countWorkItems`
 * ("N of TOTAL"), never silently truncated-as-total.
 */
export const WORK_ITEMS_MAX_LIMIT = 2000;
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [...FEATURE_FAMILY_KINDS, ...ISSUE_FAMILY_KINDS];

export function familyOf(kind: string): WorkItemFamily {
  return kind === 'bug' || kind === 'change' || kind === 'task' ? 'issue' : 'feature';
}
export function isWorkItemKind(k: string): k is WorkItemKind {
  return (WORK_ITEM_KINDS as readonly string[]).includes(k);
}

// ── Unified shape ─────────────────────────────────────────────────────────────────
export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  family: WorkItemFamily;
  harness: string | null;
  title: string;
  summary: string;
  /** Kind-specific lifecycle state (feature: status; issue: open|resolved|closed). */
  state: string;
  /** Claimable (D-003): feature → taken_by; issue → assignee. */
  assignee: string | null;
  /** When the item was claimed (feature → taken_at; issue → assigned_at; ISO). null when unclaimed.
   *  The grace anchor for {@link ./item-activity}.classifyItemActivity. */
  takenAt: string | null;
  /**
   * Last REAL item-scoped progress — a state transition (setWorkItemState) or a
   * checkpoint write — as an ISO string; null = no progress recorded yet.
   * Issue-family rows currently have no dedicated progress column; their checkpoint
   * progress refreshes assigned_at, surfaced as takenAt, until that schema grows one.
   * (agent-activity-liveness-truth-2026-06-21 P-001). DISTINCT from the holder's
   * presence heartbeat and the lease keepalive: a claim/heartbeat proves a
   * RESERVATION / a live PROCESS, not that the WORK is advancing. Feed it to
   * classifyItemActivity to tell progressing from stalled.
   */
  lastProgressAt: string | null;
  /** Durable delegator (collapse-delegate D-002): who created+assigned it.
   *  Issue-family only today (feature-family has no assigned_by column). */
  assignedBy: string | null;
  /** Issue-family only. */
  severity: string | null;
  /** Parent work-item id (a chunk's parent, D-004). */
  parent: string | null;
  payload: unknown | null;
  /**
   * Provenance (shared-hive-trust-admission P-005). `origin`: 'local' = authored on this
   * install, 'remote' = federated from a peer. `auditVerdict`: the G2 auditor's verdict on
   * a remote item ('admit'|'reject'|'pending'|null). The pair drives isAutoPickable — surfaced
   * so the Queen/UI can see "remote · pending-audit" and the placement gather can exclude
   * un-admitted remote work. Issue-family: origin reported 'local' (bug/change run inline, not
   * the autonomous remote-dispatch surface), auditVerdict null.
   */
  origin: string | null;
  auditVerdict: string | null;
  /**
   * P-008 (shared-hive-trust-admission): the github_user_id resolved from this
   * remote item's author_pubkey via a VERIFIED, non-revoked hive_members device
   * attestation — null for local/unverified/revoked rows (never a self-claimed
   * id). Surfaced so the placement-gather JS leg can apply the trust fast-path
   * (isAutoPickable) against the owner's local trust list.
   */
  verifiedAuthorGithubUserId: number | null;
  /**
   * Position within this item's ASSIGNEE's ordered work-list (local-hive P-020/D-004).
   * Lower = nearer head-of-line; null = unranked. Only meaningful relative to the other
   * items the SAME assignee holds — two bees' lists are independent. The Queen places
   * ranked work; the bee owns its sequencing (propose/dispose, D-008).
   */
  rank: number | null;
  /** Who last set `rank` — the propose/dispose audit (D-008). 'cup' (the default,
   *  cup-authored) | 'mug' (Mug overlay). null when unranked. */
  rankWriter: RankWriter | null;
  /** When `rank` was last written (tiebreak + audit). */
  rankUpdatedAt: string | null;
  /**
   * The SHARED backlog priority (`feature_order`) the decentralized claim path
   * (claimNextWorkItem) orders by — LOWER = claimed sooner; null = unprioritized
   * (sorts last). The Queen's steer-don't-dispatch lever (`work_items:set_priority`,
   * B7). Distinct from `rank`, which is a single bee's per-assignee work-list order.
   * Feature-family only; issue-family items are not the dispatched backlog → always null.
   */
  priority: number | null;
  /** Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
   *  the claiming principal who drove this item to its CURRENT terminal state
   *  (feature: passed|deprecated; issue: resolved|closed), or null if it has never
   *  reached one. Set only alongside a terminal setWorkItemState transition. */
  terminalOwner: string | null;
  /** Paired with terminalOwner: the completion evidence (summary / commit / coord
   *  or plan-item ref) recorded for the CURRENT terminal state. A terminal
   *  transition without both is rejected by setWorkItemState / setIssueState. */
  terminalCompletionRef: string | null;
  /** Queryable structured verification evidence recorded beside terminalCompletionRef. */
  terminalCompletionEvidence: CompletionVerificationEvidence | null;
  createdAt: string;
  updatedAt: string;
}

/** The propose/dispose author of a work-item's rank (local-hive D-008).
 *  pot-rename CONTRACT (SLICE-2 wave 2a): `cup`/`mug` are the canonical ids —
 *  the old `bee`/`queen` twins are removed here; the S2 role-contract migration
 *  backfills stored rows and tightens the `rank_writer` CHECK to match. Until
 *  that migration applies, a pre-backfill 'queen' row simply fails isRankWriter
 *  on read (display-only, self-heals at backfill). */
export type RankWriter = 'cup' | 'mug';
export const RANK_WRITERS: readonly RankWriter[] = ['cup', 'mug'];
export function isRankWriter(v: unknown): v is RankWriter {
  return v === 'cup' || v === 'mug';
}

// ── Capability stores (shared coord workspace, mirrors issues-engineer) ────────────
const coordOpts = { getSql: () => getOrgPg().sql, ensureSchema: async () => {}, workspaceId: DEFAULT_COORD_WORKSPACE };
const tags = new PgTaggableStore(coordOpts);
const threads = new PgThreadStore(coordOpts);
const subs = new PgEntitySubscriptionStore(coordOpts);
const links = new PgLinkStore(coordOpts);

/** The ObjectRef a work-item presents to the coord substrate (per family). */
export function workItemObjectRef(wi: Pick<WorkItem, 'family' | 'harness' | 'id'>): ObjectRef {
  if (wi.family === 'issue') return { kind: ISSUE_KIND, ref: wi.id };
  // feature-family: harness-qualified ref (a bare id is not unique across harnesses).
  // A feature-family item is harness-scoped by construction (harness_features_consolidated
  // .harness_slug is NOT NULL; work_items:create requires `harness` for feature/research-
  // task/chunk — verified 0/667 live rows have an empty harness). So a missing harness here
  // is a bug, not a default: `feature:<id>` with an empty harness would collide across
  // harnesses and corrupt coord dedup. Fail loud instead of `?? ''` (workspace-data-
  // isolation-leaks P-003).
  const harness = wi.harness?.trim();
  if (!harness) {
    throw new Error(
      `workItemObjectRef: feature-family work-item ${wi.id} has no harness — its ObjectRef ` +
        `would collide across harnesses (coord dedup corruption). A feature work-item must ` +
        `carry its harness.`,
    );
  }
  return { kind: FEATURE_KIND, ref: featureRef(harness, wi.id) };
}

function nowIso(): string {
  return new Date().toISOString();
}
function tsIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v ?? '');
}

const TERMINAL_COMPLETION_EVIDENCE_KEY = '_completionEvidence';

function extractTerminalCompletionEvidence(payload: unknown): CompletionVerificationEvidence | null {
  let obj = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  let v = (obj as Record<string, unknown>)[TERMINAL_COMPLETION_EVIDENCE_KEY];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as CompletionVerificationEvidence;
}

function completionEvidencePayloadJson(evidence: CompletionVerificationEvidence | undefined): string | null {
  return evidence && Object.keys(evidence).length > 0
    ? JSON.stringify({ [TERMINAL_COMPLETION_EVIDENCE_KEY]: evidence })
    : null;
}

/** Allocate the next kind-independent WI-NNN id (D-008). */
export async function nextWorkItemId(): Promise<string> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`SELECT harness_shared.next_work_item_id() AS id`;
  return rows[0].id;
}

function issueToWorkItem(i: EngineerIssue): WorkItem {
  return {
    id: i.id,
    kind: i.kind,
    family: 'issue',
    harness: harnessOfScope(i.scope),
    title: i.title,
    summary: i.body,
    state: i.state,
    assignee: i.assignee,
    // Issue-family uses engineer_issues.assigned_at as its claim-time anchor.
    // The unified work-item surface must expose it as takenAt so assignment
    // views/reapers do not read a live issue claim as unanchored.
    takenAt: i.assignedAt,
    // WI-3006: mirrors the takenAt fix above — engineer_issues.last_progress_at (migration 509)
    // is the real item-scoped progress signal for issue-family, bumped by markIssueProgress()
    // on a checkpoint. Was hardcoded null (issue-family checkpoints never advanced it), which
    // made classifyItemActivity fall back to takenAt forever and degrade any issue-family claim
    // held >STALE_MS with zero checkpoints to 'stalled' even while actively worked.
    lastProgressAt: i.lastProgressAt,
    assignedBy: i.assignedBy,
    severity: i.severity,
    parent: null,
    payload: i.payload ?? null,
    rank: i.assigneeRank,
    rankWriter: i.rankWriter,
    rankUpdatedAt: i.rankUpdatedAt,
    // EI-10421: was hardcoded null with the (stale, pre-P-007/EI-7407) comment "issue-family
    // isn't the dispatched backlog — no feature_order". Issue-family items HAVE been part of
    // the dispatched backlog and steerable via `feature_order` since SCHEDULER_ISSUES_CLAIMABLE
    // (setWorkItemPriority writes it, claimNextIssueWorkItem's claim order reads it
    // unconditionally) — this read path was the one place left not reflecting that (the
    // `engineer_issues` view never selected the column; fixed alongside, migration 588).
    priority: i.featureOrder,
    terminalOwner: i.terminalOwner,
    terminalCompletionRef: i.terminalCompletionRef,
    terminalCompletionEvidence: extractTerminalCompletionEvidence(i.payload),
    // Federated issue-family rows are replicated facts owned by the authoring peer.
    // Surface the physical-row provenance so mutators can fail loud instead of
    // reporting "not found" after the engineer_issues view deliberately no-ops.
    origin: i.origin ?? 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null, // local-origin ⇒ never verified-stamped (P-008)
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

/** The porsager `sql` instance type the org-scoped pool hands back — shared by the
 *  composable WHERE-fragment builders (claimFloorsWhereSql) + the spec-driven resolver. */
export type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface FeatureRowDb {
  feature_id: string;
  item_kind: string | null;
  harness_slug: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  taken_by: string | null;
  taken_at: unknown;
  last_progress_at: unknown;
  parent_id: string | null;
  payload: unknown;
  assignee_rank: number | null;
  rank_writer: string | null;
  rank_updated_at: unknown;
  feature_order: number | null;
  created_ts: unknown;
  updated_ts: unknown;
  origin: string | null;
  audit_verdict: string | null;
  verified_author_github_user_id: number | string | null;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
}
export function featureRowToWorkItem(r: FeatureRowDb): WorkItem {
  return {
    id: r.feature_id,
    kind: (r.item_kind as FeatureFamilyKind) || 'feature',
    family: 'feature',
    harness: r.harness_slug,
    title: r.title ?? '',
    summary: r.summary ?? '',
    state: r.status ?? 'todo',
    assignee: r.taken_by,
    // agent-activity-liveness-truth P-001: the claim time (grace anchor) + last REAL
    // item-scoped progress. Reset on holder-change (claim/release); bumped on a state
    // transition / checkpoint. Feed both to classifyItemActivity (item-activity.ts).
    takenAt: r.taken_at == null ? null : tsIso(r.taken_at),
    lastProgressAt: r.last_progress_at == null ? null : tsIso(r.last_progress_at),
    assignedBy: null, // feature-family has no assigned_by column (collapse-delegate D-002)
    severity: null,
    parent: r.parent_id,
    payload: r.payload ?? null,
    rank: r.assignee_rank,
    rankWriter: isRankWriter(r.rank_writer) ? r.rank_writer : null,
    rankUpdatedAt: r.rank_updated_at == null ? null : tsIso(r.rank_updated_at),
    priority: r.feature_order,
    origin: r.origin ?? 'local',
    auditVerdict: r.audit_verdict,
    verifiedAuthorGithubUserId: coerceGithubUserId(r.verified_author_github_user_id),
    terminalOwner: r.terminal_owner,
    terminalCompletionRef: r.terminal_completion_ref,
    terminalCompletionEvidence: extractTerminalCompletionEvidence(r.payload),
    createdAt: tsIso(r.created_ts),
    updatedAt: tsIso(r.updated_ts),
  };
}

/** Coerce a bigint-projected github_user_id (postgres-js may hand back a string)
 *  to a finite number, or null. P-008. */
function coerceGithubUserId(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

export const FEATURE_COLS = `feature_id, item_kind, harness_slug, title, summary, status, taken_by,
  taken_at, last_progress_at,
  parent_id, payload, assignee_rank, rank_writer, rank_updated_at, feature_order, created_ts, updated_ts,
  origin, audit_verdict, verified_author_github_user_id, terminal_owner, terminal_completion_ref`;

// ── Reads ─────────────────────────────────────────────────────────────────────────
export interface ListWorkItemsFilter {
  harness?: string;
  kind?: WorkItemKind;
  state?: string;
  /** Filter to items assigned to this agent (feature → taken_by; issue → assignee). */
  assignee?: string;
  /** Filter to items this owner delegated (collapse-delegate D-002). Issue-family only. */
  assignedBy?: string;
  /** Return children of this parent id (a chunk listing). Default: top-level only. */
  parent?: string;
  /** Include child items (chunks) in the default list. Default false (D-004). */
  includeChildren?: boolean;
  /**
   * Order by per-assignee `rank` ascending (NULLs last) instead of updatedAt DESC
   * (local-hive P-021). Only meaningful with an `assignee` filter — it returns that
   * agent's ordered work-list (head-of-line first). Default false.
   */
  orderByRank?: boolean;
  limit?: number;
  /**
   * EI-7841: when true, apply the SAME feature-family G2 admission/trust gate
   * (autoPickableWhereSql) the claim paths (`claimWorkItem` / `claimFloorsWhereSql`)
   * enforce — a remote, un-admitted item is excluded rather than listed as if
   * claimable. Default false/omitted: byte-identical to before (every existing
   * caller — dashboards, leader overviews, general `work_items:list` calls — keeps
   * seeing the full backlog including gated items). Opt in for a SELF-SELECT
   * consumer (e.g. coord:orient's claimable backlog) so "claimable" actually means
   * claimable.
   */
  admissibleOnly?: boolean;
  /**
   * fleet-leader-frictions P-005: completion-integrity audit filters. 'no-evidence'
   * restricts the list to TERMINAL-state rows closed WITHOUT a structured completion
   * record (`terminal_completion_ref IS NULL`) — the "stale-done close" a DRAIN leader
   * spot-audits by hand today (a bare set_state-to-done stamps no completion ref;
   * work_items:complete always does). Composes with `state` (an explicit terminal
   * state narrows the audit to it); without `state` it spans the whole cross-family
   * terminal set. Non-terminal rows never match (an open item owes no evidence yet).
   */
  audit?: 'no-evidence';
  /**
   * EI-10422/WI-4405: when true, INCLUDE `payload.lane === 'observation'` rows (default
   * false ⇒ EXCLUDED). Threaded to {@link listIssues}'s `excludeObservationLane`
   * (`!includeObservations`) — until this field existed, work_items:list's tool layer
   * (agent-tools/work_items/list.ts) passed `includeObservations` in an object literal
   * this interface didn't declare: a live `tsc --noEmit` TS2353 excess-property error
   * (the type checker caught it; the untyped runtime call silently dropped the field
   * anyway, since `listWorkItems` never read it) — so EI-10422's "exclude observations
   * by default" fix never actually reached this general read path. `admissibleOnly`
   * ALSO forces exclusion regardless of this flag (an observation is never claimable).
   */
  includeObservations?: boolean;
}

/**
 * The cross-family TERMINAL state set (P-005) — a row in any of these owes completion
 * evidence. Union of both families' closes (feature: done/passed/dropped/deprecated;
 * issue: resolved/closed/deprecated). Exported so audit consumers (work_items:list,
 * burn_down) share ONE definition.
 */
export const TERMINAL_WORK_ITEM_STATES: readonly string[] = [
  'done',
  'passed',
  'resolved',
  'closed',
  'deprecated',
  'dropped',
];

/**
 * Recency comparator — newest `updatedAt` first. The default work-item order.
 */
export function compareByRecency(a: WorkItem, b: WorkItem): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/**
 * Head-of-line comparator for an assignee's ordered work-list — the swarm
 * scheduler's BUFFERED-DRAIN order (swarm-coordination-architecture P-005 /
 * D-006). Ranked items first by `rank` ASC, unranked (`rank == null`) sink to
 * the tail (treated as +∞), and ties break by recency (newest first). This is
 * how the Queen places several items ahead and a bee drains them head-of-line
 * without waiting on the brain's cadence; it MERGES across families (a bee's
 * feature-family + issue-family items interleave by rank into one list).
 *
 * Pure + total so it is unit-testable in isolation; `listWorkItems` applies it
 * after the cross-family fetch.
 */
export function compareByHeadOfLine(a: WorkItem, b: WorkItem): number {
  const ar = a.rank ?? Number.POSITIVE_INFINITY;
  const br = b.rank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return compareByRecency(a, b);
}

/**
 * Feature-family `item_kind` filter that ALSO admits workspace-registered GENERIC-KIND
 * datatypes (reflexive-platform-extensibility-datatypes-2026-06-24 P-001). A generic-kind
 * item (e.g. a `bet`) lives in the feature family (`familyOf` → 'feature') but its kind is
 * not one of the built-ins, so a bare `IN ('feature','chunk')` would
 * HIDE it from list/count/search. This admits the built-ins OR any active generic-kind
 * registered for `workspaceId`. DARK until a datatype is declared — the subquery is empty
 * otherwise, so the live fleet's reads are byte-identical.
 *
 * SCOPE: this is the user/agent-facing VISIBILITY filter (list/count/search). The Queen's
 * autonomous PLACEMENT frontier (claimFloorsWhereSql / survey.fetchFrontierRows /
 * wake-frontier-guard) is a SEPARATE clause — `frontierPlacementKindClause`
 * (datatype-frontier-placement.ts) — gated on the `hive-placement` opt-in tag, because a
 * datatype is visible without necessarily auto-placing a bee per instance (placement is opt-in).
 */
function featureFamilyKindClause(sql: OrgSql, workspaceId: string) {
  return sql`(item_kind IN ('feature', 'chunk')
       OR item_kind IN (
         SELECT work_item_kind FROM harness_shared.datatype_registry
          WHERE workspace_id = ${workspaceId} AND tier = 'generic-kind' AND status = 'active'
            AND work_item_kind IS NOT NULL
       ))`;
}

/** Cross-kind list. Default = top-level items only (chunks surface under their parent, D-004). */
export async function listWorkItems(filter: ListWorkItemsFilter = {}): Promise<WorkItem[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(filter.limit ?? 100, WORK_ITEMS_MAX_LIMIT);
  // assignedBy is an issue-family-only concept, so it excludes all feature rows.
  const wantFeature = (!filter.kind || familyOf(filter.kind) === 'feature') && !filter.assignedBy;
  const wantIssue = !filter.kind || familyOf(filter.kind) === 'issue';
  const out: WorkItem[] = [];

  if (wantFeature) {
    const ws = activeWorkspaceId();
    const rows = await sql<FeatureRowDb[]>`
      SELECT ${sql.unsafe(FEATURE_COLS)}
        FROM harness_shared.harness_features_consolidated
       WHERE ${featureFamilyKindClause(sql, ws)}
         AND workspace_id = ${ws}
         AND ${filter.harness ? sql`harness_slug = ${filter.harness}` : sql`TRUE`}
         AND ${filter.kind && familyOf(filter.kind) === 'feature' ? sql`item_kind = ${filter.kind}` : sql`TRUE`}
         AND ${filter.state ? sql`status = ${filter.state}` : sql`TRUE`}
         AND ${filter.assignee ? sql`taken_by = ${filter.assignee}` : sql`TRUE`}
         AND ${
           filter.parent
             ? sql`parent_id = ${filter.parent}`
             : filter.includeChildren
               ? sql`TRUE`
               : sql`(parent_id IS NULL OR parent_id = '')`
         }
         AND ${filter.admissibleOnly ? autoPickableWhereSql(sql, ws) : sql`TRUE`}
         AND ${
           filter.audit === 'no-evidence'
             ? sql`(status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]) AND terminal_completion_ref IS NULL)`
             : sql`TRUE`
         }
       ORDER BY ${filter.orderByRank ? sql`assignee_rank ASC NULLS LAST, updated_ts DESC` : sql`updated_ts DESC NULLS LAST`}
       LIMIT ${limit}`;
    out.push(...rows.map(featureRowToWorkItem));
  }

  // Issues are always top-level (no parent edge today), so a `parent` filter excludes them.
  if (wantIssue && !filter.parent) {
    const issues = await listIssues({
      // A specific issue-family kind, else ALL issue-family kinds (incl. `task`) — the
      // unified surface includes delegated tasks; the issues:* surface (its own default)
      // does not.
      kind: filter.kind && familyOf(filter.kind) === 'issue' ? (filter.kind as IssueStoreKind) : undefined,
      kinds: filter.kind && familyOf(filter.kind) === 'issue' ? undefined : ISSUE_FAMILY_KINDS,
      scope: filter.harness ? `harness:${filter.harness}` : undefined,
      state: (filter.state as IssueState) || undefined,
      assignee: filter.assignee,
      assignedBy: filter.assignedBy,
      // WI-3649: mirror the feature branch's admissibleOnly gate (line ~530) so
      // "claimable backlog" excludes federated (origin='remote') issue-family rows
      // that the write path (claimNextIssueWorkItem / the engineer_issues_view_dml
      // trigger) will never actually let a local claim succeed against.
      admissibleOnly: filter.admissibleOnly,
      // WI-4405: admissibleOnly ALSO forces exclusion (an observation is never
      // claimable, regardless of includeObservations) — otherwise honor the flag.
      excludeObservationLane: filter.admissibleOnly ? true : !filter.includeObservations,
      audit: filter.audit,
      limit,
    });
    out.push(...issues.map(issueToWorkItem));
  }

  out.sort(filter.orderByRank ? compareByHeadOfLine : compareByRecency);
  return out.slice(0, limit);
}

/**
 * COUNT companion to {@link listWorkItems} — the true total across BOTH families
 * for the same filter, minus limit/order. A capped list read pairs with this to
 * show "N of TOTAL" instead of letting the downloaded length masquerade as the
 * total. Two cheap COUNT(*)s (one per family), mirroring listWorkItems' WHERE
 * exactly so the total is consistent with what the list would return uncapped.
 */
export async function countWorkItems(filter: ListWorkItemsFilter = {}): Promise<number> {
  const { sql } = getOrgPg();
  const wantFeature = (!filter.kind || familyOf(filter.kind) === 'feature') && !filter.assignedBy;
  const wantIssue = !filter.kind || familyOf(filter.kind) === 'issue';
  let total = 0;

  if (wantFeature) {
    const ws = activeWorkspaceId();
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE ${featureFamilyKindClause(sql, ws)}
         AND workspace_id = ${ws}
         AND ${filter.harness ? sql`harness_slug = ${filter.harness}` : sql`TRUE`}
         AND ${filter.kind && familyOf(filter.kind) === 'feature' ? sql`item_kind = ${filter.kind}` : sql`TRUE`}
         AND ${filter.state ? sql`status = ${filter.state}` : sql`TRUE`}
         AND ${filter.assignee ? sql`taken_by = ${filter.assignee}` : sql`TRUE`}
         AND ${
           filter.parent
             ? sql`parent_id = ${filter.parent}`
             : filter.includeChildren
               ? sql`TRUE`
               : sql`(parent_id IS NULL OR parent_id = '')`
         }`;
    total += rows[0]?.n ?? 0;
  }

  // Issues are always top-level, so a `parent` filter excludes them (mirrors listWorkItems).
  if (wantIssue && !filter.parent) {
    total += await countIssues({
      kind: filter.kind && familyOf(filter.kind) === 'issue' ? (filter.kind as IssueStoreKind) : undefined,
      kinds: filter.kind && familyOf(filter.kind) === 'issue' ? undefined : ISSUE_FAMILY_KINDS,
      scope: filter.harness ? `harness:${filter.harness}` : undefined,
      state: (filter.state as IssueState) || undefined,
      assignee: filter.assignee,
      assignedBy: filter.assignedBy,
      excludeObservationLane: filter.admissibleOnly ? true : !filter.includeObservations,
    });
  }

  return total;
}

/** Resolve one work-item by id, searching both kind-tables (ids are disjoint across families). */
export async function getWorkItem(id: string, harness?: string): Promise<WorkItem | null> {
  // Issue-family ids (EI-* or a WI-* that lives in engineer_issues) are globally unique.
  const issue = await getIssue(id);
  if (issue) return issueToWorkItem(issue);

  const { sql } = getOrgPg();
  // F-B3 (workspace-data-isolation-leaks): a bare WI/F id is unique only within a
  // (workspace, harness), not globally — scope to the active workspace so an id
  // collision across workspaces can't return the wrong row (getOrgPg bypasses RLS).
  const rows = await sql<FeatureRowDb[]>`
    SELECT ${sql.unsafe(FEATURE_COLS)}
      FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${id}
       AND workspace_id = ${activeWorkspaceId()}
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 1`;
  return rows[0] ? featureRowToWorkItem(rows[0]) : null;
}

export interface WorkItemDetail extends WorkItem {
  topics: string[];
  posts: ThreadPostRow[];
  /** Edges OUT of this work-item (e.g. blocks → feature|plan_item), excluding tag edges. */
  links: { rel: string; dst: ObjectRef }[];
}

/** A work-item plus its coord-substrate detail (topics, thread posts, outgoing links). */
export async function getWorkItemDetail(id: string, harness?: string): Promise<WorkItemDetail | null> {
  const wi = await getWorkItem(id, harness);
  if (!wi) return null;
  if (wi.family === 'issue') {
    const d = await getIssueDetail(id);
    return { ...wi, topics: d?.topics ?? [], posts: d?.posts ?? [], links: d?.links ?? [] };
  }
  const ref = workItemObjectRef(wi);
  const topics = await tags.listTags(ref);
  const thread = await threads.getThreadByParent(ref);
  const posts = thread ? await threads.listPosts(thread.thread_id) : [];
  const out = await links.listOut(ref);
  return {
    ...wi,
    topics,
    posts,
    links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })),
  };
}

/** Width of the migration-551 embedding columns (= embed-backfill's
 *  EMBEDDER_DIM). A local const — importing it would pull the whole embed
 *  stack (configure/sidecar/admission) into this module's static graph; the
 *  embedder itself is dynamic-imported inside the leg for the same reason. */
const WORK_ITEM_EMBED_DIM = 384;

/** Test seam for the P-008 semantic leg: the query-embedder resolver to use
 *  (defaults to the real `buildQueryEmbedderResolved`). Injectable because the
 *  real one lazy-loads an ONNX model — a unit test must never pay that. */
export type QueryEmbedderResolver = () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;

/** Cross-kind full-text search over both kind-tables (parity with issues:search).
 *
 * P-008 (shared-embedding-sidecar-and-enrichment-2026-07-10): also runs a
 * SEMANTIC leg — cosine top-k over the migration-551 embedding columns, space
 * filtered to the active embedder mode — and merges the hits AFTER the lexical
 * ones, deduped by id. Recall-additive only: a rephrased query ("agents keep
 * filing the same bug") now finds items whose words never matched. The leg is
 * strictly fail-open (no embedder / 551 absent / dims mismatch ⇒ lexical-only)
 * and defaults OFF under vitest (an implicit model load in unrelated tests is
 * the WI-3792 load-scar class) — pass `semantic: true` to force it there.
 */
export async function searchWorkItems(
  query: string,
  opts: {
    harness?: string;
    kind?: WorkItemKind;
    limit?: number;
    /** Default on (off under VITEST); `false` = lexical-only. */
    semantic?: boolean;
    /** Test seam — see QueryEmbedderResolver. */
    embedderResolver?: QueryEmbedderResolver;
    /**
     * EI-10422/WI-4405: by default a `payload.lane === 'observation'` row is EXCLUDED
     * from matches (D-005 — it never enters the work queue/triage). Pass true to
     * include raw observations in search results.
     */
    includeObservations?: boolean;
  } = {},
): Promise<WorkItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const wantFeature = !opts.kind || familyOf(opts.kind) === 'feature';
  const wantIssue = !opts.kind || familyOf(opts.kind) === 'issue';
  const out: WorkItem[] = [];

  if (wantIssue) {
    let issues = (await searchIssues(query, limit)).map(issueToWorkItem);
    if (opts.harness) issues = issues.filter((w) => w.harness === opts.harness);
    if (opts.kind && familyOf(opts.kind) === 'issue') issues = issues.filter((w) => w.kind === opts.kind);
    if (!opts.includeObservations) {
      issues = issues.filter((w) => (w.payload as { lane?: string } | null | undefined)?.lane !== 'observation');
    }
    out.push(...issues);
  }

  if (wantFeature) {
    const { sql } = getOrgPg();
    const rows = await sql<FeatureRowDb[]>`
      SELECT ${sql.unsafe(FEATURE_COLS)}
        FROM harness_shared.harness_features_consolidated
       WHERE ${featureFamilyKindClause(sql, activeWorkspaceId())}
         AND _search @@ websearch_to_tsquery('english', ${query})
         AND workspace_id = ${activeWorkspaceId()}
         AND ${opts.harness ? sql`harness_slug = ${opts.harness}` : sql`TRUE`}
         AND ${opts.kind && familyOf(opts.kind) === 'feature' ? sql`item_kind = ${opts.kind}` : sql`TRUE`}
       ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
       LIMIT ${limit}`;
    out.push(...rows.map(featureRowToWorkItem));
  }

  const semanticOn = opts.semantic ?? !process.env.VITEST;
  if (semanticOn) {
    try {
      const resolve = opts.embedderResolver ?? (await import('./agent-tools/search/embedder')).buildQueryEmbedderResolved;
      const resolved = await resolve();
      // The embedding columns are vector(384); a query vector in another width
      // (harrier@1024) can't rank against them — skip rather than SQL-error.
      if (resolved && resolved.dims === WORK_ITEM_EMBED_DIM) {
        const vec = await resolved.embed(query);
        if (vec.length === WORK_ITEM_EMBED_DIM) {
          const seen = new Set(out.map((w) => w.id));
          const semLimit = Math.min(limit, 20);
          if (wantIssue) {
            let hits = (await semanticSearchIssues(vec, resolved.mode, semLimit)).map(issueToWorkItem);
            if (opts.harness) hits = hits.filter((w) => w.harness === opts.harness);
            if (opts.kind && familyOf(opts.kind) === 'issue') hits = hits.filter((w) => w.kind === opts.kind);
            if (!opts.includeObservations) {
              hits = hits.filter((w) => (w.payload as { lane?: string } | null | undefined)?.lane !== 'observation');
            }
            for (const w of hits) if (!seen.has(w.id)) { seen.add(w.id); out.push(w); }
          }
          if (wantFeature) {
            const { sql } = getOrgPg();
            const vecLit = `[${vec.join(',')}]`;
            const rows = await sql<FeatureRowDb[]>`
              SELECT ${sql.unsafe(FEATURE_COLS)}
                FROM harness_shared.harness_features_consolidated
               WHERE ${featureFamilyKindClause(sql, activeWorkspaceId())}
                 AND workspace_id = ${activeWorkspaceId()}
                 AND embedding IS NOT NULL
                 AND embedding_mode = ${resolved.mode}
                 AND ${opts.harness ? sql`harness_slug = ${opts.harness}` : sql`TRUE`}
                 AND ${opts.kind && familyOf(opts.kind) === 'feature' ? sql`item_kind = ${opts.kind}` : sql`TRUE`}
               ORDER BY embedding <=> ${vecLit}::vector
               LIMIT ${semLimit}`;
            for (const w of rows.map(featureRowToWorkItem)) if (!seen.has(w.id)) { seen.add(w.id); out.push(w); }
          }
        }
      }
    } catch {
      // Fail-open (D-003 discipline): embedder down / migration 551 not applied /
      // pgvector absent all degrade to the lexical result, never to an error.
    }
  }

  return out.slice(0, limit);
}

// ── Writes ─────────────────────────────────────────────────────────────────────────
export interface CreateWorkItemInput {
  kind: WorkItemKind;
  title: string;
  /** Free-text body/summary (issue body, feature summary). */
  summary?: string;
  harness?: string;
  severity?: IssueSeverity; // issue-family
  parent?: string; // feature-family (a chunk's parent)
  payload?: unknown; // kind-specific data (feature-family + issue-family `task`)
  topics?: string[];
  /**
   * Explicit target workspace (EI-728). Feature-family items omit `workspace_id`
   * and let the `fill_workspace_id_from_projects` BEFORE-INSERT trigger derive it
   * from the harness's `projects` row (fallback 'default'). When the request
   * carries a workspace (the MCP `?workspace=` / an explicit `workspace` arg /
   * the hive's own workspace), pass it here so the write lands there instead of
   * silently falling back to 'default' when the projects lookup misses — the
   * trigger fills ONLY when workspace_id is NULL/'', so a provided value wins.
   * Omit (or pass '*'/'') to keep the trigger-derived default behavior.
   */
  workspaceId?: string;
  createdBy?: string;
  /**
   * ATOMIC create+claim (loop-routines P-007 / D-008, B-LOOP-4): the agent id to
   * assign the new item to AT CREATION, in the same DB write — no separate claim,
   * no create→claim race window. General: any agent id (self-assign = own id; a
   * Queen create+place onto a bee = the bee's id). Honored for BOTH families —
   * feature-family stamps `taken_by`/`taken_at` in the INSERT, issue-family writes
   * the `assignee` column (collapse-delegate: the delegate session). Omit ⇒ the
   * item lands unclaimed (the prior default).
   */
  assignee?: string;
  /** Durable delegator (collapse-delegate D-002). Issue-family only (the
   *  feature table has no assigned_by column). */
  assignedBy?: string;
  /**
   * URGENT enqueue (swarm-coordination P-006/D-005): wake the Pot operator (the
   * brain) immediately instead of waiting out its slow cadence. Floor-debounced +
   * coalesced (a burst of urgent creates collapses to one wake); fire-and-forget
   * (the create never fails because the wake path failed). Enqueue-time wake
   * semantics only — nothing durable is stamped on the item (severity/rank are
   * the durable priority surfaces).
   */
  urgent?: boolean;
  /**
   * Source plan provenance (queen-steering-panel-2026-06-15 P-008): the plan slug
   * this feature-family work-item was minted FROM — set at plan-item→work_item
   * conversion (`convertPlanItem`). Written to the `source_plan_slug` column so the
   * Queen's survey can HARD-filter the frontier by the owner's `eligible-plans`
   * (surveyHive scopeFilter): a frontier item from a non-eligible plan is dropped at
   * the source, making "work on these plans only" structurally binding rather than
   * advisory. IGNORED for issue-family kinds (they hold no frontier row / no such
   * column). Omit ⇒ unplanned/standalone work (source_plan_slug stays NULL).
   */
  sourcePlanSlug?: string | null;
}

/** Fire the urgent brain wake for an urgent enqueue (P-006). Lazy import +
 *  fire-and-forget: same pattern as the settled-events emit — a wake-path
 *  failure must never break the write. */
function maybeFireUrgentWake(input: CreateWorkItemInput, wi: WorkItem): void {
  if (!input.urgent) return;
  void import('./pot/urgent-wake')
    .then((m) =>
      m.requestUrgentPotWake({
        reason: `urgent work_item ${wi.id} (${wi.kind}) enqueued: ${wi.title}`,
        harness: wi.harness,
      }),
    )
    .catch(() => {});
}

/**
 * Fire `work-item:claimed:<id>` for an ATOMIC create+claim (loop-routines P-007 /
 * D-008, B-LOOP-4): when `createWorkItem` was given an `assignee`, the row lands
 * already-claimed, so emit the SAME awaited-event `claimWorkItem` fires — a
 * Queen→bee place (or any `events:await` leg on the claim) observes it identically
 * to a separate claim. Lazy import (work-items-events imports this module
 * statically) + fire-and-forget: an emit-path failure must never break the write.
 */
function maybeFireClaimedEvent(assignTo: string | null, wi: WorkItem): void {
  if (!assignTo) return;
  void import('./work-items-events').then((m) => m.emitWorkItemClaimedEvent(wi, assignTo)).catch(() => {});
}

/**
 * Fire `work-item:created[:<severity>]` for EVERY new work item (EI-8296) —
 * lazy import (work-items-events imports this module statically) +
 * fire-and-forget: an emit-path failure must never break the create.
 */
function maybeFireCreatedEvent(wi: WorkItem): void {
  // P-007: emitWorkItemCreatedEvent internally co-fires the canonical
  // `work-item:claimable` key for an unclaimed-claimable create — one hook here.
  void import('./work-items-events').then((m) => m.emitWorkItemCreatedEvent(wi)).catch(() => {});
}

/** Create a work-item of any kind, minting a kind-independent WI-NNN id (D-008). */
export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  // P-001 generic-kind: accept a built-in kind OR a workspace-registered generic-kind
  // datatype (familyOf maps it to the feature family → the feature table). The
  // work_items:create gate (_create-core) already validated this, but createWorkItem is
  // also a direct entry point, so it re-checks the registry rather than hard-rejecting —
  // the live gap that let the gate pass an instance the insert then refused.
  if (!isWorkItemKind(input.kind)) {
    const registered = input.workspaceId
      ? await hasGenericKind(getOrgPg().sql, input.workspaceId, input.kind).catch(() => false)
      : false;
    if (!registered) throw new Error(`unknown work_item kind '${input.kind}'`);
  }
  const id = await nextWorkItemId();

  // ATOMIC create+claim (loop-routines P-007 / D-008, B-LOOP-4): a non-empty
  // `assignee` makes the row land already-claimed by that agent — no separate
  // claim call, no create→claim race window (a competing claim_next can't grab the
  // row in the gap). Issue-family claims via createIssue's assignee/assigned_by
  // columns; feature-family stamps taken_by/taken_at in the INSERT below. A
  // freshly-created row is origin='local' ⇒ always admissible, so no auditor guard.
  const assignTo = typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : null;

  if (familyOf(input.kind) === 'issue') {
    const issue = await createIssue({
      id,
      kind: input.kind as IssueStoreKind,
      title: input.title,
      body: input.summary ?? '',
      severity: input.severity,
      scope: input.harness ? harnessScope(input.harness) : 'operator',
      topics: input.topics,
      createdBy: input.createdBy,
      assignee: input.assignee,
      assignedBy: input.assignedBy,
      payload: input.payload,
    });
    const created = issueToWorkItem(issue);
    maybeFireUrgentWake(input, created);
    maybeFireClaimedEvent(assignTo, created);
    maybeFireCreatedEvent(created);
    return created;
  }

  // feature-family — harness-scoped row in harness_features_consolidated.
  // unified-work-item-ledger P-001: reject a blank/whitespace harness too (not just
  // a missing one), so a feature can never land with an empty harness_slug.
  if (!input.harness || !input.harness.trim()) {
    throw new Error(`work_item kind '${input.kind}' requires a non-empty harness`);
  }
  const { sql } = getOrgPg();
  const now = Date.now();
  // workspace_id (workspace-data-isolation P-002 / dogfood fix): RESOLVE it here and
  // ALWAYS write it explicitly — do NOT leave it NULL for the fill_ws_features_trg
  // BEFORE-INSERT trigger. That trigger's lookup hits only the sparse `projects` table
  // and then falls back to 'default', stranding fleet work-items in a workspace the READ
  // path never reads (confirmed dogfood: 168/661 rows in 'default', invisible to the
  // operator's queue). Precedence:
  //   1. an explicit workspace (EI-728 — the '*' SU-wildcard is treated as "none")
  //   2. else activeWorkspaceId() — the operator's OWN active workspace, which is EXACTLY
  //      the scope every work-item READ path uses (claimNextWorkItem / listWorkItems /
  //      getWorkItem all scope by activeWorkspaceId()). Writing here guarantees the item
  //      is visible to the queue — never the trigger's stale 'default'.
  // Positional $N::jsonb is the operator's proven jsonb write on the org pool
  // (prepare:false mis-binds sql.json()).
  const explicitWs =
    typeof input.workspaceId === 'string' && input.workspaceId.trim() && input.workspaceId !== '*'
      ? input.workspaceId.trim()
      : null;
  const resolvedWs = explicitWs ?? activeWorkspaceId();
  // queen-steering-panel P-008: stamp the source plan slug so the Queen's survey can
  // HARD-filter the frontier by owner eligible-plans. source_plan_slug is ALWAYS written
  // (NULL when unplanned — the column is nullable). workspace_id is now ALSO always
  // written (the resolvedWs above) so the leaky trigger never decides it. The text params cast ::text — the org pool
  // runs prepare:false, so a bare trailing param leaves the server unable to infer its
  // type ("could not determine data type of parameter $N"), same as the $6::jsonb cast.
  const sourcePlanSlug =
    typeof input.sourcePlanSlug === 'string' && input.sourcePlanSlug.trim() ? input.sourcePlanSlug.trim() : null;
  // The fixed base columns/values (params $1..$11). $6 jsonb + $11 text carry
  // explicit casts because the org pool runs prepare:false (a bare param leaves the
  // server unable to infer its type). The two INDEPENDENT optionals — taken_by/
  // taken_at (B-LOOP-4 atomic claim) and workspace_id (EI-728) — are appended in a
  // fixed order with each param index computed off `params.length`, so they never
  // collide on a positional slot regardless of which (or both) is present.
  const params: (string | number | null)[] = [
    input.harness,
    id,
    input.title,
    input.summary ?? null,
    input.kind,
    input.payload != null ? JSON.stringify(input.payload) : null,
    input.parent ?? null,
    now,
    now,
    now,
    sourcePlanSlug,
  ];
  const cols = [
    'harness_slug',
    'feature_id',
    'title',
    'summary',
    'status',
    'attempts',
    'item_kind',
    'payload',
    'parent_id',
    'needs_design',
    'needs_human_review',
    'ts',
    'created_ts',
    'updated_ts',
    'source_plan_slug',
  ];
  const vals = [
    '$1',
    '$2',
    '$3',
    '$4',
    `'todo'`,
    '0',
    '$5',
    '$6::jsonb',
    '$7',
    'FALSE',
    'FALSE',
    '$8',
    '$9',
    '$10',
    '$11::text',
  ];
  if (assignTo) {
    // Atomic create+claim: stamp the owner + lease time in the SAME INSERT (mirrors
    // claimWorkItem's `taken_by = …, taken_at = now()`), so the row is never
    // momentarily unclaimed for a competing claim_next to steal.
    params.push(assignTo);
    cols.push('taken_by', 'taken_at');
    vals.push(`$${params.length}::text`, 'now()');
  }
  // Always write the resolved workspace explicitly (never rely on the trigger's stale
  // 'default' fallback — see the resolution comment above).
  params.push(resolvedWs);
  cols.push('workspace_id');
  vals.push(`$${params.length}::text`);
  await sql.unsafe(
    `INSERT INTO harness_shared.work_items (${cols.join(', ')})
     VALUES (${vals.join(', ')})
     ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
    params,
  );
  const wi: WorkItem = {
    id,
    kind: input.kind,
    family: 'feature',
    harness: input.harness,
    title: input.title,
    summary: input.summary ?? '',
    state: 'todo',
    // work-item-completion-integrity-2026-07-01 WI-1403: a freshly-inserted row has
    // never taken a terminal transition, so both are unset (the INSERT above doesn't
    // write them — they default to SQL NULL).
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null, // freshly-inserted row never took a terminal transition (peer added this required field to the WorkItem type but missed this construction site)
    assignee: assignTo, // B-LOOP-4: created already-claimed when `assignee` was given
    // P-001: an atomic create+claim stamps taken_at=now() (the grace anchor); a fresh
    // row has no item-scoped progress yet, so last_progress_at stays null.
    takenAt: assignTo ? tsIso(now) : null,
    lastProgressAt: null,
    assignedBy: null, // feature-family has no assigned_by column (collapse-delegate D-002)
    severity: null,
    parent: input.parent ?? null,
    payload: input.payload ?? null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null, // freshly created → unprioritized until the Queen sets feature_order
    origin: 'local', // created here ⇒ local-authored; no auditor screening needed
    auditVerdict: null,
    verifiedAuthorGithubUserId: null, // created here ⇒ local-authored, never verified-stamped (P-008)
    createdAt: tsIso(now),
    updatedAt: tsIso(now),
  };
  // Capabilities: tag topics + auto-subscribe the creator (the hfc CDC trigger handles
  // the change fan-out + federation, so no explicit deliver() here).
  for (const topic of input.topics ?? []) {
    await tags.addTag(workItemObjectRef(wi), topic, { created_by: input.createdBy, created_ts: nowIso() });
  }
  if (input.createdBy) {
    await subs.subscribe({
      subscriber_id: input.createdBy,
      target_kind: 'object',
      target_ref: `${FEATURE_KIND}:${workItemObjectRef(wi).ref}`,
      delivery_mode: 'full',
      created_ts: nowIso(),
    });
  }
  maybeFireUrgentWake(input, wi);
  maybeFireClaimedEvent(assignTo, wi);
  maybeFireCreatedEvent(wi);
  return wi;
}

/** The issue family's native Lifecycle states (the engineer_issues CHECK). */
// Canonical lifecycle vocabulary (P-007) — widened to string[] for the
// includes(string) call site below; values come from the one LIFECYCLE_STATES.
export const ISSUE_FAMILY_STATES: readonly string[] = LIFECYCLE_STATES;

/**
 * The cross-family TERMINAL/settled state set — feature-family `passed`/`deprecated`
 * plus issue-family `resolved`/`closed`. The single source of truth for "this work_item
 * is done, one way or another" (WI-1400); was previously an inline literal array
 * duplicated at each call site.
 */
export const SETTLED_WORK_ITEM_STATES: readonly string[] = ['passed', 'deprecated', 'resolved', 'closed'];

/** Is `state` one of the cross-family settled/terminal states? */
export function isSettledWorkItemState(state: string | null | undefined): boolean {
  return !!state && SETTLED_WORK_ITEM_STATES.includes(state);
}

/**
 * Cross-dialect + drift-variant aliases → canonical issue-family state (mirrors
 * `FEATURE_STATE_ALIASES` in work-item-dispatch-states.ts, the feature-family twin).
 * Hoisted to module scope (was inline in `normalizeWorkItemState`) + exported so
 * the positional-write misalignment guard (EI-7927) can derive the FULL known
 * `state`-column vocabulary — union of this + `ISSUE_FAMILY_STATES` +
 * `FEATURE_FAMILY_STATES` + `FEATURE_STATE_ALIASES` — without hand-duplicating
 * the literal list (which would silently drift out of sync with this one).
 */
export const ISSUE_STATE_ALIASES: Record<string, string> = {
  done: 'resolved',
  passed: 'resolved',
  todo: 'open',
  dropped: 'closed',
  deprecated: 'closed',
  // The "active / in-flight" canonical lifecycle dialect (CLAUDE.md + the
  // coord-lifecycle docs tell agents to set work-items in_progress/blocked/
  // needs-human) collapses to the issue family's single not-yet-settled state
  // `open` — the 3-state engineer_issues CHECK has no native in_flight state,
  // so these would otherwise throw the structural refusal (EI-450).
  in_progress: 'open',
  'in-progress': 'open',
  inprogress: 'open',
  'in progress': 'open',
  wip: 'open',
  blocked: 'open',
  'needs-human': 'open',
  needs_human: 'open',
  needshuman: 'open',
  'needs human': 'open',
  'need-human': 'open',
};

/**
 * The work-item id shape (D-008): every NEW work-item mints a kind-independent
 * `WI-NNN` id; pre-D-008 rows keep their legacy `F-NNN` (feature) / `EI-NNN`
 * (issue) ids. This is the ONE valid id shape project-wide — used by the
 * positional-write misalignment guard (EI-7927) to catch a swapped-row id
 * column carrying an obviously-wrong value (e.g. a state string in id's slot).
 */
export const WORK_ITEM_ID_PATTERN = '^(WI|F|EI)-\\d+$';

/**
 * Normalize a requested lifecycle state onto a family's NATIVE vocabulary
 * (EI-24): the families speak different dialects (feature: todo/validating/
 * passed/failing/deprecated; issue: open/resolved/closed) while callers + the
 * coord-lifecycle docs speak the canonical done/dropped/todo. Cross-dialect
 * aliases translate; an unmappable issue-family state is a typed refusal
 * LISTING the valid states (never a raw engineer_issues_state_check PG error).
 * Feature states pass through un-restricted beyond the aliases — the pipeline
 * owns that vocabulary (hfc.status carries no CHECK).
 */
export function normalizeWorkItemState(
  family: WorkItemFamily,
  state: string,
): { ok: true; state: string } | { ok: false; valid: readonly string[] } {
  if (family === 'feature') {
    // P-011 / D-010: validate against the canonical agent-settable set (folding the
    // canonical lifecycle dialect + known separator/case drift); a truly-unknown state
    // is rejected with the valid list — the GAP-5 typo guard. The DBOS pipeline writes
    // phase statuses via raw SQL and bypasses this path entirely (D-004), and trusted
    // restores bypass via setWorkItemState's allowNonCanonical.
    return normalizeFeatureStateInput(state);
  }
  const mapped = ISSUE_STATE_ALIASES[state] ?? state;
  if (ISSUE_FAMILY_STATES.includes(mapped)) return { ok: true, state: mapped };
  return {
    ok: false,
    valid: [...ISSUE_FAMILY_STATES, 'done', 'dropped', 'todo', 'in_progress', 'wip', 'blocked', 'needs-human'],
  };
}

/**
 * Bump a feature work-item's `last_progress_at` to now — the REAL item-scoped
 * progress signal (agent-activity-liveness-truth-2026-06-21 P-001, D-001/D-004).
 *
 * Call this ONLY on genuine item-scoped work that ISN'T already a state transition
 * (a checkpoint write is the canonical case — {@link setWorkItemState} folds the
 * bump into its own transition UPDATE, so it must NOT also call this). NEVER call it
 * on a bare presence heartbeat or a lease keepalive — bumping progress on a mere
 * keepalive is exactly the false "the work is advancing" signal D-001 forbids
 * (`work_item_claims.last_activity_ts` already conflates the two; this column must
 * stay clean). Only a CLAIMED feature row is credited — an unclaimed/terminal/issue
 * row matches 0 rows and is a harmless no-op (the classifier ignores progress on a
 * holderless item anyway). Fail-soft: returns false on any error so a progress bump
 * can never break the caller's primary write.
 *
 * @returns true if a held feature row was bumped, false otherwise (no match / error).
 */
export async function markFeatureProgress(harness: string, id: string): Promise<boolean> {
  if (!harness || !id) return false;
  try {
    const { sql } = getOrgPg();
    const res = await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET last_progress_at = now()
       WHERE harness_slug = ${harness} AND feature_id = ${id}
         AND taken_by IS NOT NULL AND taken_by <> ''`;
    return res.count > 0;
  } catch {
    return false;
  }
}

/** Lifecycle.setState — feature → status; issue → state. The requested state is
 *  normalized onto the family's native vocabulary first (EI-24); an unmappable
 *  state throws a typed error naming the valid set.
 *
 * Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403,
 * contract C-1): a transition INTO a terminal state (feature: passed|deprecated;
 * issue: resolved|closed) must carry both `opts.by` (the claiming principal) and
 * `opts.completionRef` (a completion summary / commit / coord / plan-item
 * reference — any non-empty evidence string). Reject otherwise, so a bare/
 * anonymous flip — e.g. a watchdog dedup marker — can never masquerade as a
 * genuine completion. `opts.skipCompletionGate` is a narrow, explicit bypass for
 * TRUSTED internal restore / system-sweep paths that are not completions at all
 * (mirrors `setIssueState`'s identical gate/bypass shape). */
export async function setWorkItemState(
  id: string,
  state: string,
  opts: {
    harness?: string;
    by?: string;
    allowNonCanonical?: boolean;
    completionRef?: string;
    completionEvidence?: CompletionVerificationEvidence;
    skipCompletionGate?: boolean;
    /**
     * EI-7125 / WI-2573: fired synchronously when the REQUESTED state aliases
     * to a DIFFERENT canonical state before the write (e.g. issue-family
     * 'blocked'/'needs-human'/'in_progress'/'wip' all collapse to 'open' —
     * EI-450, the issue family's 3-state CHECK has no richer representation).
     * Lets a caller (work_items:set_state) surface a loud note instead of the
     * silent `ok:true, state unchanged from the caller's PoV` surprise that
     * caused a real reclaim ping-pong (a caller asked for 'blocked', got back
     * 'open', with nothing distinguishing that from a no-op). Never called
     * when the requested state is already canonical.
     */
    onAlias?: (info: { requested: string; resolved: string }) => void;
    /**
     * EI-7422: a target that is ALREADY terminally completed (terminalOwner +
     * terminalCompletionRef stamped, e.g. via a peer's work_items:complete that
     * raced past a stale claimable/orient snapshot) requires an explicit `force`
     * to reopen into a non-terminal state. Without this, a stale-claim caller
     * silently stomps a peer's completion (no claim_conflict fires because the
     * peer completed without holding a claim) — the item flips back open with
     * no signal that another session's finished work was just discarded.
     */
    force?: boolean;
  } = {},
): Promise<WorkItem | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  const requestedState = state;
  const norm = normalizeWorkItemState(wi.family, state);
  if (norm.ok) {
    state = norm.state;
    if (state !== requestedState) opts.onAlias?.({ requested: requestedState, resolved: state });
  } else if (opts.allowNonCanonical && wi.family === 'feature') {
    // Trusted internal restore (e.g. autonomy tripwire revert restoring a CAPTURED
    // prior DB state, possibly a raw-SQL pipeline phase): the feature family has no DB
    // CHECK, so a non-canonical restore safely bypasses the agent-typo guard (D-010).
    // The issue family is NOT bypassable — it has a real DB CHECK that would reject it.
    state = state.trim();
  } else {
    throw new Error(
      `work_item '${id}' (kind=${wi.kind}) cannot take state '${state}' — valid: ${norm.valid.join(', ')}`,
    );
  }
  // EI-7422: refuse to silently REOPEN an item that is already terminally
  // completed by SOMEONE ELSE (terminalOwner + terminalCompletionRef stamped
  // by a different `by`) unless the caller explicitly forces it. A stale-claim
  // caller (claimed off a snapshot that predates a peer's completion) hits
  // this the same way a live claim hits claim_conflict — the peer's finished
  // work is evidence another session beat you to it, not something a plain
  // set_state should be able to discard. The item's OWN terminal owner
  // reopening its own completion (a self-correction — e.g. "actually not
  // done") is NOT gated: that is a legitimate, common lifecycle move (see the
  // resolved→open fan-out test right below) and carries no double-placement
  // risk since no second session's work is being discarded.
  if (
    !opts.force &&
    wi.terminalOwner &&
    wi.terminalCompletionRef &&
    opts.by !== wi.terminalOwner &&
    isSettledWorkItemState(wi.state) &&
    !isSettledWorkItemState(state)
  ) {
    throw new Error(
      `work_item '${id}' is already terminally completed (by ${wi.terminalOwner}: "${wi.terminalCompletionRef}") — ` +
        `reopening into '${state}' would silently discard that completion. Pass { force: true } if you are ` +
        `deliberately reopening it (e.g. the completion was wrong), otherwise investigate the peer's completion first.`,
    );
  }
  // P-006 (fleet-deltas-leader-primitives, EI-8993): an item HELD OPEN by someone
  // (payload.held_open_by — a leader gating it on a release criterion / owner
  // decision) refuses a terminal transition by ANYONE ELSE unless forced. This is
  // the dup-close guard: WI-3546-class items were "held open" only as checkpoint
  // prose, so a well-meaning peer (or a dup-close audit) closed them as stale —
  // the hold is now a FIELD this chokepoint enforces (complete + set_state both
  // route through here). The holder closing their own held item is NOT gated.
  const heldOpen = readWorkItemHeldOpenBy(wi.payload);
  if (
    !opts.force &&
    heldOpen &&
    opts.by !== heldOpen.by &&
    !isSettledWorkItemState(wi.state) &&
    isSettledWorkItemState(state)
  ) {
    throw new Error(
      `work_item '${id}' is HELD OPEN by ${heldOpen.by}${heldOpen.reason ? ` ("${heldOpen.reason}")` : ''} — ` +
        `closing it into '${state}' requires the holder (or { force: true } with a reason the holder can audit). ` +
        `If you believe the hold is stale, coordinate with the holder first (coord:send).`,
    );
  }
  let result: WorkItem | null;
  if (wi.family === 'issue') {
    if (wi.origin === 'remote') {
      throw new Error(
        `work_item '${id}' is remote-authored and cannot be mutated locally; ` +
          `its authoring peer must claim/resolve it, and this node will receive the ` +
          `terminal state through federation.`,
      );
    }
    const updated = await setIssueState(id, state as IssueState, opts.by, opts.completionRef, {
      completionEvidence: opts.completionEvidence,
      skipCompletionGate: opts.skipCompletionGate,
    });
    result = updated ? issueToWorkItem(updated) : null;
  } else {
    const isTerminal = FEATURE_TERMINAL_STATES.includes(state);
    if (isTerminal && !opts.skipCompletionGate) {
      if (!opts.by || !opts.by.trim()) {
        throw new Error(
          `completion-integrity: work_item '${id}' → '${state}' rejected — a terminal transition requires an owner (by)`,
        );
      }
      if (!opts.completionRef || !opts.completionRef.trim()) {
        throw new Error(
          `completion-integrity: work_item '${id}' → '${state}' rejected — a terminal transition requires a completionRef`,
        );
      }
    }
    const { sql } = getOrgPg();
    const evidencePayloadJson = completionEvidencePayloadJson(opts.completionEvidence);
    // D-007: a genuine terminal success/drop resets the stale-reclaim requeue
    // counter, so a later legitimate re-open starts fresh with the full cap.
    const resetRequeue = isTerminal;
    const rows = isTerminal
      ? await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${state},
             requeue_count = 0,
             taken_by = NULL,
             taken_at = NULL,
             -- agent-activity-liveness-truth P-001 (D-001/D-004): a state transition is
             -- REAL item-scoped progress — bump last_progress_at so a held item reads as
             -- progressing, not stalled. A TERMINAL row also releases its claim immediately,
             -- so the progress signal must clear with the holder instead of lingering until a
             -- later stale-claim/placement sweep.
             last_progress_at = NULL,
             updated_ts = ${Date.now()},
             terminal_owner = ${opts.by ?? null},
             terminal_completion_ref = ${opts.completionRef ?? null},
             payload = CASE WHEN ${evidencePayloadJson}::text::jsonb IS NULL
                            THEN payload
                            ELSE jsonb_strip_nulls(COALESCE(payload, '{}'::jsonb) || ${evidencePayloadJson}::text::jsonb)
                       END
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`
      : await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${state},
             requeue_count = CASE WHEN ${resetRequeue} THEN 0 ELSE requeue_count END,
             last_progress_at = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN now() ELSE last_progress_at END,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
    result = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  }
  // P-006 (fleet-deltas-leader-primitives, EI-8973): a REOPEN (settled → non-settled,
  // forced or holder-self) must CLEAR the terminal stamps — a reopened item still
  // carrying terminalOwner/terminalCompletionRef reads as "terminally completed" to
  // every later auditor/peer, which re-closes or releases it as a stale duplicate
  // (the exact loop EI-8973 reports). The stamps are ARCHIVED into
  // payload.reopenHistory (bounded, newest-last) so the audit trail survives the
  // clear. Best-effort: the reopen itself already committed; a failed clear leaves
  // the pre-P-006 behavior (stamps linger) rather than failing the state change.
  if (
    result &&
    isSettledWorkItemState(wi.state) &&
    !isSettledWorkItemState(result.state) &&
    (wi.terminalOwner || wi.terminalCompletionRef)
  ) {
    try {
      const { sql } = getOrgPg();
      const prevHistory = Array.isArray((wi.payload as Record<string, unknown> | null)?.reopenHistory)
        ? ((wi.payload as Record<string, unknown>).reopenHistory as unknown[])
        : [];
      const entry = {
        at: new Date().toISOString(),
        by: opts.by ?? null,
        force: opts.force === true,
        prevState: wi.state,
        terminalOwner: wi.terminalOwner,
        terminalCompletionRef: wi.terminalCompletionRef,
      };
      const history = JSON.stringify({ reopenHistory: [...prevHistory.slice(-4), entry] });
      await sql`
        UPDATE harness_shared.work_items
           SET terminal_owner = NULL,
               terminal_completion_ref = NULL,
               payload = COALESCE(payload, '{}'::jsonb) || ${history}::text::jsonb,
               updated_ts = ${Date.now()}
         WHERE feature_id = ${id}
           AND workspace_id IN (${issuesScopeWorkspace()}, ${activeWorkspaceId()})`;
      // Reflect the clear in the returned row so callers see the truth this turn.
      (result as { terminalOwner?: string | null }).terminalOwner = null;
      (result as { terminalCompletionRef?: string | null }).terminalCompletionRef = null;
    } catch {
      /* best-effort — see above */
    }
  }
  // event-await-discoverability-and-coverage P-101: EVERY real status transition
  // fires the general `work-item:status:<id>` — the "wake me on any change of
  // WI-X" signal (a dependency's progress, a peer's item). Complements the
  // specific done/blocked/unblocked/claimed keys below; the catalog's
  // one-entry-one-family model keeps them from being awaited together, so no
  // double-wake. Fire-and-forget + lazy import — an emit failure never breaks
  // the write.
  if (result && result.state !== wi.state) {
    const transitioned = result;
    const prevState = wi.state;
    void import('./work-items-events').then((m) => m.emitWorkItemStatusEvent(transitioned, prevState)).catch(() => {});
  }
  // await-event-primitive P-012/P-013: a SETTLED item fires
  // `work-item:done:<id>` (+ `work-item:unblocked:<dep>` for dependents whose
  // last blocker cleared). Fire-and-forget + lazy import (work-items-events
  // imports this module statically) — an emit failure never breaks the write.
  if (result && isSettledWorkItemState(result.state)) {
    const settled = result;
    void import('./work-items-events').then((m) => m.emitWorkItemSettledEvents(settled)).catch(() => {});
    // sentinel-herald P-016: when a SETTLED item is a Sentinel handoff (carries
    // the `user-requested` topic), report its landing back to the operator via
    // the hindsight "[While you were away]" channel. Same fire-and-forget +
    // lazy-import shape as the settled-events emit; the watch module reads the
    // item's topics (the cheap gate) and no-ops for any non-handoff item.
    void import('./operator-sentinel-handoff-watch')
      .then((m) =>
        m.reportHandoffLandingIfTracked(
          { id: settled.id, title: settled.title, state: settled.state, harness: settled.harness },
          async (wid, harness) => {
            const detail = await getWorkItemDetail(wid, harness ?? undefined);
            return detail?.topics ?? [];
          },
        ),
      )
      .catch(() => {});
    // voice-unified-sentinel-pipeline P-006: when a SETTLED item is a deep-thinking
    // delegation (carries the `deep-delegation` topic), inject its completion
    // summary back into the Sentinel pane as `[deep-answer WI-NNN] …` so the
    // answer is presented + spoken through the one pipeline. Same fire-and-forget
    // + lazy-import shape; the watch gates on the topic and no-ops otherwise.
    void import('./papercup/papercup-deep-watch')
      .then((m) =>
        m.injectDeepAnswerIfTracked(
          {
            id: settled.id,
            title: settled.title,
            state: settled.state,
            harness: settled.harness,
            terminalCompletionRef: (settled as { terminalCompletionRef?: string | null }).terminalCompletionRef ?? null,
          },
          async (wid, harness) => {
            const detail = await getWorkItemDetail(wid, harness ?? undefined);
            return detail?.topics ?? [];
          },
        ),
      )
      .catch(() => {});
  }
  // plugin-system-hive-port P-004: a transition INTO `blocked` fires
  // `work-item:blocked:<id>` (notifying the delegator) so blocked work is a
  // durable signal, not a prose message. Same fire-and-forget shape.
  if (result && result.state === 'blocked' && wi.state !== 'blocked') {
    const blocked = result;
    void import('./work-items-events').then((m) => m.emitWorkItemBlockedEvent(blocked)).catch(() => {});
  }
  return result;
}

/** The alias/no-op discriminator every lifecycle verb's result row should carry (EI-7712). */
export interface LifecycleAliasInfo {
  /** True when the item's PERSISTED state (post-write, read back off the row) differs
   *  from what the caller asked for — an ok:true response can still mean "not what you asked". */
  aliased: boolean;
  /** Exactly what the caller passed, before any normalization. */
  requestedState: string;
  /** The state actually persisted (workItem.state read back after the write), or null
   *  when the item was not found (setWorkItemState returned null — a separate failure
   *  mode from aliasing, surfaced by the caller's own `ok:false` path). */
  appliedState: string | null;
  /** Present only when aliased — a human-readable one-liner (kept for callers/tests
   *  already matching on this string; `aliased`/`appliedState` are the structured form). */
  aliasNote?: string;
}

/**
 * EI-9360: issue-family lifecycle requests that mean "durably gated" — the issue-family CHECK
 * has no native representation for these (ISSUE_STATE_ALIASES collapses them to 'open'), so
 * without this fix a caller who correctly marked an item needs_human/blocked got back ok:true
 * with the item STILL in the default claimable pool: `scheduler:get_next`/`claim_next` would
 * keep offering it to any fleet whose claim spec didn't defensively exclude it (observed live
 * in the M4 DRAIN battery — a foreign fleet's fallback claim-spec picked up an owner-gated
 * "rotate the production credential" item). The only prior mitigation was a caller manually
 * chaining a second call — correct, but non-discoverable and easy to forget.
 *
 * Two EXISTING self-select exclusion floors already cover this (both wired into the same
 * issue-claim query, work-items.ts's issue-claim SQL) — reused here rather than inventing a
 * third, matched to which one's REPORTING semantics fit the request:
 *   - needs-human dialect → `payload.needsHuman:true` ({@link needsHumanExclusionSql}, EI-7776,
 *     already set by improvements:resolve's `needs-human` outcome). Reports as fully DRAINED
 *     in {@link diagnoseClaimNextMiss} — correct here: an owner-authority-only item is not
 *     queue material AT ALL, no agent will ever complete it by retrying.
 *   - 'blocked' dialect → the WI-2797 self-select claim hold ({@link claimHoldExclusionSql}).
 *     Reports as pending-BUT-gated (drained:false) — correct here: "blocked" more often means
 *     blocked-on-a-dependency, which may clear on its own, not "route to a human forever".
 * Both: excluded from self-select, but still directly claimable BY ID. Best-effort — never
 * fails/blocks the primary lifecycle write.
 */
const NEEDS_HUMAN_ALIAS_REQUESTS = new Set([
  'needs-human',
  'needs_human',
  'needshuman',
  'needs human',
  'need-human',
]);
const BLOCKED_ALIAS_REQUESTS = new Set(['blocked']);

/**
 * setWorkItemState wrapped to ALWAYS report the alias/no-op discriminator (EI-7712,
 * extending the EI-7125/WI-2573 onAlias plumbing that only fired for the ONE mismatch
 * class `normalizeWorkItemState` itself detects). This compares the ACTUAL persisted
 * `workItem.state` read back after the write against what the caller asked for — a
 * strictly BROADER check than trusting `onAlias` alone, so a future silent-divergence
 * bug in a DIFFERENT layer (not the normalize step) still shows up as `aliased:true`
 * instead of a repeat of the WI-2381 incident (ok:true, state silently stayed 'open',
 * only discovered by an unrelated list read 10min later).
 *
 * The shared helper both work_items:set_state and work_items:complete call, so every
 * lifecycle verb inherits the SAME contract instead of each hand-rolling its own
 * onAlias wiring (which is how the gap stayed needs-human-only for as long as it did).
 */
export async function setWorkItemStateWithAliasInfo(
  id: string,
  requestedState: string,
  opts: Parameters<typeof setWorkItemState>[2] = {},
): Promise<{ workItem: WorkItem | null } & LifecycleAliasInfo> {
  let onAliasInfo: { requested: string; resolved: string } | undefined;
  const workItem = await setWorkItemState(id, requestedState, {
    ...opts,
    onAlias: (info) => {
      onAliasInfo = info;
      opts.onAlias?.(info);
    },
  });
  const appliedState = workItem ? workItem.state : null;
  const aliased = appliedState !== null && appliedState !== requestedState;
  // EI-9360: a caller who asked for an owner-gate dialect state (blocked/needs-human/…) that
  // collapsed to 'open' gets the matching exclusion floor applied automatically — see the
  // NEEDS_HUMAN_ALIAS_REQUESTS / BLOCKED_ALIAS_REQUESTS doc comment above.
  let autoGateNote: string | null = null;
  if (workItem && workItem.family === 'issue' && onAliasInfo && onAliasInfo.resolved === 'open') {
    const req = onAliasInfo.requested.trim().toLowerCase();
    // Awaited (not fire-and-forget): callers rely on `aliased:true` meaning the item is
    // ALREADY durably parked by the time this resolves, not eventually.
    try {
      if (NEEDS_HUMAN_ALIAS_REQUESTS.has(req)) {
        await mergeIssuePayload(id, { needsHuman: true });
        autoGateNote =
          ' It has been auto-routed to a human (payload.needsHuman) — excluded from claim_next/scheduler:get_next self-selection (reads as drained, not pending) until cleared.';
      } else if (BLOCKED_ALIAS_REQUESTS.has(req)) {
        const held = await setWorkItemClaimHold(id, true, { harness: opts.harness, by: opts.by, reason: req });
        if (held?.applicable) {
          autoGateNote =
            ' It has been auto-parked (claim hold) out of claim_next/scheduler:get_next self-selection until released — see work_items:release{claimHold:false}.';
        }
      }
    } catch {
      /* best-effort — never fail the primary lifecycle write over the auto-gate */
    }
  }
  return {
    workItem,
    aliased,
    requestedState,
    appliedState,
    ...(aliased
      ? {
          aliasNote: onAliasInfo
            ? `requested state '${onAliasInfo.requested}' has no distinct representation for this item's family — recorded as '${onAliasInfo.resolved}' instead.${autoGateNote ?? ''}`
            : `requested state '${requestedState}' was not applied verbatim — recorded as '${appliedState}' instead.`,
        }
      : {}),
  };
}

// ── completion-integrity metric (work-item-completion-integrity-2026-07-01 WI-1405,
// contract C-1 consumer) ─────────────────────────────────────────────────────────
//
// setWorkItemState/setIssueState (above) enforce that a terminal transition carries
// BOTH terminal_owner AND terminal_completion_ref UNLESS the caller explicitly passed
// skipCompletionGate (the watchdog/hygiene/revert dedup-marker paths — WI-1404). That
// means the RAW terminal-state count silently blends genuine completions with dedup
// flips; this read separates them so fleet-facing status never counts a dedup flip as
// real work.

export interface CompletionIntegrityStats {
  harness: string;
  /** Every work-item (both families) currently sitting in a terminal state. */
  terminalTotal: number;
  /** Terminal AND carrying both terminal_owner + terminal_completion_ref — the ONLY
   *  rows the completion-integrity gate would have accepted without skipCompletionGate. */
  genuineCompletions: number;
  /** terminalTotal - genuineCompletions — watchdog/hygiene/revert dedup flips (or any
   *  other skipCompletionGate write, or a pre-migration-432 historical row with the
   *  columns still null). */
  dedupOrUnverified: number;
}

/**
 * Read the genuine-vs-dedup completion split for one harness. Feature-family rows are
 * scoped by activeWorkspaceId() + harness_slug (mirrors setWorkItemState's own scope);
 * issue-family rows by issuesScopeWorkspace() (mirrors setIssueState's own scope) — the
 * two families use different workspace conventions today (F-B2 / ISSUES_PER_WORKSPACE),
 * so a single workspace_id filter would silently miss or leak rows for one family.
 */
export async function getCompletionIntegrityStats(harness: string): Promise<CompletionIntegrityStats> {
  const { sql } = getOrgPg();
  const [featureRows, issueRows] = await Promise.all([
    sql<{ terminal_total: string; genuine: string }[]>`
      SELECT
        count(*) FILTER (WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])) AS terminal_total,
        count(*) FILTER (
          WHERE status = ANY(${FEATURE_TERMINAL_STATES}::text[])
            AND terminal_owner IS NOT NULL AND terminal_owner <> ''
            AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
        ) AS genuine
      FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${harness}`,
    sql<{ terminal_total: string; genuine: string }[]>`
      SELECT
        count(*) FILTER (WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])) AS terminal_total,
        count(*) FILTER (
          WHERE state = ANY(${[...ISSUE_TERMINAL_STATUSES]}::text[])
            AND terminal_owner IS NOT NULL AND terminal_owner <> ''
            AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
        ) AS genuine
      FROM harness_shared.engineer_issues
      WHERE workspace_id = ${issuesScopeWorkspace()} AND scope = ${`harness:${harness}`}`,
  ]);
  const terminalTotal = Number(featureRows[0]?.terminal_total ?? 0) + Number(issueRows[0]?.terminal_total ?? 0);
  const genuineCompletions = Number(featureRows[0]?.genuine ?? 0) + Number(issueRows[0]?.genuine ?? 0);
  return { harness, terminalTotal, genuineCompletions, dedupOrUnverified: terminalTotal - genuineCompletions };
}

// ── live-verified marker (release-pipeline-resilience-2026-06-09 P-013) ──────────
//
// "done" on a pipeline/operator work-item means code-on-staging; its VALUE only exists once
// DEPLOYED + exercised. live_verified is an ADDITIVE payload marker (NOT a new lifecycle state —
// the core enum is deliberately untouched, D-013 sketch) recording that a human/agent confirmed the
// change live: { at, by, deployedSha?, evidence? }. Feature-family only (the dispatched backlog the
// plan targets); issue-family items report applicable:false without writing.

export interface WorkItemLiveVerified {
  /** epoch ms the live-verification was recorded. */
  at: number;
  /** who confirmed it (ownerId / actor). */
  by: string;
  /** the deployed commit verified against (from release:deploy status / dev:pipeline_position). */
  deployedSha?: string | null;
  /** free-text proof — what was exercised, where. */
  evidence?: string | null;
}

export interface WorkItemLiveVerifiedResult {
  id: string;
  /** false ⇒ a non-feature-family item (no dispatched-backlog payload to mark); nothing was written. */
  applicable: boolean;
  liveVerified: WorkItemLiveVerified | null;
}

/** Read the live_verified marker off a work-item payload (null if unset / malformed). */
export function readWorkItemLiveVerified(payload: unknown): WorkItemLiveVerified | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const lv = (payload as Record<string, unknown>).live_verified;
    if (lv && typeof lv === 'object' && !Array.isArray(lv)) {
      const m = lv as Record<string, unknown>;
      if (typeof m.at === 'number' && typeof m.by === 'string') {
        return {
          at: m.at,
          by: m.by,
          deployedSha: typeof m.deployedSha === 'string' ? m.deployedSha : null,
          evidence: typeof m.evidence === 'string' ? m.evidence : null,
        };
      }
    }
  }
  return null;
}

/**
 * Set (marker) or clear (marker=null) a work-item's live_verified payload marker. An additive JSONB
 * merge that PRESERVES the rest of the payload (e.g. the plan_item back-pointer); clear removes only
 * the `live_verified` key. Feature-family only — a non-feature item returns applicable:false without
 * writing. Returns null when the item does not exist. Does NOT touch the lifecycle state column.
 */
export async function setWorkItemLiveVerified(
  id: string,
  marker: WorkItemLiveVerified | null,
  opts: { harness?: string } = {},
): Promise<WorkItemLiveVerifiedResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    return { id: wi.id, applicable: false, liveVerified: readWorkItemLiveVerified(wi.payload) };
  }
  const { sql } = getOrgPg();
  let rows: FeatureRowDb[];
  if (marker === null) {
    rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) - 'live_verified',
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  } else {
    const patch = JSON.stringify({ live_verified: marker });
    rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  }
  const updated = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  if (!updated) return null;
  return { id: updated.id, applicable: true, liveVerified: readWorkItemLiveVerified(updated.payload) };
}

/**
 * EI-7214 — persist a completion's `outputPayload` onto the work-item row (under
 * `payload.out`), so it becomes a self-serve, queryable read surface (e.g. the
 * harness `GET /api/harness/:slug/work-items` route, which already returns
 * `payload`) instead of existing ONLY as a transient field on the `emits` event
 * result. Before this, every harness sidecar needing to pull a completed item's
 * structured output (oddsmith's bet-analysis Signal, quartermaster's sidecar⇄
 * papercusp seam) had to hand-roll its OWN reaction-rule bridge to capture the
 * event at completion time — `fetchCompleted` shipped as a permanent TODO for
 * exactly this reason. One additive JSONB merge here removes that whole class
 * of per-harness boilerplate.
 *
 * Additive (mirrors `setWorkItemLiveVerified`): preserves every other payload
 * key (e.g. the plan_item back-pointer). Best-effort from the caller's
 * perspective — never throws; a merge failure must not fail the completion
 * that already recorded the completion record. Works across BOTH families
 * (feature-family rows live in harness_features_consolidated; issue-family
 * rows route through the existing `mergeIssuePayload`).
 */
export async function mergeWorkItemOutputPayload(
  id: string,
  outputPayload: unknown,
  opts: { harness?: string } = {},
): Promise<void> {
  try {
    const wi = await getWorkItem(id, opts.harness);
    if (!wi) return;
    if (wi.family === 'issue') {
      await mergeIssuePayload(id, { out: outputPayload });
      return;
    }
    const { sql } = getOrgPg();
    const patch = JSON.stringify({ out: outputPayload });
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = COALESCE(payload, '{}'::jsonb) || ${patch}::text::jsonb,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}`;
  } catch {
    // Best-effort: the completion record itself already succeeded/emitted;
    // a failed payload-persist must never surface as a failed completion.
  }
}

/**
 * Claimable.claim — the tuple-space atomic `in` for a SPECIFIC item (feature → taken_by;
 * issue → assignee). Atomic compare-and-claim (fleet-as-supervised-blackboard D-004):
 * the feature-family UPDATE only succeeds when the item is unclaimed OR already held by
 * this same assignee (idempotent). A competing claim on a held item gets null — exactly
 * one agent wins, instead of the old last-write-wins overwrite where both "won".
 */
export async function claimWorkItem(
  id: string,
  assignee: string,
  opts: { harness?: string } = {},
): Promise<WorkItem | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  let claimed: WorkItem | null;
  if (wi.family === 'issue') {
    const updated = await claimIssue(id, assignee);
    claimed = updated ? issueToWorkItem(updated) : null;
  } else {
    const { sql } = getOrgPg();
    // ws scopes the P-010 trust subquery in autoPickableWhereSql (D-004 — explicit,
    // never RLS-reliant). The UPDATE itself keys on (harness_slug, feature_id) (the PK).
    const ws = activeWorkspaceId();
    const rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = ${assignee}, taken_at = now(),
             -- P-001: a NEW holder starts with a clean progress slate (so the grace
             -- window anchors on the fresh taken_at, not a prior holder's stale
             -- last_progress_at); a re-claim by the SAME agent keeps its progress.
             last_progress_at = CASE WHEN taken_by = ${assignee} THEN last_progress_at ELSE NULL END,
             updated_ts = ${Date.now()}
       WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
         AND (taken_by IS NULL OR taken_by = '' OR taken_by = ${assignee})
         -- G2 admission (shared-hive-trust-admission P-003): an explicit named claim
         -- can't bypass the auditor either — remote, un-admitted stays unclaimable
         -- (unless its verified author is trusted — P-010 trust leg, ws-scoped).
         AND ${autoPickableWhereSql(sql, ws)}
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
    claimed = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  }
  // plugin-system-hive-port P-004: a successful claim fires `work-item:claimed:<id>`
  // (events:await leg; reaction rules observe the claim tools via postInvoke).
  if (claimed) {
    const won = claimed;
    void import('./work-items-events').then((m) => m.emitWorkItemClaimedEvent(won, assignee)).catch(() => {});
  }
  return claimed;
}

/**
 * Why did `claimWorkItem`/`claimIssue` return null? (EI-2197.)
 *
 * The compare-and-claim returns a bare `null` for THREE very different outcomes,
 * and the claim TOOLS historically flattened all of them into the single
 * misleading message `work_item '<id>' not found` — which sent agents into a
 * pointless retry-with-harness dance (the id WAS resolvable via get/observe/
 * comment/complete) and HID the real signal (lost a race / a dead claim needs
 * taking over). This classifier re-reads the item's CURRENT state and names the
 * outcome so the tool can return an accurate, actionable error:
 *
 *   • not_found — genuinely absent (get also returns null).
 *   • conflict  — exists, held by ANOTHER agent. The caller lost the
 *     compare-and-claim race, OR the holder is dead (→ the stale-claim reclaim
 *     lane frees it; don't blind-retry — coordinate, or take over once freed).
 *   • gated     — exists, NOT held, but the claim was refused by the
 *     feature-family admission/trust gate (autoPickableWhereSql), or a race just
 *     released it between the failed claim and this re-read.
 *
 * Pure over the already-fetched row so it unit-tests without a DB. A self-held
 * item re-claims idempotently (claim would have SUCCEEDED), so reaching here with
 * holder === claimer is not a real conflict — reported as `gated` for safety.
 */
export type ClaimFailure =
  | { reason: 'not_found'; holder: null }
  | { reason: 'conflict'; holder: string }
  | { reason: 'gated'; holder: null };

export function classifyClaimFailure(current: { assignee?: string | null } | null, claimer: string): ClaimFailure {
  if (!current) return { reason: 'not_found', holder: null };
  const holder = current.assignee?.trim();
  if (holder && holder !== claimer) return { reason: 'conflict', holder };
  return { reason: 'gated', holder: null };
}

export interface ClaimNextFilter {
  harness: string;
  assignee: string;
  /** Restrict to one feature-family kind (default: any feature-family). */
  kind?: FeatureFamilyKind;
  /** Claimable states (default ['todo']). */
  states?: string[];
  /**
   * THIS Swarm's id (hive-coordination-model P-002, the co-location lever). When set,
   * the claim HONORS each item's `swarm_affinity`: work affined to a DIFFERENT Swarm is
   * skipped, and work affined to THIS Swarm is preferred over unaffined work. The caller
   * passes this ONLY when the per-Hive claim lease is active
   * (the `WORKITEM_CLAIM_LEASE` flag); omitted (the single-instance default) the claim
   * is byte-identical to before — oldest-first, affinity ignored.
   */
  swarmId?: string;
  /**
   * Skip HIGH-STAKES (redundancy > 1) items so they are NOT exclusively claimed
   * (decentralized-dispatch-scaling P-014). A redundant item is dispatched via
   * `work_items:claim_replica` to N Swarms instead — claim_next grabbing it exactly-once
   * would defeat the redundancy. The caller passes this ONLY when the redundancy flag is on
   * (`PAPERCUSP_WORKITEM_REDUNDANCY=1`); omitted (the default) the claim never reads the
   * `redundancy` column, byte-identical to before.
   */
  excludeRedundant?: boolean;
  /**
   * WI-2796: the caller actually has (or coordinates) a live ≥2-machine / Hetzner
   * federation rig, so items carrying `payload.needs_2_machine_rig:true` should NOT be
   * excluded from self-select for it. Omitted (the single-box default) ⇒ those items
   * are excluded — see {@link crossMachineRigExclusionSql}.
   */
  rigAvailable?: boolean;
}

/**
 * The GLOBAL HARD FLOORS of a feature-family self-select, as ONE composable `sql`
 * WHERE fragment (hybrid-bee-scheduler-work-stealing-2026-06-22 D-002/D-010). These
 * are the system-enforced eligibility gates a bee's claim-spec can NARROW + REORDER
 * but can NEVER override or re-assert: workspace + feature-family kind, G2 admission,
 * unclaimed, claimable status, swarm affinity, redundancy fan-out, and the readiness
 * `NOT EXISTS` blocking clause (P-005, the F1 split-brain fix).
 *
 * Extracted so the deterministic spec-driven resolver (`scheduler/get-next.ts`) ANDs
 * in the IDENTICAL floors — there is exactly one definition, so a floor can never
 * drift between the two claim paths. The fragment references columns UNQUALIFIED
 * (and the blocking subquery references the table by its full name), so it is only
 * valid composed into an inner SELECT over `harness_shared.harness_features_consolidated`.
 *
 * The `kind` floor is intentionally NOT here: it is a caller-supplied NARROWING (an
 * optional restriction to one feature-family kind), not a floor the spec can't touch.
 */
export interface ClaimFloorsOpts {
  harness: string;
  /** The active workspace id (scopes both the row filter and the admission trust leg). */
  workspaceId: string;
  /** Claimable statuses (default ['todo']). */
  states?: string[];
  /** THIS Swarm's id — when set, honors per-item swarm_affinity (per-Hive lease). */
  swarmId?: string;
  /** Skip high-stakes (redundancy > 1) items (redundancy flag on). */
  excludeRedundant?: boolean;
  /**
   * work-item-deps-and-readiness P-005: when true (SCHEDULER_MAINTAINED_READY on), read readiness
   * from the maintained `work_item_blocked` sidecar (an indexed anti-join) instead of the inline
   * per-claim NOT EXISTS over work_item_deps + statuses. Behavior-identical; a performance cutover.
   * Both claim entry points (claimNextWorkItem + getNextWorkItem) resolve the flag and pass it here,
   * so the two paths can never drift (D-002). Default/false ⇒ the inline predicate (byte-identical).
   */
  useMaintainedReady?: boolean;
  /**
   * Release-cooldown floor (fleet-scheduler-hardening-2026-07-03 P-005 / EI-6956): when set to
   * the CLAIMING agent's ownerId, a row THIS agent voluntarily released within the cooldown
   * window is excluded — for this agent only; every other agent can claim it instantly. Kills
   * the claim/release ping-pong (release resets a row to `todo`, and under a stable rank it
   * sorts right back to the top for the same bee). Both claim entry points thread their
   * claimant here, so the two paths share one cooldown.
   */
  cooldownAssignee?: string;
}

/** Release-cooldown window (seconds). Env-overridable; small on purpose — the floor only
 *  has to outlast one release→re-pull cycle, not park the item. */
export function releaseCooldownSec(): number {
  const v = Number(process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC ?? 300);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 300;
}

export function claimFloorsWhereSql(sql: OrgSql, opts: ClaimFloorsOpts) {
  const states = opts.states ?? ['todo'];
  const cooldown = releaseCooldownSec();
  return sql`
    harness_slug = ${opts.harness}
    AND workspace_id = ${opts.workspaceId}
    -- Release-cooldown floor (mig 485 / EI-6956): NULL-safe — rows never released, or
    -- released by someone else, or released long enough ago, all pass.
    AND ${
      opts.cooldownAssignee && cooldown > 0
        ? sql`(last_released_by IS NULL
        OR last_released_by <> ${opts.cooldownAssignee}
        OR last_released_at IS NULL
        OR last_released_at < now() - make_interval(secs => ${cooldown}))`
        : sql`TRUE`
    }
    -- Built-in placeable kinds + any generic-kind datatype that opted into placement
    -- (the 'hive-placement' tag — frontierPlacementKindClause). DARK until a datatype opts in.
    AND ${frontierPlacementKindClause(sql, opts.workspaceId)}
    -- G2 admission (shared-hive-trust-admission P-002): never self-select a remote,
    -- un-admitted item — the same gate the feature frontier enforces (P-010 trust leg,
    -- ws-scoped via the same ws this query filters on).
    AND ${autoPickableWhereSql(sql, opts.workspaceId)}
    AND (taken_by IS NULL OR taken_by = '')
    AND status = ANY(${states}::text[])
    -- P-006 (fleet-deltas-leader-primitives): the claim-hold floor, extended to the
    -- FEATURE family. The issue-family claim already honors payload._claimHold
    -- (claimHoldExclusionSql, WI-2797) — but the incident class that motivated
    -- held_open_by (EI-8993: a leader-held FEATURE like WI-3548 getting claim_next'd
    -- off the leader the moment its claim lapsed) lived on THIS path, which never
    -- read the tag. Same COALESCE-for-NULL-safety shape, unaliased (this fragment
    -- runs in harness_features_consolidated context).
    AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
    AND ${opts.swarmId ? sql`(swarm_affinity IS NULL OR swarm_affinity = ${opts.swarmId})` : sql`TRUE`}
    -- P-014: under the redundancy flag, high-stakes (redundancy > 1) items fan out via
    -- claim_replica to N Swarms, so an exactly-once claim must NOT grab them. Flag OFF ⇒
    -- clause omitted, the claim never reads the redundancy column, byte-identical to before.
    AND ${opts.excludeRedundant ? sql`(redundancy IS NULL OR redundancy <= 1)` : sql`TRUE`}
    -- P-005 (F1 fix): RESPECT blocking — never self-select a row that has a PRESENT,
    -- NON-TERMINAL blocker, the SAME readiness the orchestrator frontier enforces
    -- (frontier-readiness.ts / work-item-blocking.ts). The block edges live in the
    -- dedicated work_item_deps table (dep_type='blocks'), keyed by harness-qualified refs
    -- ('<harness>#<feature_id>' for features, bare 'EI-<n>' for issues — featureRef /
    -- issues:link), in the single coordination workspace ('default'). A blocker is
    -- SATISFIED iff TERMINAL or ABSENT; we exclude the row only when a present blocker is
    -- non-terminal — feature terminal = status IN ('passed','deprecated'); issue terminal =
    -- state IN ('resolved','closed') (the cross-family set, ALL_TERMINAL_STATUSES). An
    -- absent blocker ref (no matching feature/issue row) never blocks.
    --
    -- P-005 maintained-readiness cutover (SCHEDULER_MAINTAINED_READY): when ON, the SAME predicate
    -- is read from the maintained work_item_blocked sidecar (an indexed anti-join, presence = not
    -- ready) the wir_ triggers keep exact, instead of recomputing the correlated subquery per claim.
    -- The two forms are equivalent (the sidecar is materialized from this exact predicate + a
    -- reconciliation oracle); OFF is the byte-identical inline form.
    AND ${
      opts.useMaintainedReady
        ? sql`NOT EXISTS (
      SELECT 1
        FROM harness_shared.work_item_blocked wb
       WHERE wb.workspace_id = harness_shared.harness_features_consolidated.workspace_id
         AND wb.harness_slug = harness_shared.harness_features_consolidated.harness_slug
         AND wb.feature_id   = harness_shared.harness_features_consolidated.feature_id
    )`
        : sql`NOT EXISTS (
      SELECT 1
        FROM harness_shared.work_item_deps d
       WHERE d.workspace_id = 'default'
         AND d.dep_type = 'blocks'
         AND d.blocked_ref = harness_shared.harness_features_consolidated.harness_slug
                               || '#' || harness_shared.harness_features_consolidated.feature_id
         AND (
           EXISTS (
             SELECT 1 FROM harness_shared.harness_features_consolidated bf
              WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                AND bf.status NOT IN ('passed', 'deprecated')
           )
           OR EXISTS (
             SELECT 1 FROM harness_shared.engineer_issues bi
              WHERE bi.workspace_id = 'default'
                AND bi.issue_id = d.blocker_ref
                AND bi.state NOT IN ('resolved', 'closed')
           )
         )
    )`
    }`;
}

/**
 * The tuple-space associative `in` (D-004) + work-stealing claim (D-007): atomically
 * claim the OLDEST unclaimed feature-family work-item matching the template, via
 * `SELECT … FOR UPDATE SKIP LOCKED`. Competing consumers each grab a DIFFERENT row
 * (skip-locked, no blocking, no double-claim); ordering by created_ts ASC steals the
 * most-starved tail of the queue, which balances load AND prevents old-item starvation.
 * Returns the claimed item, or null when nothing matches.
 *
 * The eligibility floors are the shared {@link claimFloorsWhereSql} fragment — the
 * SAME floors the spec-driven `scheduler/get-next.ts` resolver ANDs in, so the two
 * claim paths can never diverge (D-002).
 */
/**
 * Whether the scheduler claim reads the maintained `work_item_blocked` sidecar (an indexed
 * anti-join) vs the inline NOT EXISTS predicate — the SCHEDULER_MAINTAINED_READY cutover (P-005).
 * Resolved async at BOTH claim entry points (claimNextWorkItem + getNextWorkItem) so the two paths
 * can never drift (D-002). Fail-CLOSED to the inline predicate (false) on any flag-store error —
 * the proven path is the safe default.
 */
export async function schedulerMaintainedReadyEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SCHEDULER_MAINTAINED_READY, systemDistinctId());
  } catch {
    return false;
  }
}

/**
 * Whether the scheduler may SELF-PICK issue-family work-items (bug|change|task) —
 * the SCHEDULER_ISSUES_CLAIMABLE gate (work-item-deps-and-readiness-2026-06-22 P-007).
 *
 * DEFAULT OFF (owner-authority): adding the issue family to the dispatched backlog is a
 * brand-new SOURCE of work the autonomous fleet picks up, which the owner ratifies. When
 * OFF the issue-claim branch + the issue-applicable steer levers are inert, so the claim
 * path + set_priority / co_locate stay BYTE-IDENTICAL to feature-only behavior. Fail-CLOSED
 * to OFF (false) on any flag-store error — the proven feature-only path is the safe default.
 */
export async function schedulerIssuesClaimableEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SCHEDULER_ISSUES_CLAIMABLE, systemDistinctId());
  } catch {
    return false;
  }
}

/**
 * WI-2118 (the P-009 leak): the "reserved plan-lane" self-select EXCLUSION floor for issue-family
 * claims. An issue-family work-item can carry a `payload.plan_item` back-pointer binding it to a
 * plan-item LANE (P-NNN of some plan). When that lane is being ACTIVELY driven — the parent plan is
 * `active`, or the plan-item is under a LIVE lease held by ANOTHER agent — the item belongs to that
 * lane's own dispatch, NOT the general backlog-clearance drain. Without this floor the drain SCOOPS
 * such an item into the shared claim pool; members that know the lane is reserved (its plan's
 * `## Now`) correctly REFUSE + release it, and the scheduler immediately re-serves it — the
 * claim→refuse→re-serve CHURN the owner flagged (WI-2118 was served to 3 different members in
 * minutes). The floor is the durable fix: a reserved-lane item is never offered to self-select at all.
 *
 * SOUND + narrow: it fires ONLY when (a) the linked plan's status is `active` (a plan under execution
 * reserves its items), or (b) a non-lapsed `plan_item_claims` lease is held by a DIFFERENT owner. A
 * plan that is draft/ready/shipped/superseded, or a lane whose lease has lapsed with no active plan,
 * is NOT excluded — those items drain normally (no starvation of genuinely-free backlog). A member
 * can still claim a reserved item DIRECTLY by id (the named-claim floor bypass) when it legitimately
 * owns the lane. Assumes the table is aliased `wi` (both call sites do).
 *
 * ONE source of truth, shared by {@link claimNextIssueWorkItem} (the claim) and
 * {@link diagnoseClaimNextMiss} (the READY count), so the "why did I miss" diagnosis can never
 * disagree with what the claim actually serves.
 */
export function reservedPlanLaneExclusionSql(sql: OrgSql, assignee: string) {
  // COALESCE the payload so a NULL-payload row (no plan_item back-pointer) reads as
  // `'{}'::jsonb ? 'plan_item'` = FALSE ⇒ NOT(FALSE AND …) = TRUE ⇒ the row is INCLUDED
  // (never excluded). A bare `NULL ? 'plan_item'` would yield NULL and wrongly drop the row.
  return sql`NOT (
    COALESCE(wi.payload, '{}'::jsonb) ? 'plan_item' AND (
      EXISTS (
        SELECT 1 FROM harness_shared.harness_plans p
         WHERE p.plan_slug = wi.payload->'plan_item'->>'plan_slug'
           AND p.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM harness_shared.plan_item_claims c
         WHERE c.plan_slug = wi.payload->'plan_item'->>'plan_slug'
           AND c.item_id  = wi.payload->'plan_item'->>'item_id'
           AND c.expires_ts > now()
           AND c.owner <> ${assignee}
      )
    )
  )`;
}

/**
 * WI-2796: the "cross-machine rig required" self-select EXCLUSION floor for issue-family
 * claims. Some issue-family work-items (mostly task-kind shared-hive-p2p Briefs/scenarios)
 * carry `payload.needs_2_machine_rig: true` because their actual execution needs a LIVE
 * ≥2-machine / Hetzner federation rig a single-box fleet member cannot provide. Without
 * this floor a single-box drain member self-selects one via claim_next, discovers it is
 * un-doable solo, and releases it — pure recycle churn (WI-2796 observed 19 such items
 * cycling this way during the 2026-07-04 backlog-clearance drain).
 *
 * `rigAvailable` is the caller-declared bypass: a fleet that DOES have/coordinate a real
 * multi-machine rig passes `rigAvailable:true` and the floor becomes a no-op (`TRUE`) so
 * those items surface to it normally. Omitted/false (the default, single-box case) ⇒ any
 * `needs_2_machine_rig:true` row is excluded from self-select. A member can still claim
 * such an item DIRECTLY BY ID (the named-claim floor bypass, same shape as the reserved-
 * plan-lane floor above) when it legitimately has rig access.
 *
 * ONE source of truth, shared by {@link claimNextIssueWorkItem} (the claim) and
 * {@link diagnoseClaimNextMiss} (the READY count) so the miss diagnosis can never
 * disagree with what the claim actually serves.
 */
export function crossMachineRigExclusionSql(sql: OrgSql, rigAvailable: boolean | undefined) {
  if (rigAvailable) return sql`TRUE`;
  // COALESCE the payload so a NULL-payload row (no rig tag) reads as '{}'::jsonb->>'...' =
  // NULL, and `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(wi.payload, '{}'::jsonb) ->> 'needs_2_machine_rig' IS DISTINCT FROM 'true'`;
}

/**
 * WI-2797: the "claim hold" self-select EXCLUSION floor for issue-family claims. Some
 * issue-family items must NOT be opportunistically self-picked (e.g. one flagged "needs a
 * dedicated gateway-owning agent, do not pick up" — the WI-652 ping-pong that motivated this)
 * yet the issue-family state dialect has only open|resolved|closed, so there is no non-terminal
 * "parked" state to move it to. Rather than widen the shared generic LifecycleState enum (a
 * wide-blast-radius change touching every consumer of that borrowable primitive — see the
 * WI-2797 thread's investigation), a `payload._claimHold: true` tag is a scoped, additive,
 * no-migration lever: set it (setWorkItemClaimHold) and the item disappears from self-select
 * while staying fully visible/editable/commentable and still directly claimable BY ID (the same
 * named-claim bypass the reserved-plan-lane and cross-machine-rig floors already allow).
 *
 * Mirrors {@link crossMachineRigExclusionSql}'s shape exactly (same COALESCE-for-NULL-safety
 * pattern) and is likewise ONE source of truth shared by {@link claimNextIssueWorkItem} (the
 * claim) and {@link diagnoseClaimNextMiss} (the READY count) so the miss diagnosis can never
 * disagree with what the claim actually serves.
 */
export function claimHoldExclusionSql(sql: OrgSql) {
  // COALESCE the payload so a NULL-payload row (no hold tag) reads as '{}'::jsonb->>'...' =
  // NULL, and `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(wi.payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'`;
}

/**
 * The OBSERVATION-LANE self-select EXCLUSION floor for issue-family claims. A
 * `payload.lane:'observation'` row is a turn-end-reflection / rubric scorecard filed via
 * `improvements:capture { lane:'observation' }` (D-005): by DESIGN it "never enters the work
 * queue/triage/auto-implement — only Scout's corpus-digest + the Observations pane read it".
 * But these rows land in `harness_shared.work_items` as issue-family `change`-kind rows, so
 * WITHOUT this floor the oldest-first self-select serves them like real work — a single-box
 * drain member claims a scorecard, finds there is nothing to DO (its payload IS the whole
 * deliverable), and releases it: pure recycle churn. This was the dominant pool pollutant
 * (922 open observation rows vs 854 real issue/feature items, 2026-07-05) and the root of the
 * recurring "claim_next keeps surfacing lane:observation scorecards" friction
 * (EI-7503/EI-7587/EI-7741). This floor makes the claim path HONOR the D-005 "never enters the
 * work queue" contract the capture tool already advertises.
 *
 * UNCONDITIONAL (unlike the rig floor's caller bypass): no self-select caller legitimately
 * wants an observation record — the Observations pane / Scout digest read them directly, never
 * by claiming. Still directly claimable BY ID (the same named-claim bypass every issue floor
 * allows), so an operator can still inspect/edit one.
 *
 * Mirrors {@link claimHoldExclusionSql}'s shape (same COALESCE-for-NULL-safety pattern) and is
 * likewise ONE source of truth shared by {@link claimNextIssueWorkItem} (the claim) and
 * {@link diagnoseClaimNextMiss} (both the POOL and READY counts) so the miss diagnosis can
 * never disagree with what the claim actually serves. Applied to the POOL count too (not just
 * READY, as the rig/claimHold floors are) because an observation row is not work-queue
 * material AT ALL (D-005) — a queue of only scorecards must read `drained:true` so a drainer
 * idles, rather than the "pending-but-gated, don't idle" verdict a held-but-real item gets.
 */
export function observationLaneExclusionSql(sql: OrgSql) {
  // COALESCE so a NULL-payload row reads NULL ->> 'lane' = NULL, and
  // `NULL IS DISTINCT FROM 'observation'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'`;
}

/**
 * The NEEDS-HUMAN self-select EXCLUSION floor for issue-family claims (EI-7776). When the
 * implement worker resolves an item with outcome `needs-human`, `improvements:resolve` posts a
 * diagnosis comment, sets `payload.needsHuman:true`, and RELEASES the claim
 * (resolve-core.ts) — but the issue-family status dialect has no real terminal "needs human"
 * state (`normalizeIssueLikeState` collapses `needs-human`/`blocked`/`wip` all to `open`,
 * EI-450), so the row stays fully self-selectable. `classifyImprovement` (policy.ts) already
 * keeps a needsHuman-flagged item out of the AUTOMATED improvement-dispatch tier, but that
 * policy check lives ONLY in the improvement-dispatch path — `scheduler:get_next` /
 * `work_items:claim_next` (the generic backlog-drain self-select every fleet member pulls
 * through) never looked at `needsHuman` at all. The result: a drain-loop bee re-claims the
 * SAME already-routed-to-a-human item, re-investigates from scratch, and re-posts the
 * identical diagnosis comment — confirmed live as EI-7592 being independently "resolved" as
 * the same false positive three times in one afternoon (2026-07-05) before this floor existed.
 * Mirrors {@link observationLaneExclusionSql}'s shape/placement exactly (same NULL-safe
 * COALESCE, same POOL+READY+claim call sites) so an all-needs-human backlog also reads
 * `drained:true` instead of "pending but gated" — still directly claimable BY ID so an
 * operator (or the human it was routed to) can still act on it.
 */
export function needsHumanExclusionSql(sql: OrgSql) {
  // COALESCE so a NULL-payload row reads NULL ->> 'needsHuman' = NULL, and
  // `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).
  return sql`COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' IS DISTINCT FROM 'true'`;
}

/**
 * The FEDERATION-DETECTOR self-select EXCLUSION floor for issue-family claims (WI-2633). The
 * replication-liveness detector (replication-stall-ei.ts, P-004/WI-1840) auto-files durable EIs
 * for connected-but-dead peers (no_replicator / frozen / connected_never_replicated /
 * drain_stalled / drain_backlog_stalled / drain_orphan_tail). These land in the GENERAL
 * papercusp backlog every fleet member self-pulls through, but a generic backlog-drain worker
 * structurally CANNOT resolve one: verifying the current verdict needs the p2p-release-readiness
 * fleet's live IN-PROCESS getReplicationLiveness()/dogfood-substrate-status (not PG-queryable),
 * or design judgment on core swarm-join code that fleet owns. So each generic pickup can only
 * ever close it as gated-to-another-fleet after a live-status check it can't cheaply make —
 * burning a wake every time (WI-2633 observed this repeatedly). Compounding it, recovery
 * auto-resolve (resolveReplicationStallEi, EI-7110) is edge-triggered on OBSERVING the same
 * (harness,log,kind) recover, so an EI whose harness/log never re-boots sits open indefinitely
 * and keeps re-surfacing to self-selectors.
 *
 * Keys on the `_ei` envelope work_items mirrors from engineer_issues — `_ei.created_by` is the
 * detector's stable filer identity ('system:replication-liveness', == RECOVERY_OWNER) — so it
 * covers every already-open detector EI with NO backfill/migration/filer change. Mirrors
 * {@link needsHumanExclusionSql}'s shape/placement exactly (same NULL-safe COALESCE, same
 * POOL+READY+claim call sites) so an all-federation-EI backlog also reads `drained:true`
 * instead of idling a generic drainer on unpickable rows. UNCONDITIONAL (no caller bypass):
 * no GENERIC self-select caller legitimately wants one — still directly claimable BY ID, so the
 * p2p fleet (or an operator) can act on it via its own topic:'federation' triage.
 */
export function federationDetectorExclusionSql(sql: OrgSql) {
  // COALESCE + nested #>> so a NULL-payload / no-_ei row reads NULL, and
  // `NULL IS DISTINCT FROM 'system:replication-liveness'` = TRUE ⇒ the row is INCLUDED.
  return sql`COALESCE(wi.payload, '{}'::jsonb) #>> '{_ei,created_by}' IS DISTINCT FROM 'system:replication-liveness'`;
}

/**
 * The LOOP-ITERATION-NOISE self-select EXCLUSION floor for issue-family claims (EI-8802). An
 * AUTO-loop iteration's own progress-tracking marker — titled "Loop wake #N: continue backlog
 * drain..." or "AUTO loop iteration: claim and process next backlog item (su-XXXXX, <date>)" —
 * is the agent's PRIVATE carry-note misfiled via `work_items:create` instead of
 * `loop:checkpoint` (which is private and never enters the shared queue). Self-selecting one
 * wastes a full claim cycle for zero real work: WI-3077 (filed 2026-07-05, su-a5da9b5a) and
 * WI-3078 (filed 2026-07-05, su-40106c58) both sat open 4 days, each independently claimed and
 * resolved as noise, before this floor existed.
 *
 * Title-pattern ILIKE rather than a payload tag (unlike observation-lane/needsHuman/federation-
 * detector, above): these rows predate any tagging convention and a new agent can still
 * accidentally recreate the pattern even after `improvements:capture`/`loop:checkpoint` guidance
 * — a durable floor stops the CLASS from recurring regardless of whether every agent's loop
 * discipline is fixed. UNCONDITIONAL (no caller bypass): no generic self-select caller
 * legitimately wants one — still directly claimable BY ID (the same named-claim bypass every
 * issue floor allows), so an operator can still inspect/close a stray marker that slips through.
 *
 * Mirrors {@link observationLaneExclusionSql}'s shape/placement exactly (same POOL+READY+claim
 * call sites) so an all-loop-noise backlog also reads `drained:true` instead of idling a
 * generic drainer on unpickable rows, and is likewise ONE source of truth shared by
 * {@link claimNextIssueWorkItem} (the claim) and {@link diagnoseClaimNextMiss} (both counts).
 */
export function loopIterationNoiseExclusionSql(sql: OrgSql) {
  // COALESCE so a NULL title can't NULL-out the whole AND chain (defensive — title is normally
  // required, but this floor must never silently exclude a legitimate untitled row).
  return sql`(
    COALESCE(wi.title, '') NOT ILIKE 'Loop wake #%'
    AND COALESCE(wi.title, '') NOT ILIKE 'AUTO loop iteration:%'
  )`;
}

/**
 * The ALREADY-TERMINALLY-COMPLETED self-select EXCLUSION floor for issue-family claims
 * (EI-8972). `work_items:complete` records a structured completion (terminal_owner +
 * terminal_completion_ref) but a caller can omit the top-level `state` — the tool warns
 * about it (`stateWarning`) but does not reject it, so the row's `status` can be left
 * sitting in a non-terminal value (e.g. 'open') even though it has genuinely been
 * completed/diagnosed. Without this floor that row stays in the claimable pool and a
 * DIFFERENT agent (possibly a different fleet) self-selects it fresh, re-discovering work
 * a peer already finished — observed live: WI-3646, completed+terminal-owned by one agent
 * as a duplicate, re-claimed whole by another via claim_next minutes later because `state`
 * was never flipped off 'open'. A non-null terminal_owner + terminal_completion_ref is
 * itself a strong "already settled, don't re-place" signal independent of `status` — pool-
 * exclude it (like observation/needsHuman/federation-detector/loop-noise above) so an
 * all-already-completed backlog also reads `drained:true` instead of idling a drainer on
 * unpickable rows. Still directly claimable BY ID (e.g. to formally flip its `state`).
 */
export function alreadyTerminallyCompletedExclusionSql(sql: OrgSql) {
  return sql`(
    (wi.terminal_owner IS NULL OR wi.terminal_owner = '')
    OR (wi.terminal_completion_ref IS NULL OR wi.terminal_completion_ref = '')
  )`;
}

/**
 * Set (or clear) a work-item's self-select claim hold (WI-2797; extended to BOTH families by
 * fleet-deltas-leader-primitives P-006). A held item is excluded from
 * `claim_next`/`scheduler:get_next` self-selection (issue family: {@link claimHoldExclusionSql};
 * feature family: the `_claimHold` floor in {@link claimFloorsWhereSql}) but stays otherwise
 * normal — visible, commentable, and claimable directly BY ID. With `opts.by`, the hold is a
 * named HOLD-OPEN: `held_open_by`/`held_open_reason` are stamped so `setWorkItemState`'s
 * held-open guard can refuse a terminal transition by anyone else (EI-8993).
 */
export async function setWorkItemClaimHold(
  id: string,
  hold: boolean,
  opts: {
    harness?: string;
    /** P-006 (fleet-deltas-leader-primitives, EI-8993): stamp WHO holds the item
     *  open (`held_open_by`) + why (`held_open_reason`) alongside `_claimHold`,
     *  so a terminal transition by a NON-holder can refuse (setWorkItemState's
     *  held-open guard) and peers can see whose gate it is. Omitted ⇒ the legacy
     *  anonymous hold (tag only). */
    by?: string;
    reason?: string;
  } = {},
): Promise<{ id: string; harness: string | null; hold: boolean; applicable: boolean } | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  const { sql } = getOrgPg();
  const issueWs = issuesScopeWorkspace();
  // P-006: BOTH families now — the feature claim floor honors _claimHold too
  // (claimFloorsWhereSql), so the hold is meaningful on features (the WI-3548
  // leader-held incident class). Both families are rows of the ONE work_items
  // base table; features may live under the active workspace rather than the
  // issue scope, so match either.
  const ws = activeWorkspaceId();
  const holdPatch = JSON.stringify({
    _claimHold: true,
    ...(opts.by ? { held_open_by: opts.by, held_open_at: new Date().toISOString() } : {}),
    ...(opts.reason ? { held_open_reason: opts.reason } : {}),
  });
  const rows = await sql<{ payload: Record<string, unknown> | null }[]>`
    UPDATE harness_shared.work_items
       SET payload = CASE
             WHEN ${hold} THEN COALESCE(payload, '{}'::jsonb) || ${holdPatch}::text::jsonb
             ELSE COALESCE(payload, '{}'::jsonb) - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
           END,
           updated_ts = ${Date.now()}
     WHERE workspace_id IN (${issueWs}, ${ws}) AND feature_id = ${id}
     RETURNING payload`;
  if (!rows[0]) return null;
  return { id, harness: wi.harness, hold, applicable: true };
}

/** P-006: who holds a work-item OPEN (payload.held_open_by), or null. */
export function readWorkItemHeldOpenBy(payload: unknown): { by: string; reason: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.held_open_by !== 'string' || !p.held_open_by) return null;
  return { by: p.held_open_by, reason: typeof p.held_open_reason === 'string' ? p.held_open_reason : null };
}

/**
 * The issue family's CLAIMABLE statuses — the not-yet-settled `open` state (the issue
 * dialect's single in-flight state; the engineer_issues CHECK has only open|resolved|closed).
 * The scheduler issue-claim branch self-picks an `open`, unblocked issue; terminal
 * (resolved|closed) issues are excluded by status, blocked ones by the readiness predicate.
 */
export const ISSUE_FAMILY_CLAIMABLE_STATES: readonly string[] = ['open'];

/**
 * The FULL set of statuses a pull-tool caller may request via its `states` arg
 * (scheduler:get_next / work_items:claim_next). Feature family: `todo` (fresh) +
 * `failing` (re-drive); issue family: `open`. Everything else is either a resolver
 * FLOOR (`blocked` — leader-triage-only; `cursed`) or terminal — and a caller-supplied
 * `states` must NOT be able to widen past a floor. The claim-spec validator already
 * rejects a `blocked` filter TERM for exactly this reason (D-002); this allowlist
 * closes the identical hole on the sibling `states` arg (WI-1912: a fleet member
 * passed states:['todo','open','blocked'] and pulled a leader-triage-only item).
 */
export const CLAIM_STATES_ALLOWLIST = ['todo', 'open', 'failing'] as const;

/**
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): the claim-next FALLBACK LADDER. A
 * member's claim loop used to EXIT the moment its first tier read empty — most visibly
 * when a caller NARROWED to one feature-family `kind` (e.g. `kind:'feature'`): the
 * `!filter.kind` gate below used to skip the issue-family fallback ENTIRELY for that
 * caller, even when the flag was on and an issue sat there claimable. That killed members
 * while lower-tier work remained. The ladder now widens through THREE tiers, in order,
 * and only reports a genuine miss once ALL of them are dry:
 *
 *   1. the caller's exact request — `filter.kind` if narrowed, else the whole feature family.
 *   2. (only when tier 1 narrowed by kind) the REST of the feature family — the other
 *      placeable kinds `claimFloorsWhereSql` already admits (feature/research-task/chunk,
 *      or an opted-in generic kind). A `kind` is a caller NARROWING, never a floor, so
 *      draining it must widen back out before giving up.
 *   3. the ISSUE family (bug/change/task) — unconditional on `filter.kind` now (it never
 *      applied there anyway: `claimNextIssueWorkItem` doesn't read `filter.kind`), still
 *      gated behind `SCHEDULER_ISSUES_CLAIMABLE` (owner-authority — a brand-new work
 *      SOURCE, the owner ratifies turning it on).
 *
 * Each tier only runs its query when the previous tier came up empty (SKIP LOCKED means a
 * hit ends the ladder immediately), so the OFF-path / kindless / feature-hit cases stay
 * exactly as cheap as before (one UPDATE, zero extra queries).
 */
export async function claimNextWorkItem(filter: ClaimNextFilter): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();

  // One feature-family claim attempt, optionally narrowed to `kind` — the shared shape
  // for tier 1 (as the caller asked) and tier 2 (widened, kind stripped).
  const claimFeatureRow = async (kind: FeatureFamilyKind | undefined): Promise<WorkItem | null> => {
    // Co-location affinity (P-002): only when the caller passes its Swarm id (it does so
    // only under the per-Hive claim lease, default OFF). Skip work affined to ANOTHER Swarm
    // and prefer work affined to THIS one over unaffined work. Omitted ⇒ affinity-blind,
    // byte-identical to the pre-P-002 claim.
    const rows = await sql<FeatureRowDb[]>`
      UPDATE harness_shared.harness_features_consolidated
         -- P-001: self-select only ever grabs an UNCLAIMED row (the inner WHERE pins
         -- taken_by IS NULL/''), so a fresh holder always starts with a clean progress slate.
         SET taken_by = ${filter.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
       WHERE (harness_slug, feature_id) = (
         SELECT harness_slug, feature_id
           FROM harness_shared.harness_features_consolidated
          WHERE ${claimFloorsWhereSql(sql, {
            harness: filter.harness,
            workspaceId: ws,
            states: filter.states,
            swarmId: filter.swarmId,
            excludeRedundant: filter.excludeRedundant,
            useMaintainedReady,
            cooldownAssignee: filter.assignee,
          })}
            -- caller-supplied NARROWING (not a floor): restrict to one feature-family kind.
            AND ${kind ? sql`item_kind = ${kind}` : sql`TRUE`}
          -- P-010: when activated (swarmId present ⇒ the per-Hive claim lease is on), claim_next
          -- RESPECTS the Queen's priority — affinity match first, then lower feature_order (the
          -- per-harness wave/plan order the Queen steers, D-003/D-009), then oldest-first
          -- (anti-starvation). Flag OFF ⇒ plain oldest-first, byte-identical to before.
          ORDER BY ${filter.swarmId ? sql`(swarm_affinity = ${filter.swarmId}) DESC NULLS LAST, feature_order ASC NULLS LAST,` : sql``} created_ts ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${sql.unsafe(FEATURE_COLS)}`;
    return rows[0] ? featureRowToWorkItem(rows[0]) : null;
  };

  // Tier 1: exactly what the caller asked for.
  let claimed = await claimFeatureRow(filter.kind);

  // Tier 2: the caller narrowed to one kind and it's dry — widen to the rest of the
  // feature family before giving up (a member asking only for 'feature' work must not
  // exit while a claimable research-task/chunk sits right there).
  if (!claimed && filter.kind) {
    claimed = await claimFeatureRow(undefined);
  }

  // Tier 3 — work-item-deps-and-readiness P-007 (SCHEDULER_ISSUES_CLAIMABLE): the whole
  // feature family is exhausted — ADDITIVELY fall through to the issue family too, an
  // UNBLOCKED, unclaimed, open bug/change/task. Previously gated behind `!filter.kind`,
  // which meant a kind-narrowed caller NEVER reached this tier even when otherwise
  // eligible — the same premature-exit bug as tier 2, one family further out (`filter.kind`
  // is a feature-family type and was never read by `claimNextIssueWorkItem` anyway, so
  // dropping the gate changes nothing about WHICH issues are eligible).
  if (!claimed && (await schedulerIssuesClaimableEnabled())) {
    claimed = await claimNextIssueWorkItem(filter, ws);
  }
  // plugin-system-hive-port P-004: same claimed-event as claimWorkItem.
  if (claimed) {
    void import('./work-items-events')
      .then((m) => m.emitWorkItemClaimedEvent(claimed!, filter.assignee))
      .catch(() => {});
  }
  return claimed;
}

/**
 * Why did `claimNextWorkItem` return null? (EI-5919.) A bare null CONFLATES two very
 * different states, and the claim tool historically flattened both into the single message
 * "no claimable work-item":
 *   • DRAINED — there is genuinely no unclaimed work in a claimable state (idling is correct).
 *   • PRESENT-but-UNCLAIMABLE — unclaimed items DO exist, but every one is currently gated
 *     out of self-select: BLOCKED (a non-terminal blocker), affined to another Swarm,
 *     high-stakes/redundant (fans out via claim_replica), or a race just took the last ready
 *     one. The queue is NOT drained — a bee that idles here caps fleet throughput on a full
 *     backlog (the EI-5803 "fleet saturated with work still queued" signal).
 *
 * A self-select being STRICTER than a NAMED `work_items:claim(id)` is BY DESIGN, not a
 * defect: the named claim deliberately bypasses the status / readiness / placeable-kind
 * floors (the named-assignment exception), so an item that is directly claimable by id can
 * be legitimately un-self-selectable. This read-only diagnosis — run ONLY on a claim MISS,
 * never on the hot path — names WHY the self-select missed so the caller can act instead of
 * blindly idling.
 *
 *   • pendingUnclaimed — the admissible, unclaimed, claimable-status, placeable-kind POOL
 *     for this harness/workspace, BEFORE the readiness/affinity/redundancy floors. >0 ⇒ work
 *     exists here; the miss was a gate, not an empty queue. drained === (pendingUnclaimed===0).
 *   • readyUnclaimed — of that pool, how many pass ALL the floors claim_next enforces (the
 *     SAME `claimFloorsWhereSql`, incl. readiness). >0 on a miss ⇒ a race / lost lease
 *     (transient — retry); 0 with pendingUnclaimed>0 ⇒ the rest is genuinely blocked/gated
 *     (don't idle, but don't hot-retry either).
 *
 * fleet-backlog-lessons-2026-07-01 P-005 (WI-1407): `claimNextWorkItem` no longer exits on
 * an empty kind-narrowed tier — it widens through the fallback LADDER (rest of the feature
 * family, then the issue family) before truly missing, so this diagnosis is only ever run
 * once ALL tiers are dry. It mirrors that ladder rather than narrowing by `filter.kind` (a
 * kind-narrowed pool alone would misreport `drained:true` while the wider family still had
 * work claim_next would have widened into) and folds in the issue-family pool whenever the
 * `SCHEDULER_ISSUES_CLAIMABLE` gate is on, so `drained` means "every tier claim_next would
 * try is empty", never just the caller's first, narrowest ask.
 */
export interface ClaimMissDiagnosis {
  drained: boolean;
  pendingUnclaimed: number;
  readyUnclaimed: number;
}

export async function diagnoseClaimNextMiss(filter: ClaimNextFilter): Promise<ClaimMissDiagnosis> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const states = filter.states ?? ['todo'];
  const useMaintainedReady = await schedulerMaintainedReadyEnabled();
  // POOL: admissible + unclaimed + claimable-status + placeable-kind, WITHOUT the
  // readiness / affinity / redundancy floors — "is there work here a bee shouldn't idle on".
  // NOT narrowed by `filter.kind`: a kind is claim_next's tier-1 NARROWING, and the ladder
  // above widens past it before actually missing, so the diagnosis must look at the same
  // full family a genuine miss already exhausted.
  const poolRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${filter.harness}
       AND workspace_id = ${ws}
       AND ${frontierPlacementKindClause(sql, ws)}
       AND ${autoPickableWhereSql(sql, ws)}
       AND (taken_by IS NULL OR taken_by = '')
       AND status = ANY(${states}::text[])`;
  // READY: passes ALL the floors claim_next enforces (the SAME source of truth — no drift).
  const readyRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated
     WHERE ${claimFloorsWhereSql(sql, {
       harness: filter.harness,
       workspaceId: ws,
       states: filter.states,
       swarmId: filter.swarmId,
       excludeRedundant: filter.excludeRedundant,
       useMaintainedReady,
     })}`;
  let pendingUnclaimed = poolRows[0]?.n ?? 0;
  let readyUnclaimed = readyRows[0]?.n ?? 0;

  // Tier 3 of the same ladder: fold in the issue-family counts when the gate is on, so an
  // issue-only backlog is never reported as a drained queue (claim_next would have widened
  // into it too before missing). BOTH halves must count issues, not just the POOL: the
  // feature `readyRows` above reads only harness_features_consolidated, so an issue-only
  // backlog that is READY (unblocked) would leave readyUnclaimed=0 while pendingUnclaimed>0
  // — the "genuinely blocked/gated, don't hot-retry" verdict — even though claim_next's
  // issue tier would have served it (a lost-lease/race that SHOULD retry). Count the ready
  // issue pool with the SAME floors claimNextIssueWorkItem enforces (affinity + redundancy +
  // the inline blocker-terminality readiness) so readyUnclaimed reflects the whole ladder.
  if (await schedulerIssuesClaimableEnabled()) {
    const issueWs = issuesScopeWorkspace();
    const operatorScopeSlug = `operator:${issueWs}`;
    const issueCooldown = releaseCooldownSec();
    const issuePoolRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.work_items wi
       WHERE wi.item_kind IN ('bug', 'change', 'task')
         AND wi.workspace_id = ${issueWs}
         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
         AND (wi.taken_by IS NULL OR wi.taken_by = '')
         AND wi.status = ANY(${[...ISSUE_FAMILY_CLAIMABLE_STATES]}::text[])
         -- D-005: observation-lane rows never enter the work queue, so they are NOT part of the
         -- "work here a bee shouldn't idle on" POOL — excluding them here (not just from READY,
         -- as the rig/claimHold floors are) lets a scorecard-only backlog read drained:true.
         AND ${observationLaneExclusionSql(sql)}
         -- EI-7776: a needsHuman-routed row is likewise not work-queue material AT ALL — same
         -- pool-level exclusion as observation-lane, so an all-needs-human backlog also reads
         -- drained:true rather than idling a drainer on unpickable rows.
         AND ${needsHumanExclusionSql(sql)}
         -- WI-2633: an auto-filed replication-liveness detector EI is gated to the p2p fleet and
         -- unactionable by a generic self-selector — pool-exclude it too (like observation/
         -- needsHuman) so an all-federation-EI backlog reads drained:true instead of idling a
         -- drainer on unpickable rows.
         AND ${federationDetectorExclusionSql(sql)}
         -- EI-8802: a stray AUTO-loop-iteration bookkeeping marker is likewise not work-queue
         -- material AT ALL — pool-exclude it too, same rationale as observation/needsHuman.
         AND ${loopIterationNoiseExclusionSql(sql)}
         -- EI-8972: a row already carrying a genuine terminal completion (terminal_owner +
         -- terminal_completion_ref both set) is likewise not work-queue material AT ALL, even
         -- if its status was never flipped terminal — pool-exclude it too.
         AND ${alreadyTerminallyCompletedExclusionSql(sql)}`;
    pendingUnclaimed += issuePoolRows[0]?.n ?? 0;

    // READY issue count — mirrors claimNextIssueWorkItem's WHERE exactly: the pool floors
    // above PLUS swarm affinity, the excludeRedundant floor, and the inline readiness
    // predicate (no PRESENT non-terminal blocker across BOTH families). One readiness source
    // of truth with the issue-claim path, so this never drifts from what claim_next serves.
    const issueReadyRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.work_items wi
       WHERE wi.item_kind IN ('bug', 'change', 'task')
         AND wi.workspace_id = ${issueWs}
         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
         AND (wi.taken_by IS NULL OR wi.taken_by = '')
         AND wi.status = ANY(${[...ISSUE_FAMILY_CLAIMABLE_STATES]}::text[])
         AND ${filter.swarmId ? sql`(wi.swarm_affinity IS NULL OR wi.swarm_affinity = ${filter.swarmId})` : sql`TRUE`}
         AND ${filter.excludeRedundant ? sql`(wi.redundancy IS NULL OR wi.redundancy <= 1)` : sql`TRUE`}
         AND NOT EXISTS (
             SELECT 1 FROM harness_shared.work_item_deps d
              WHERE d.workspace_id = 'default'
                AND d.dep_type = 'blocks'
                AND d.blocked_ref = wi.feature_id
                AND (
                  EXISTS (
                    SELECT 1 FROM harness_shared.harness_features_consolidated bf
                     WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                       AND bf.status NOT IN ('passed', 'deprecated')
                  )
                  OR EXISTS (
                    SELECT 1 FROM harness_shared.engineer_issues bi
                     WHERE bi.workspace_id = 'default'
                       AND bi.issue_id = d.blocker_ref
                       AND bi.state NOT IN ('resolved', 'closed')
                  )
                )
         )
         -- WI-2118 (P-009 leak): a reserved-plan-lane item is NOT ready to self-select — count it
         -- as pending-but-gated (present in the POOL above, excluded here), the SAME floor the claim
         -- applies, so the miss diagnosis never disagrees with what claim_next actually serves.
         AND ${reservedPlanLaneExclusionSql(sql, filter.assignee)}
         -- WI-2796: a cross-machine-rig-gated item is likewise pending-but-gated for a
         -- single-box caller — same floor the claim applies.
         AND ${crossMachineRigExclusionSql(sql, filter.rigAvailable)}
         -- WI-2797: a claim-held item is likewise pending-but-gated — same floor the claim applies.
         AND ${claimHoldExclusionSql(sql)}
         -- D-005: an observation-lane row is not work-queue material — same floor the claim applies.
         AND ${observationLaneExclusionSql(sql)}
         -- EI-7776: a needsHuman-routed row is not work-queue material either — same floor the
         -- claim applies (below), so the miss diagnosis never disagrees with what it serves.
         AND ${needsHumanExclusionSql(sql)}
         -- WI-2633: a replication-liveness detector EI is gated to the p2p fleet — same floor the
         -- claim applies (below), so the miss diagnosis never disagrees with what it serves.
         AND ${federationDetectorExclusionSql(sql)}
         -- EI-8802: a stray AUTO-loop-iteration bookkeeping marker is not work-queue material
         -- either — same floor the claim applies (below), so the miss diagnosis never disagrees.
         AND ${loopIterationNoiseExclusionSql(sql)}
         -- EI-8972: an already-genuinely-terminally-completed row is not work-queue material
         -- either — same floor the claim applies (below), so the miss diagnosis never disagrees.
         AND ${alreadyTerminallyCompletedExclusionSql(sql)}
         -- Mig 499: a row still in ITS OWN release-cooldown (this caller released it recently)
         -- is likewise pending-but-gated for THIS caller — same floor claimNextIssueWorkItem applies.
         AND ${
           issueCooldown > 0
             ? sql`(wi.last_released_by IS NULL
               OR wi.last_released_by <> ${filter.assignee}
               OR wi.last_released_at IS NULL
               OR wi.last_released_at < now() - make_interval(secs => ${issueCooldown}))`
             : sql`TRUE`
         }`;
    readyUnclaimed += issueReadyRows[0]?.n ?? 0;
  }

  return { drained: pendingUnclaimed === 0, pendingUnclaimed, readyUnclaimed };
}

/**
 * The ISSUE-family half of self-selection (SCHEDULER_ISSUES_CLAIMABLE, P-007) — atomically
 * claim the oldest UNBLOCKED, unclaimed `open` bug/change/task, mirroring the feature claim's
 * `UPDATE … WHERE pk = (SELECT … FOR UPDATE SKIP LOCKED)` shape but over the `work_items`
 * BASE for issue-family kinds (the engineer_issues VIEW doesn't expose feature_order, and the
 * feature view excludes these rows). KEPT SEPARATE from the feature claim so that path is never
 * rewritten — this runs ONLY when the flag is on AND no feature was claimable (callers guard).
 * EXPORTED (fleet-backlog-lessons-2026-07-01 P-005) so the spec-driven `scheduler/get-next.ts`
 * resolver can reuse it as ITS ladder's tier 3 too — one issue-claim implementation, never two.
 *
 * Readiness uses the SAME work_item_deps predicate as the feature floor, with the issue's
 * blocked_ref being its BARE id (issues:link), and a blocker SATISFIED iff TERMINAL/ABSENT
 * (feature terminal = passed|deprecated; issue terminal = resolved|closed). Priority honors
 * feature_order (the Queen can now steer issues too, P-007), then oldest-first.
 *
 * `opts.ids` (WI-4309): when the caller extracted a closed-world `id in [...]` set from the
 * spec, narrows the claim to exactly those ids — see the inline comment at its use site.
 */
export async function claimNextIssueWorkItem(
  filter: ClaimNextFilter,
  _ws: string,
  opts: { issueKinds?: readonly IssueStoreKind[]; ids?: readonly string[] } = {},
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  // Scope the issue-claim to the canonical ISSUE workspace (issuesScopeWorkspace — honors the
  // ISSUES_PER_WORKSPACE flag), NOT the feature activeWorkspaceId(), so the UPDATE and the
  // getIssue() re-read below agree on the same partition (they'd diverge when ISSUES_PER_WORKSPACE
  // is OFF: issues live in 'default' while the feature scope is the active workspace).
  const issueWs = issuesScopeWorkspace();
  // Issue-family rows carry harness_slug = 'harness:<slug>' → <slug> (harness-scoped) or
  // 'operator:<workspace_id>' (operator scope, migration 382 — the harness_slug='' sentinel
  // it replaced is gone in current data). EI-5919 / WI-1406: this query used to match ONLY
  // `wi.harness_slug = filter.harness`, so it could see harness-scoped issues but NOT
  // operator-scope ones — which is ~90% of the open bug/change/task backlog (2326/2596 rows
  // for papercusp-workspace, verified 2026-07-01). Every harness-scoped claim_next call was
  // structurally blind to that backlog: "40+ ready unclaimed todos exist" yet claim_next
  // reported no claimable work-item. Also accept the operator-scope encoding for the SAME
  // resolved issue workspace, so operator-wide issues become self-pickable by any harness.
  const operatorScopeSlug = `operator:${issueWs}`;
  // Claimable issue status = 'open'; terminal (resolved|closed) excluded by status, blocked
  // ones by readiness (below).
  const states = ISSUE_FAMILY_CLAIMABLE_STATES;
  const issueKinds = opts.issueKinds?.length ? [...opts.issueKinds] : [...ISSUE_FAMILY_KINDS];
  // WI-4309: when the caller (get-next.ts tier 3) extracted a closed-world `id in [...]`
  // set from the spec, narrow the claim to EXACTLY those ids instead of either ignoring
  // the constraint (the original EI-10062 leak — served ANY open issue once the named ids
  // were exhausted) or refusing to run at all (an earlier fix that made tier 3 skip
  // entirely whenever an id constraint was present — which meant an issue-only id-allowlist
  // spec, e.g. a leader's hand-curated bug-drain wave of EI-/WI- ids, could NEVER be served
  // by get_next even while its named items sat open+unclaimed, since tier 1 only queries the
  // feature-family table and can't match an issue-family id). Undefined ⇒ no id constraint
  // (or one the caller couldn't safely extract) ⇒ unrestricted, as before.
  const idFilter = opts.ids?.length ? [...opts.ids] : undefined;
  // Mig 499: the SAME release-cooldown floor claimFloorsWhereSql applies for the
  // feature family (mig 485/EI-6956) — without it, an agent that releases an
  // issue-family item immediately re-claims that EXACT row on its very next
  // scheduler:get_next/claim_next call whenever it's still the oldest/highest-
  // ranked eligible row (the confirmed-live WI-652/WI-2381-class ping-pong).
  const cooldown = releaseCooldownSec();
  const rows = await sql<FeatureRowDb[]>`
    UPDATE harness_shared.work_items
       SET taken_by = ${filter.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
     WHERE (workspace_id, harness_slug, feature_id) = (
       SELECT workspace_id, harness_slug, feature_id
         FROM harness_shared.work_items wi
        WHERE wi.item_kind = ANY(${issueKinds}::text[])
          AND wi.workspace_id = ${issueWs}
          -- WI-4309: narrow to the spec's closed-world id set, when one was extracted.
          AND ${idFilter ? sql`wi.feature_id = ANY(${idFilter}::text[])` : sql`TRUE`}
          AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
          AND (wi.taken_by IS NULL OR wi.taken_by = '')
          AND wi.status = ANY(${[...states]}::text[])
          -- WI-3649 (EI-7841's issue-family half): this base-table UPDATE bypasses the
          -- engineer_issues VIEW/trigger entirely, so unlike the single-id work_items:claim
          -- path (gated by engineer_issues_view_dml's EI-7833 remote-skip) it had NO origin
          -- guard at all — a self-select could actually SUCCEED in locally mutating taken_by
          -- on a federated row, violating the "authoring peer owns it" LWW invariant. Mirrors
          -- isIssueLocallyClaimable (work-items-admission.ts): only origin NULL/'local' self-selectable.
          AND (wi.origin IS NULL OR wi.origin = 'local')
          -- swarm affinity (P-002): under the per-Hive lease, honor the issue's affinity too.
          AND ${filter.swarmId ? sql`(wi.swarm_affinity IS NULL OR wi.swarm_affinity = ${filter.swarmId})` : sql`TRUE`}
          -- P-014: skip high-stakes (redundancy>1) items under the redundancy flag.
          AND ${filter.excludeRedundant ? sql`(wi.redundancy IS NULL OR wi.redundancy <= 1)` : sql`TRUE`}
          -- Readiness (P-005/P-007): never self-select a row with a PRESENT, NON-TERMINAL blocker.
          -- The issue's blocked_ref is its BARE feature_id (issues:link). The issue-claim path ALWAYS
          -- uses the INLINE predicate over work_item_deps + cross-family blocker statuses — NOT the
          -- maintained work_item_blocked sidecar, which is FEATURE-FAMILY ONLY (the wir_* triggers
          -- don't track issues, so the sidecar would report a blocked issue as ready). The issue-claim
          -- is the secondary feature-miss path, so the inline read (not the indexed sidecar) is fine.
          AND NOT EXISTS (
              SELECT 1 FROM harness_shared.work_item_deps d
               WHERE d.workspace_id = 'default'
                 AND d.dep_type = 'blocks'
                 AND d.blocked_ref = wi.feature_id
                 AND (
                   EXISTS (
                     SELECT 1 FROM harness_shared.harness_features_consolidated bf
                      WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                        AND bf.status NOT IN ('passed', 'deprecated')
                   )
                   OR EXISTS (
                     SELECT 1 FROM harness_shared.engineer_issues bi
                      WHERE bi.workspace_id = 'default'
                        AND bi.issue_id = d.blocker_ref
                        AND bi.state NOT IN ('resolved', 'closed')
                   )
                 )
          )
          -- WI-2118 (P-009 leak): never self-select an item reserved by another active plan lane.
          AND ${reservedPlanLaneExclusionSql(sql, filter.assignee)}
          -- WI-2796: never self-select a cross-machine-rig-gated item unless the caller
          -- declared it has rig access.
          AND ${crossMachineRigExclusionSql(sql, filter.rigAvailable)}
          -- WI-2797: never self-select an item a peer has explicitly claim-held (do-not-
          -- opportunistically-claim) — still directly claimable by id.
          AND ${claimHoldExclusionSql(sql)}
          -- D-005: never self-select a lane:'observation' scorecard/reflection — by design it
          -- "never enters the work queue" (only the Observations pane + Scout digest read it).
          AND ${observationLaneExclusionSql(sql)}
          -- EI-7776: never self-select an item improvements:resolve already routed to a human
          -- (payload.needsHuman) — the issue-family status dialect has no real terminal
          -- "needs-human" state (it collapses to 'open'), so without this floor a drain-loop
          -- bee re-claims the SAME already-diagnosed item and re-posts the identical
          -- "routed to a human" comment forever (confirmed live: EI-7592 "resolved" 3x in one
          -- afternoon). Still directly claimable BY ID.
          AND ${needsHumanExclusionSql(sql)}
          -- WI-2633: never self-select an auto-filed replication-liveness detector EI
          -- (payload._ei.created_by='system:replication-liveness'). A generic backlog-drain
          -- worker structurally cannot action it — verifying the current verdict needs the
          -- p2p-release-readiness fleet's live in-process getReplicationLiveness()/dogfood-
          -- substrate diagnostics — so it would only ever close it as gated-to-another-fleet,
          -- burning a wake each time. Still directly claimable BY ID (the p2p fleet's triage).
          AND ${federationDetectorExclusionSql(sql)}
          -- EI-8802: never self-select a stray AUTO-loop-iteration bookkeeping marker (a
          -- misfiled loop:checkpoint substitute) — pure recycle churn for zero real work.
          -- Still directly claimable BY ID.
          AND ${loopIterationNoiseExclusionSql(sql)}
          -- EI-8972: never self-select a row that already carries a genuine terminal
          -- completion (terminal_owner + terminal_completion_ref both set) even if its
          -- status was never flipped terminal — a peer already finished/diagnosed it
          -- (work_items:complete's own stateWarning documents this exact gap: a caller can
          -- omit state and leave the row claimable). Still directly claimable BY ID.
          AND ${alreadyTerminallyCompletedExclusionSql(sql)}
          -- Mig 499: release-cooldown floor (mirrors claimFloorsWhereSql's feature-family
          -- clause) — NULL-safe: never released, released by someone else, or released
          -- long enough ago, all pass; only "released by ME within the cooldown window"
          -- excludes the row from MY OWN next self-select.
          AND ${
            cooldown > 0
              ? sql`(wi.last_released_by IS NULL
                OR wi.last_released_by <> ${filter.assignee}
                OR wi.last_released_at IS NULL
                OR wi.last_released_at < now() - make_interval(secs => ${cooldown}))`
              : sql`TRUE`
          }
        -- EI-7407: feature_order steering must be UNCONDITIONAL for issue-family claims (per
        -- this function's own doc above — "the Queen can now steer issues too, P-007" — with
        -- no swarmId/Multi-Swarm-lease caveat, unlike the feature-family path's P-010-gated
        -- behavior). The swarm-affinity tie-break stays swarmId-gated (meaningless without
        -- it); the fix moves feature_order OUT of that ternary so a plain, lease-less
        -- work_items:set_priority actually changes this query's pull order instead of
        -- silently no-op'ing on ordering while still reporting written:true.
        ORDER BY ${filter.swarmId ? sql`(wi.swarm_affinity = ${filter.swarmId}) DESC NULLS LAST,` : sql``} wi.feature_order ASC NULLS LAST, wi.created_ts ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  // RETURNING the base row uses the feature column shape; the row IS an issue-family row, so
  // map it through the issue facade (state dialect, no claim-time columns) for a consistent
  // WorkItem. featureRowToWorkItem would mislabel family/state, so re-read via the issue path.
  if (!rows[0]) return null;
  // EI-6480: the UPDATE above has ALREADY committed the claim (taken_by is set) on a row in
  // `issueWs`. Re-read in that SAME captured workspace — NOT via bare getIssue(), which
  // re-derives issuesScopeWorkspace() and can drift (its flag cache self-heals on a TTL), so a
  // mid-call flip would make the re-read miss the just-claimed row. A null there historically
  // returned null: the claim LEAKED (row stayed taken_by-set, out of the pool) and the caller
  // saw a spurious "ready but a peer raced you (retry)" miss even though the claim succeeded —
  // the reported EI-6480 symptom (a self-consistent miss with readyUnclaimed>0). Reading in the
  // exact claimed workspace makes that null impossible for a live claim.
  const issue = await getIssueInWorkspace(issueWs, rows[0].feature_id, { baseHarnessSlug: rows[0].harness_slug });
  if (issue) return issueToWorkItem(issue);
  // Defense in depth: the row we just claimed is, by construction, present in `issueWs` (the
  // UPDATE filtered on it and committed the mutation), so a null here is a genuine anomaly, NOT
  // a race. Do not leak the claim or misreport it as a retryable miss: RELEASE it (return the
  // row to the pool) and surface an honest error so the fault is visible, not disguised. Clear
  // the claim with a workspace-EXACT UPDATE (not releaseWorkItem, which re-derives the scope via
  // getIssue and would hit the same drift) so the undo can't itself leak.
  await sql`
    UPDATE harness_shared.work_items
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL, updated_ts = ${Date.now()}
     WHERE workspace_id = ${issueWs} AND harness_slug = ${rows[0].harness_slug} AND feature_id = ${rows[0].feature_id}`;
  throw new Error(
    `claimNextIssueWorkItem: claimed issue ${rows[0].feature_id} in workspace '${issueWs}' but could ` +
      `not re-read it (getIssueInWorkspace returned null); released the claim. This is an anomaly, ` +
      `not a peer race.`,
  );
}

export interface WorkItemObservation {
  item: WorkItem;
  /** Unclaimed AND not refused by the G2 admission/trust gate — i.e. a claim would
   *  actually succeed. False for both "someone holds it" and "unclaimed but gated". */
  available: boolean;
  claimedBy: string | null;
  /**
   * EI-7841: true only when the item is UNCLAIMED yet still not-`available` because
   * the feature-family G2 admission/trust gate (autoPickableWhereSql /
   * isAutoPickable — the same gate `work_items:claim` and `claim_next` enforce)
   * would refuse it: a remote, un-admitted, untrusted-author item. Omitted (not just
   * false) when the gate doesn't apply, so existing `available`-only callers are
   * unaffected. Lets a self-selecting agent see WHY an apparently-free item can't be
   * claimed instead of discovering it only via a `not_claimable` claim failure.
   */
  gated?: boolean;
  /**
   * WI-3667/P-003: set when the item is UNCLAIMED yet carries a plan-item back-pointer
   * (payload.plan_item) whose linked plan lane is effectively `blocked` or needs a human
   * decision (see scheduler/plan-item-lane-guard.ts) — the same check
   * work_items:claim_next / scheduler:get_next already enforce at claim time (they
   * silently claim-then-release and retry the next row). Surfacing the reason here lets a
   * self-selecting agent — or anything reading `work_items:observe` before deciding to
   * claim — see WHY an apparently-free item isn't really claimable, instead of only
   * discovering it via a claim that bounces back to the pool.
   */
  planItemBlocked?: { reason: string; planSlug: string; itemId: string; effectiveStatus: string };
}

/**
 * The tuple-space `rd` (D-004): OBSERVE a work-item without claiming it — the read
 * primitive, kept DISTINCT from the `in` of claim. Reports claimability so a self-
 * selecting agent can decide before taking. (list/get are the bulk rd surface; this is
 * the explicit single-item observe-with-claimability.)
 *
 * EI-7841: `work_items:list` (→ coord:orient's claimable backlog) and this observe
 * read historically reported `available: true` for ANY unclaimed row, while the two
 * claim paths (`claimWorkItem` / `claimFloorsWhereSql`) additionally enforce the G2
 * admission/trust gate (autoPickableWhereSql) for feature-family items — so a
 * remote, un-admitted item looked claimable here and then bounced with
 * `not_claimable` on the actual claim, burning a wake cycle. This applies the SAME
 * gate (via the pure-JS `isAutoPickable`, mirroring placement-gather's usage — no
 * extra per-row query beyond the one-off trust-list load) so `available` here
 * matches what `work_items:claim` will actually do.
 */
export async function observeWorkItem(
  id: string,
  opts: { harness?: string } = {},
): Promise<WorkItemObservation | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  const unclaimed = !wi.assignee;
  if (unclaimed && wi.family === 'feature') {
    // Cheap path first — local/admitted items (the vast majority) resolve without
    // touching the DB at all; only a remote+un-admitted item needs the trust-list
    // read to check the Phase-3 fast-path before concluding it's truly gated.
    let pickable = isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, undefined);
    if (!pickable) {
      const trusted = await loadTrustedGithubUserIds(activeWorkspaceId()).catch(() => new Set<number>());
      pickable = isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, trusted);
    }
    if (!pickable) return { item: wi, available: false, claimedBy: wi.assignee, gated: true };
  }
  // WI-3649: the issue-family (bug/change/task) half of the same EI-7841 class — a
  // federated (origin='remote') issue-family row is never locally claimable (its
  // authoring peer's core owns it, EI-7833/mig-521), so `available` must say so here
  // too, not just report unclaimed and let the real claim bounce with not_claimable.
  if (unclaimed && wi.family === 'issue' && !isIssueLocallyClaimable(wi.origin)) {
    return { item: wi, available: false, claimedBy: wi.assignee, gated: true };
  }
  // WI-3667/P-003: an unclaimed row can still carry a plan-item back-pointer whose
  // linked lane is effectively `blocked`/needs-human even though it cleared every SQL
  // floor above — the same case work_items:claim_next / scheduler:get_next already
  // catch at claim time via a silent claim-then-release retry (see
  // scheduler/plan-item-lane-guard.ts). Surface it here too, so a caller deciding
  // whether to claim (or auditing "why is this item not really claimable") sees the
  // SAME reason instead of only discovering it via a bounced claim. Lazy import to
  // avoid a module-cycle with the scheduler layer (which imports work-items types).
  if (unclaimed) {
    const { planItemLaneBlockReason } = await import('./scheduler/plan-item-lane-guard');
    const blocked = await planItemLaneBlockReason(wi);
    if (blocked) {
      return {
        item: wi,
        available: false,
        claimedBy: wi.assignee,
        gated: true,
        planItemBlocked: blocked,
      };
    }
  }
  return { item: wi, available: unclaimed, claimedBy: wi.assignee };
}

export async function releaseWorkItem(
  id: string,
  opts: { harness?: string; expectedAssignee?: string } = {},
): Promise<WorkItem | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  // Only a release of an actually-CLAIMED item is a `claim:released` transition —
  // releasing an already-free row is a no-op and must not wake pool-waiters.
  const wasClaimed = Boolean(wi.assignee);
  // EI-6832: this item is about to RETURN to the unclaimed pool — clear any lease a
  // prior claim_next left on it under the WORKITEM_CLAIM_LEASE flag, so it doesn't sit
  // visibly-unclaimed-yet-lease-poisoned for up to the lease TTL (fire-and-forget,
  // never blocks the release itself; see releaseWorkItemLease's doc comment).
  if (wi.harness) void releaseWorkItemLease({ harness: wi.harness, workItemId: id, owner: wi.assignee });
  // P-105: claim:released:<id> — wake anyone awaiting this item's claim to free, the
  // moment it returns to the pool (both the voluntary work_items:release tool AND the
  // stale-claim reaper route through here). Fire-and-forget + lazy import (work-items-
  // events imports THIS module statically — the lazy import breaks the cycle).
  const emitReleased = (released: WorkItem | null): void => {
    if (released && wasClaimed) {
      // P-007: emitClaimReleasedEvent internally co-fires `work-item:claimable`
      // for a row that returned to a claimable state — one hook here.
      void import('./work-items-events').then((m) => m.emitClaimReleasedEvent(released)).catch(() => {});
    }
  };
  if (wi.family === 'issue') {
    const updated = await releaseIssue(id, { expectedAssignee: opts.expectedAssignee });
    const released = updated ? issueToWorkItem(updated) : null;
    emitReleased(released);
    return released;
  }
  const { sql } = getOrgPg();
  // P-003 / D-002: a VOLUNTARY release mirrors the reaper — a freed mid-flight
  // (requeueable) row resets → `todo` so it returns to the claimable pool, since
  // an agent releasing in-flight work wants it picked up again, not stranded in a
  // non-dispatchable status. No requeue_count bump (voluntary release is not a
  // failure / poison-loop). Terminal (`passed`/`deprecated`), `blocked`, and
  // already-`todo` rows keep their status. Done in SQL off the live column so it
  // never depends on the JS-side state mapping.
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const rows = await sql<FeatureRowDb[]>`
    UPDATE harness_shared.harness_features_consolidated
       -- P-001: release clears the progress signal too — the next claimant starts fresh
       -- (a stale last_progress_at must not outlive the holder that earned it).
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL,
           -- Release-cooldown provenance (mig 485 / EI-6956): remember WHO freed this row
           -- so the claim floors keep the RELEASING bee off it for a short cooldown
           -- (claim/release ping-pong guard). SET's RHS reads the OLD row, so taken_by
           -- here is the releasing holder; an already-free release keeps prior provenance.
           last_released_by = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN taken_by ELSE last_released_by END,
           last_released_at = CASE WHEN taken_by IS NOT NULL AND taken_by <> '' THEN now() ELSE last_released_at END,
           status = CASE WHEN status <> ALL(${nonRequeue}::text[]) THEN 'todo' ELSE status END,
           updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
       -- EI-7588: same atomic compare-and-release guard as the issue-family path above —
       -- a row held by someone OTHER than expectedAssignee matches 0 rows (null return),
       -- not a silent steal.
       AND (${opts.expectedAssignee ?? null}::text IS NULL OR taken_by IS NULL OR taken_by = ${opts.expectedAssignee ?? null})
    RETURNING ${sql.unsafe(FEATURE_COLS)}`;
  const released = rows[0] ? featureRowToWorkItem(rows[0]) : null;
  emitReleased(released);
  return released;
}

/* ── Co-location affinity (hive-coordination-model P-002) ──────────────────────────
 * The Queen's co-location lever: stamp/read a work-item's `swarm_affinity` (the Swarm
 * device-pubkey its tightly-coupled work should run on). Feature-family only — the
 * issue-family table has no affinity (bugs/changes aren't placed by the Queen). The
 * value is honored by claimNextWorkItem only under the per-Hive claim lease (P-002).
 */
export interface SwarmAffinityResult {
  id: string;
  harness: string | null;
  /** The affinity now stored — a Swarm id, or null when cleared / no affinity. */
  swarmAffinity: string | null;
}

/** Set (or clear, with `swarm: null`) a feature-family work-item's Swarm affinity. */
export async function setWorkItemSwarmAffinity(
  id: string,
  swarm: string | null,
  opts: { harness?: string } = {},
): Promise<SwarmAffinityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007 (SCHEDULER_ISSUES_CLAIMABLE): once issues join the dispatched backlog the Queen
    // can co-locate them too — write swarm_affinity on the work_items BASE (the engineer_issues
    // view doesn't expose it), keyed by (workspace_id, feature_id) since an issue's harness_slug
    // may be ''. Flag OFF ⇒ issues aren't Queen-placed (no affinity column to set), byte-identical.
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, swarmAffinity: null };
    }
    const { sql } = getOrgPg();
    const rows = await sql<{ swarm_affinity: string | null }[]>`
      UPDATE harness_shared.work_items
         SET swarm_affinity = ${swarm}, updated_ts = ${Date.now()}
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
      RETURNING swarm_affinity`;
    if (!rows[0]) return null;
    return { id, harness: wi.harness, swarmAffinity: rows[0].swarm_affinity };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ swarm_affinity: string | null }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET swarm_affinity = ${swarm}, updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
    RETURNING swarm_affinity`;
  if (!rows[0]) return null;
  return { id, harness: wi.harness, swarmAffinity: rows[0].swarm_affinity };
}

/** Read a feature-family work-item's current Swarm affinity (null when none / issue-family). */
export async function getWorkItemSwarmAffinity(
  id: string,
  opts: { harness?: string } = {},
): Promise<SwarmAffinityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: read the issue's stored affinity off the base when issues are claimable; else null
    // (byte-identical to the feature-only behavior).
    if (!(await schedulerIssuesClaimableEnabled())) return { id, harness: wi.harness, swarmAffinity: null };
    const { sql } = getOrgPg();
    const rows = await sql<{ swarm_affinity: string | null }[]>`
      SELECT swarm_affinity FROM harness_shared.work_items
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task') LIMIT 1`;
    return { id, harness: wi.harness, swarmAffinity: rows[0]?.swarm_affinity ?? null };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ swarm_affinity: string | null }[]>`
    SELECT swarm_affinity FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
  return { id, harness: wi.harness, swarmAffinity: rows[0]?.swarm_affinity ?? null };
}

/* ── Backlog priority (the Queen's steer-don't-dispatch lever) ──────────────────────
 * The Queen STEERS the SHARED backlog by setting each feature-family item's
 * `feature_order` — the column the decentralized claim path (claimNextWorkItem) orders
 * by (ASC NULLS LAST: LOWER feature_order = claimed sooner; NULL = unprioritized, sorts
 * last). This is the "sets priorities" half of the steering loop
 * (autoloop-pot-operator-rebuild B7 / decentralized-dispatch-scaling D-003/D-004 + P-009/
 * P-010): she reads the rolled-up change feed and reorders the backlog the fleet claims
 * against, never assigning item-by-item.
 *
 * It is DISTINCT from `reorderWorkItem` (work_items:reorder), which ranks ONE bee's
 * already-CLAIMED work-list (`assignee_rank`). Priority = the GLOBAL backlog order
 * (pre-claim); rank = a per-assignee queue (post-claim). Was feature-family only when
 * this comment was first written; since SCHEDULER_ISSUES_CLAIMABLE (P-007/EI-7407)
 * joined issue-family (bug/change/task) into the SAME dispatched backlog,
 * `setWorkItemPriority`/`getWorkItemPriority` apply to them too (writing/reading
 * `feature_order` on the shared `harness_shared.work_items` base row) — `applicable:
 * false` now means only "the SCHEDULER_ISSUES_CLAIMABLE flag is off", not "issue-family
 * is categorically excluded". EI-10421: the READ side of this (issueToWorkItem /
 * `engineer_issues` view) lagged this fix until migration 588 — see its comment.
 */
export interface WorkItemPriorityResult {
  id: string;
  harness: string | null;
  /** The backlog priority (`feature_order`) now stored — LOWER = higher priority; null = unprioritized. */
  priority: number | null;
  /** Whether backlog priority APPLIES — feature-family (the dispatched backlog) = true; issue-family = false. */
  applicable: boolean;
  /**
   * P-011 steering lease (D-004): true when THIS Swarm does not hold its Hive's
   * single-steerer lease — the write was NOT committed (priority echoes the
   * stored value); a PROPOSAL was recorded (work-item comment + advisory coord
   * escalation) for the holding Queen to dispose. Local placement (assignee
   * ranks, claims) is never lease-gated.
   */
  proposed?: boolean;
  /** The lease holder's label (set with `proposed`). */
  steeringHolder?: string;
}

/** Set (or clear, with `priority: null`) a feature-family work-item's backlog priority (`feature_order`). */
export async function setWorkItemPriority(
  id: string,
  priority: number | null,
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007 (SCHEDULER_ISSUES_CLAIMABLE): issues join the dispatched backlog, so the Queen's
    // feature_order steer applies to them too — write it on the work_items BASE (the
    // engineer_issues view doesn't expose feature_order), keyed by (workspace_id, feature_id).
    // No steering-lease arbitration: an issue isn't the per-Hive harness frontier the lease
    // single-writers. Flag OFF ⇒ applicable:false (no feature_order), byte-identical.
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, priority: null, applicable: false };
    }
    const ordIssue = priority === null ? null : Math.trunc(priority);
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_order: number | null }[]>`
      UPDATE harness_shared.work_items
         SET feature_order = ${ordIssue}, updated_ts = ${Date.now()}
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
      RETURNING feature_order`;
    if (!rows[0]) return null;
    return { id, harness: wi.harness, priority: rows[0].feature_order, applicable: true };
  }
  const ord = priority === null ? null : Math.trunc(priority);
  const { sql } = getOrgPg();
  // P-011 single-steerer lease (D-004, hive-network-surface): cross-Swarm
  // priority writes are single-writer — the lease rides the per-Hive lock
  // authority. A non-holder's steer becomes a PROPOSAL (comment + advisory
  // escalation; the holding Queen disposes) and the row is NOT written.
  // checkSteeringLease never throws and FAILS OPEN (non-Hive harness, N=1,
  // partition, missing fixture tables → holder:true), so behavior is unchanged
  // everywhere except a live multi-Swarm Hive where another Swarm holds it.
  if (wi.harness) {
    const lease = await checkSteeringLease(activeWorkspaceId(), wi.harness);
    if (!lease.holder) {
      await recordSteeringProposal({
        workspaceId: activeWorkspaceId(),
        harnessSlug: wi.harness,
        featureId: id,
        requestedOrder: ord,
        potSlug: lease.potSlug ?? 'unknown',
        holderLabel: lease.holderLabel ?? 'an unidentified peer Swarm',
      }).catch(() => undefined);
      const cur = await sql<{ feature_order: number | null }[]>`
        SELECT feature_order FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
      return {
        id,
        harness: wi.harness,
        priority: cur[0]?.feature_order ?? null,
        applicable: true,
        proposed: true,
        steeringHolder: lease.holderLabel ?? 'an unidentified peer Swarm',
      };
    }
  }
  const rows = await sql<{ feature_order: number | null }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET feature_order = ${ord}, updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id}
    RETURNING feature_order`;
  if (!rows[0]) return null;
  // B-12 steering-churn tripwire (hive-network-surface-2026-06-11 P-010 / D-004):
  // the AFTER trigger (mig 232) has just recorded this steer into the ledger;
  // check whether the SAME item has been re-steered by a DIFFERENT writer (another
  // Queen) within the window and raise a debounced owner escalation above
  // threshold. Best-effort — a telemetry/escalation failure must NEVER break the
  // steer, and the ledger table is absent in isolated unit fixtures (42P01 →
  // silently skip; the periodic sweep is the catch-all when it exists).
  if (wi.harness) {
    // Swallow ALL errors silently: the steer is the contract here, telemetry is
    // not, and the periodic sweep (dbos/periodic-workflows.ts) is the backstop for
    // anything this check misses (incl. the ledger table being absent in isolated
    // unit fixtures — 42P01).
    await checkAndEscalateSteeringChurn({
      workspaceId: activeWorkspaceId(),
      harnessSlug: wi.harness,
      featureId: id,
    }).catch(() => undefined);
  }
  return { id, harness: wi.harness, priority: rows[0].feature_order, applicable: true };
}

/**
 * Bump a feature-family work-item to the HEAD or TAIL of its harness's backlog by setting
 * `feature_order` just past the current extreme (top = min−1, bottom = max+1, over the OTHER
 * feature-family items in the harness). The ergonomic steering verb — the Queen thinks "make
 * this the most urgent", not in absolute order integers. Empty/all-null backlog ⇒ 0.
 */
export async function bumpWorkItemPriority(
  id: string,
  position: 'top' | 'bottom',
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: bump an issue to the head/tail of the ISSUE backlog (the work_items base, issue
    // kinds, same workspace) when issues are claimable; else applicable:false (byte-identical).
    if (!(await schedulerIssuesClaimableEnabled())) {
      return { id, harness: wi.harness, priority: null, applicable: false };
    }
    const { sql } = getOrgPg();
    const issueWs = issuesScopeWorkspace();
    const extI = await sql<{ min_ord: number | null; max_ord: number | null }[]>`
      SELECT MIN(feature_order) AS min_ord, MAX(feature_order) AS max_ord
        FROM harness_shared.work_items
       WHERE workspace_id = ${issueWs}
         AND item_kind IN ('bug', 'change', 'task')
         AND feature_id <> ${id}`;
    const minI = extI[0]?.min_ord ?? null;
    const maxI = extI[0]?.max_ord ?? null;
    const targetI = position === 'top' ? (minI === null ? 0 : minI - 1) : maxI === null ? 0 : maxI + 1;
    return setWorkItemPriority(id, targetI, opts);
  }
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const ext = await sql<{ min_ord: number | null; max_ord: number | null }[]>`
    SELECT MIN(feature_order) AS min_ord, MAX(feature_order) AS max_ord
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness}
       AND workspace_id = ${ws}
       AND item_kind IN ('feature', 'chunk')
       AND feature_id <> ${id}`;
  const min = ext[0]?.min_ord ?? null;
  const max = ext[0]?.max_ord ?? null;
  const target = position === 'top' ? (min === null ? 0 : min - 1) : max === null ? 0 : max + 1;
  return setWorkItemPriority(id, target, opts);
}

/** Read a feature-family work-item's current backlog priority (`feature_order`; null when none / issue-family). */
export async function getWorkItemPriority(
  id: string,
  opts: { harness?: string } = {},
): Promise<WorkItemPriorityResult | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  if (wi.family !== 'feature') {
    // P-007: read the issue's feature_order off the base when issues are claimable; else
    // applicable:false (byte-identical to the feature-only behavior).
    if (!(await schedulerIssuesClaimableEnabled()))
      return { id, harness: wi.harness, priority: null, applicable: false };
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_order: number | null }[]>`
      SELECT feature_order FROM harness_shared.work_items
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task') LIMIT 1`;
    return { id, harness: wi.harness, priority: rows[0]?.feature_order ?? null, applicable: true };
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_order: number | null }[]>`
    SELECT feature_order FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness} AND feature_id = ${id} LIMIT 1`;
  return { id, harness: wi.harness, priority: rows[0]?.feature_order ?? null, applicable: true };
}

export interface ReorderWorkItemResult {
  /** The item moved. */
  id: string;
  /** Its assignee — whose ordered queue this reorder operated on. */
  assignee: string;
  /** The rank the item now holds (0-based; clamped to the queue length). */
  rank: number;
  /** The propose/dispose author stamped on the move (D-008). */
  writer: RankWriter;
  /** The assignee's full ordered queue after the move (head-of-line first). */
  queue: { id: string; rank: number; title: string }[];
}

/**
 * The per-assignee work-list REORDER (local-hive P-020 / D-004): place one work-item at
 * `target` rank within its assignee's ordered queue, shifting peers down (insert-at-rank
 * — what the Queen's "inject at a rank" and a bee's "move this up" both need). Atomic via
 * the `harness_shared.reorder_work_item` SQL fn (one transaction, renumbers densely, spans
 * both base tables). `writer` ('cup'|'mug') stamps the propose/dispose audit (D-008);
 * the Queen-vs-bee write balance is gated by the EXISTING automation tier at the tool
 * layer (P-022), not here.
 *
 * The item must already be CLAIMED (have an assignee) — rank is meaningless on an
 * unassigned item. Returns the new rank + the assignee's ordered queue, or null when the
 * item doesn't exist / isn't assigned.
 */
export async function reorderWorkItem(
  id: string,
  target: number,
  opts: { writer?: RankWriter; harness?: string } = {},
): Promise<ReorderWorkItemResult | { error: string }> {
  const writer: RankWriter = opts.writer ?? 'cup';
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (!wi.assignee) return { error: `work_item '${id}' is unassigned — claim it before ranking` };

  const { sql } = getOrgPg();
  // The work_items view carries workspace_id; resolve it for this item so the reorder is
  // scoped to the right (workspace, assignee) queue.
  const wsRows = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${id} LIMIT 1`;
  const workspace = wsRows[0]?.workspace_id ?? activeWorkspaceId();

  const rankRows = await sql<{ rank: number }[]>`
    SELECT harness_shared.reorder_work_item(
      ${workspace}, ${wi.assignee}, ${id}, ${Math.trunc(target)}, ${writer}
    ) AS rank`;
  const rank = Number(rankRows[0]?.rank ?? 0);

  const queueRows = await sql<{ feature_id: string; assignee_rank: number; title: string | null }[]>`
    SELECT feature_id, assignee_rank, title
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspace} AND taken_by = ${wi.assignee}
     ORDER BY assignee_rank ASC NULLS LAST, updated_ts DESC`;
  return {
    id,
    assignee: wi.assignee,
    rank,
    writer,
    queue: queueRows.map((r) => ({ id: r.feature_id, rank: r.assignee_rank, title: r.title ?? '' })),
  };
}

/** Linkable.link — an edge from this work-item to a target ObjectRef (rel blocks|relates|duplicates|fixes|…). */
export async function linkWorkItem(
  id: string,
  dst: ObjectRef,
  rel: string,
  opts: { harness?: string; by?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (dst.kind === FEATURE_KIND && !isQualifiedFeatureRef(dst.ref)) {
    return { error: `feature target ref must be '<harness>#<id>' (got '${dst.ref}')` };
  }
  if (wi.family === 'issue') {
    await linkIssue(id, dst, rel, opts.by);
  } else {
    await links.link(workItemObjectRef(wi), dst, rel, { created_by: opts.by, created_ts: nowIso() });
  }
  return { ok: true };
}

export async function unlinkWorkItem(
  id: string,
  dst: ObjectRef,
  rel: string,
  opts: { harness?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await unlinkIssue(id, dst, rel);
  else await links.unlink(workItemObjectRef(wi), dst, rel);
  // WI-4034 (the unlink gap): removing a `blocks` edge can be the dependent's
  // LAST live blocker clearing — the same condition emitWorkItemSettledEvents
  // fires `work-item:unblocked:<dst>` for when the blocker SETTLES. Before this,
  // an unlink (vs. a settle) never re-checked it, so an events:await registrant
  // silently strands to its 30-min timeout-wake. Fire-and-forget + lazy import
  // (mirrors the settle-path call above) — never blocks or fails this write.
  if (rel === 'blocks') {
    void import('./work-items-events')
      .then((m) => m.emitUnblockedOnEdgeRemoved(dst, id))
      .catch(() => {});
  }
  return { ok: true };
}

/** Resolve a target work-item id to its coord ObjectRef (for cross-kind linking). */
export async function resolveWorkItemRef(targetId: string, harness?: string): Promise<ObjectRef | null> {
  const wi = await getWorkItem(targetId, harness);
  return wi ? workItemObjectRef(wi) : null;
}

/** Taggable.addTag / removeTag (topic tags via coord_links rel='tagged'). */
export async function tagWorkItem(
  id: string,
  topic: string,
  opts: { harness?: string; by?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await tagIssue(id, topic, opts.by);
  else await tags.addTag(workItemObjectRef(wi), topic, { created_by: opts.by, created_ts: nowIso() });
  return { ok: true };
}
export async function untagWorkItem(
  id: string,
  topic: string,
  opts: { harness?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await untagIssue(id, topic);
  else await tags.removeTag(workItemObjectRef(wi), topic);
  return { ok: true };
}

/** Subscribable.subscribe. */
export async function subscribeWorkItem(
  subscriberId: string,
  id: string,
  mode: DeliveryMode = 'full',
  opts: { harness?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') {
    await subscribeIssue(subscriberId, id, mode);
  } else {
    await subs.subscribe({
      subscriber_id: subscriberId,
      target_kind: 'object',
      target_ref: `${FEATURE_KIND}:${workItemObjectRef(wi).ref}`,
      delivery_mode: mode,
      created_ts: nowIso(),
    });
  }
  return { ok: true };
}

/** Threadable.addPost (D-003) — comment on a work-item (creates the thread on first post). */
export async function commentWorkItem(
  id: string,
  body: string,
  authorId?: string,
  opts: { harness?: string } = {},
): Promise<ThreadPostRow | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  // issue-family: commentIssue already creates the thread + fires the issue_commented fan-out.
  if (wi.family === 'issue') return commentIssue(id, body, authorId);
  // feature-family: thread on the feature ObjectRef + fan out to the work-item's subscribers.
  const ref = workItemObjectRef(wi);
  // Durable write (get-or-create thread + add post) in ONE bounded txn: ATOMIC
  // (post row + post_count bump commit together) + BOUNDED (SET LOCAL
  // statement_timeout) so a stalled admin-pool query fails fast + typed rather
  // than hanging the MCP call. Mirrors commentIssue. See pg-bounded-txn.ts.
  const post = await boundedOrgTxn(async (tx) => {
    const txThreads = new PgThreadStore({ ...coordOpts, getSql: () => tx });
    const thread = await txThreads.getOrCreateThread(ref, {
      thread_id: `work-item-thread-${id}`,
      title: wi.title,
      created_by: authorId ?? undefined,
      created_ts: wi.createdAt,
    });
    return txThreads.addPost({ thread_id: thread.thread_id, author_id: authorId, body, created_ts: nowIso() });
  });
  const ev: InjectEvent = {
    from: authorId ?? 'substrate',
    subject: `${FEATURE_KIND}:${ref.ref}`,
    summary: `work_item ${id} — new comment${authorId ? ` from ${authorId}` : ''}`,
    notify_kind: 'work_item_commented',
  };
  await fanoutForObject(ref, ev, { excludeId: authorId });
  return post;
}

/** The mutable fields a work-item field-edit can touch (mirrors issues:update's
 *  fields — the issue family is the only one with directly-editable metadata). */
export interface UpdateWorkItemPatch {
  title?: string;
  body?: string;
  severity?: IssueSeverity;
  kind?: IssueKind;
  foundDuring?: string | null;
  linkedFeatureId?: string | null;
  /** EI-8497: bypass the fat-finger body-shrink guard (see updateIssue) — pass true
   *  when a large reduction in body length is genuinely intended. */
  confirmShrink?: boolean;
}

/**
 * Field-edit a work-item's mutable metadata (title / body / severity / kind /
 * found-during / linked-feature). Replaces the retired issues:update onto the
 * unified work_items surface. Dispatches by family:
 *   - issue-family (bug | change | task) → engineer-issues updateIssue (notifies subs).
 *   - feature-family (feature | research-task | chunk) → unsupported: a feature's
 *     fields are owned by the pipeline (scoper/architect), not a direct edit.
 * Returns the refreshed WorkItem on success, or a typed reason on failure — including
 * `body_shrink_guard` (EI-8497) when the edit would replace a substantial existing
 * body with something far shorter and the caller didn't pass `confirmShrink`.
 */
export async function updateWorkItem(
  id: string,
  patch: UpdateWorkItemPatch,
  by?: string,
  opts: { harness?: string } = {},
): Promise<
  | { ok: true; item: WorkItem }
  | { ok: false; reason: 'not_found' | 'unsupported_family' }
  | { ok: false; reason: 'body_shrink_guard'; existingLength: number; newLength: number }
> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { ok: false, reason: 'not_found' };
  if (wi.family !== 'issue') return { ok: false, reason: 'unsupported_family' };
  const issue = await updateIssue(id, { ...patch, by });
  if (issue === null) return { ok: false, reason: 'not_found' };
  if ('shrinkGuardTripped' in issue) {
    return { ok: false, reason: 'body_shrink_guard', existingLength: issue.existingLength, newLength: issue.newLength };
  }
  const refreshed = await getWorkItem(id, opts.harness);
  return refreshed ? { ok: true, item: refreshed } : { ok: false, reason: 'not_found' };
}

export interface PromoteToPipelineResult {
  workItem: WorkItem;
  feature: { id: string; title: string };
}

/**
 * promote-to-pipeline — give a non-pipeline work-item (a filed bug/change) a feature
 * pipeline run, by minting an F-FIX feature (reusing issues:promote's mintFixFeatureRow)
 * and linking it. A feature-family work-item already IS a pipeline item — no-op.
 */
export async function promoteToPipeline(
  id: string,
  opts: { harness?: string; actor?: string } = {},
): Promise<PromoteToPipelineResult | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'feature') {
    return { error: `work_item '${id}' (kind=${wi.kind}) is already a pipeline work-item` };
  }
  const res = await promoteIssue(id, { harness: opts.harness, actor: opts.actor });
  if ('error' in res) return res;
  return { workItem: issueToWorkItem(res.issue), feature: res.feature };
}
