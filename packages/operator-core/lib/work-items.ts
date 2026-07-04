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
import { autoPickableWhereSql } from './work-items-admission';
import { frontierPlacementKindClause } from './datatype-frontier-placement';
import { hasGenericKind } from './datatype-registry-store';
import { FEATURE_NON_REQUEUE_STATES, FEATURE_TERMINAL_STATES, normalizeFeatureStateInput } from './work-item-dispatch-states';
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
  promoteIssue,
  issuesScopeWorkspace,
  mergeIssuePayload,
  type EngineerIssue,
} from './issues-engineer';

// ── Kinds ───────────────────────────────────────────────────────────────────────
export type FeatureFamilyKind = 'feature' | 'research-task' | 'chunk';
export type WorkItemKind = FeatureFamilyKind | IssueStoreKind;
export type WorkItemFamily = 'feature' | 'issue';

export const FEATURE_FAMILY_KINDS: readonly FeatureFamilyKind[] = ['feature', 'research-task', 'chunk'];
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
  /** When the item was claimed (feature → taken_at; ISO). null when unclaimed.
   *  The grace anchor for {@link ./item-activity}.classifyItemActivity. */
  takenAt: string | null;
  /**
   * Last REAL item-scoped progress — a state transition (setWorkItemState) or a
   * checkpoint write — as an ISO string; null = no progress recorded yet
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
  /** Who last set `rank` — the propose/dispose audit (D-008). 'bee' (the default,
   *  bee-authored) | 'queen' (Queen overlay). null when unranked. */
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

/** The propose/dispose author of a work-item's rank (local-hive D-008). */
export type RankWriter = 'bee' | 'queen';
export const RANK_WRITERS: readonly RankWriter[] = ['bee', 'queen'];
export function isRankWriter(v: unknown): v is RankWriter {
  return v === 'bee' || v === 'queen';
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
  return evidence && Object.keys(evidence).length > 0 ? JSON.stringify({ [TERMINAL_COMPLETION_EVIDENCE_KEY]: evidence }) : null;
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
    // Issue-family has no claim-time / progress columns (it isn't the dispatched,
    // lease-held backlog) — agent-activity-liveness-truth P-001 applies only to the
    // feature family. classifyItemActivity returns 'free' for a null-taken item anyway.
    takenAt: null,
    lastProgressAt: null,
    assignedBy: i.assignedBy,
    severity: i.severity,
    parent: null,
    payload: i.payload ?? null,
    rank: i.assigneeRank,
    rankWriter: i.rankWriter,
    rankUpdatedAt: i.rankUpdatedAt,
    priority: null, // issue-family (bug/change/task) isn't the dispatched backlog — no feature_order
    terminalOwner: i.terminalOwner,
    terminalCompletionRef: i.terminalCompletionRef,
    terminalCompletionEvidence: extractTerminalCompletionEvidence(i.payload),
    // Issue-family isn't auditor-gated (bug/change run inline, not autonomous remote
    // dispatch) — report 'local' so isAutoPickable treats them as pickable (unchanged).
    origin: 'local',
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
}

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
 * not one of the three built-ins, so a bare `IN ('feature','research-task','chunk')` would
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
  return sql`(item_kind IN ('feature', 'research-task', 'chunk')
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
  return { ...wi, topics, posts, links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })) };
}

/** Cross-kind full-text search over both kind-tables (parity with issues:search). */
export async function searchWorkItems(query: string, opts: { harness?: string; kind?: WorkItemKind; limit?: number } = {}): Promise<WorkItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const wantFeature = !opts.kind || familyOf(opts.kind) === 'feature';
  const wantIssue = !opts.kind || familyOf(opts.kind) === 'issue';
  const out: WorkItem[] = [];

  if (wantIssue) {
    let issues = (await searchIssues(query, limit)).map(issueToWorkItem);
    if (opts.harness) issues = issues.filter((w) => w.harness === opts.harness);
    if (opts.kind && familyOf(opts.kind) === 'issue') issues = issues.filter((w) => w.kind === opts.kind);
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
  void import('./hive/urgent-wake')
    .then((m) =>
      m.requestUrgentHiveWake({
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
  void import('./work-items-events')
    .then((m) => m.emitWorkItemClaimedEvent(wi, assignTo))
    .catch(() => {});
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
  const assignTo =
    typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : null;

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
    'harness_slug', 'feature_id', 'title', 'summary', 'status', 'attempts',
    'item_kind', 'payload', 'parent_id', 'needs_design', 'needs_human_review', 'ts', 'created_ts', 'updated_ts',
    'source_plan_slug',
  ];
  const vals = [
    '$1', '$2', '$3', '$4', `'todo'`, '0',
    '$5', '$6::jsonb', '$7', 'FALSE', 'FALSE', '$8', '$9', '$10',
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
  const aliases: Record<string, string> = {
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
    'in_progress': 'open',
    wip: 'open',
    blocked: 'open',
    'needs-human': 'open',
  };
  const mapped = aliases[state] ?? state;
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
  let result: WorkItem | null;
  if (wi.family === 'issue') {
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
    void import('./work-items-events')
      .then((m) => m.emitWorkItemStatusEvent(transitioned, prevState))
      .catch(() => {});
  }
  // await-event-primitive P-012/P-013: a SETTLED item fires
  // `work-item:done:<id>` (+ `work-item:unblocked:<dep>` for dependents whose
  // last blocker cleared). Fire-and-forget + lazy import (work-items-events
  // imports this module statically) — an emit failure never breaks the write.
  if (result && isSettledWorkItemState(result.state)) {
    const settled = result;
    void import('./work-items-events')
      .then((m) => m.emitWorkItemSettledEvents(settled))
      .catch(() => {});
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
    void import('./sentinel/sentinel-deep-watch')
      .then((m) =>
        m.injectDeepAnswerIfTracked(
          {
            id: settled.id,
            title: settled.title,
            state: settled.state,
            harness: settled.harness,
            terminalCompletionRef:
              (settled as { terminalCompletionRef?: string | null }).terminalCompletionRef ?? null,
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
    void import('./work-items-events')
      .then((m) => m.emitWorkItemBlockedEvent(blocked))
      .catch(() => {});
  }
  return result;
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
  const terminalTotal =
    Number(featureRows[0]?.terminal_total ?? 0) + Number(issueRows[0]?.terminal_total ?? 0);
  const genuineCompletions =
    Number(featureRows[0]?.genuine ?? 0) + Number(issueRows[0]?.genuine ?? 0);
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
export async function claimWorkItem(id: string, assignee: string, opts: { harness?: string } = {}): Promise<WorkItem | null> {
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
    void import('./work-items-events')
      .then((m) => m.emitWorkItemClaimedEvent(won, assignee))
      .catch(() => {});
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

export function classifyClaimFailure(
  current: { assignee?: string | null } | null,
  claimer: string,
): ClaimFailure {
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
    AND ${opts.cooldownAssignee && cooldown > 0
      ? sql`(last_released_by IS NULL
        OR last_released_by <> ${opts.cooldownAssignee}
        OR last_released_at IS NULL
        OR last_released_at < now() - make_interval(secs => ${cooldown}))`
      : sql`TRUE`}
    -- Built-in placeable kinds + any generic-kind datatype that opted into placement
    -- (the 'hive-placement' tag — frontierPlacementKindClause). DARK until a datatype opts in.
    AND ${frontierPlacementKindClause(sql, opts.workspaceId)}
    -- G2 admission (shared-hive-trust-admission P-002): never self-select a remote,
    -- un-admitted item — the same gate the feature frontier enforces (P-010 trust leg,
    -- ws-scoped via the same ws this query filters on).
    AND ${autoPickableWhereSql(sql, opts.workspaceId)}
    AND (taken_by IS NULL OR taken_by = '')
    AND status = ANY(${states}::text[])
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
    AND ${opts.useMaintainedReady
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
    )`}`;
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
    const issuePoolRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.work_items wi
       WHERE wi.item_kind IN ('bug', 'change', 'task')
         AND wi.workspace_id = ${issueWs}
         AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
         AND (wi.taken_by IS NULL OR wi.taken_by = '')
         AND wi.status = ANY(${[...ISSUE_FAMILY_CLAIMABLE_STATES]}::text[])`;
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
         )`;
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
 */
export async function claimNextIssueWorkItem(
  filter: ClaimNextFilter,
  _ws: string,
  opts: { issueKinds?: readonly IssueStoreKind[] } = {},
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
  const rows = await sql<FeatureRowDb[]>`
    UPDATE harness_shared.work_items
       SET taken_by = ${filter.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
     WHERE (workspace_id, feature_id) = (
       SELECT workspace_id, feature_id
         FROM harness_shared.work_items wi
        WHERE wi.item_kind = ANY(${issueKinds}::text[])
          AND wi.workspace_id = ${issueWs}
          AND (wi.harness_slug = ${filter.harness} OR wi.harness_slug = ${operatorScopeSlug})
          AND (wi.taken_by IS NULL OR wi.taken_by = '')
          AND wi.status = ANY(${[...states]}::text[])
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
        ORDER BY ${filter.swarmId ? sql`(wi.swarm_affinity = ${filter.swarmId}) DESC NULLS LAST, wi.feature_order ASC NULLS LAST,` : sql``} wi.created_ts ASC
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
  const issue = await getIssueInWorkspace(issueWs, rows[0].feature_id);
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
     WHERE workspace_id = ${issueWs} AND feature_id = ${rows[0].feature_id}`;
  throw new Error(
    `claimNextIssueWorkItem: claimed issue ${rows[0].feature_id} in workspace '${issueWs}' but could ` +
      `not re-read it (getIssueInWorkspace returned null); released the claim. This is an anomaly, ` +
      `not a peer race.`,
  );
}

export interface WorkItemObservation {
  item: WorkItem;
  /** Unclaimed and so available to claim. */
  available: boolean;
  claimedBy: string | null;
}

/**
 * The tuple-space `rd` (D-004): OBSERVE a work-item without claiming it — the read
 * primitive, kept DISTINCT from the `in` of claim. Reports claimability so a self-
 * selecting agent can decide before taking. (list/get are the bulk rd surface; this is
 * the explicit single-item observe-with-claimability.)
 */
export async function observeWorkItem(id: string, opts: { harness?: string } = {}): Promise<WorkItemObservation | null> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return null;
  return { item: wi, available: !wi.assignee, claimedBy: wi.assignee };
}

export async function releaseWorkItem(id: string, opts: { harness?: string } = {}): Promise<WorkItem | null> {
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
      void import('./work-items-events')
        .then((m) => m.emitClaimReleasedEvent(released))
        .catch(() => {});
    }
  };
  if (wi.family === 'issue') {
    const updated = await releaseIssue(id);
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
 * (pre-claim); rank = a per-assignee queue (post-claim). Feature-family only — the
 * issue-family table (bugs/changes) has no `feature_order` and is not the dispatched
 * backlog, so for an issue-family id these are no-ops returning `applicable: false`.
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
        hiveSlug: lease.hiveSlug ?? 'unknown',
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
    const targetI = position === 'top' ? (minI === null ? 0 : minI - 1) : (maxI === null ? 0 : maxI + 1);
    return setWorkItemPriority(id, targetI, opts);
  }
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const ext = await sql<{ min_ord: number | null; max_ord: number | null }[]>`
    SELECT MIN(feature_order) AS min_ord, MAX(feature_order) AS max_ord
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${wi.harness}
       AND workspace_id = ${ws}
       AND item_kind IN ('feature', 'research-task', 'chunk')
       AND feature_id <> ${id}`;
  const min = ext[0]?.min_ord ?? null;
  const max = ext[0]?.max_ord ?? null;
  const target = position === 'top' ? (min === null ? 0 : min - 1) : (max === null ? 0 : max + 1);
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
    if (!(await schedulerIssuesClaimableEnabled())) return { id, harness: wi.harness, priority: null, applicable: false };
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
 * both base tables). `writer` ('bee'|'queen') stamps the propose/dispose audit (D-008);
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
  const writer: RankWriter = opts.writer ?? 'bee';
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
export async function linkWorkItem(id: string, dst: ObjectRef, rel: string, opts: { harness?: string; by?: string } = {}): Promise<{ ok: true } | { error: string }> {
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

export async function unlinkWorkItem(id: string, dst: ObjectRef, rel: string, opts: { harness?: string } = {}): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await unlinkIssue(id, dst, rel);
  else await links.unlink(workItemObjectRef(wi), dst, rel);
  return { ok: true };
}

/** Resolve a target work-item id to its coord ObjectRef (for cross-kind linking). */
export async function resolveWorkItemRef(targetId: string, harness?: string): Promise<ObjectRef | null> {
  const wi = await getWorkItem(targetId, harness);
  return wi ? workItemObjectRef(wi) : null;
}

/** Taggable.addTag / removeTag (topic tags via coord_links rel='tagged'). */
export async function tagWorkItem(id: string, topic: string, opts: { harness?: string; by?: string } = {}): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await tagIssue(id, topic, opts.by);
  else await tags.addTag(workItemObjectRef(wi), topic, { created_by: opts.by, created_ts: nowIso() });
  return { ok: true };
}
export async function untagWorkItem(id: string, topic: string, opts: { harness?: string } = {}): Promise<{ ok: true } | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'issue') await untagIssue(id, topic);
  else await tags.removeTag(workItemObjectRef(wi), topic);
  return { ok: true };
}

/** Subscribable.subscribe. */
export async function subscribeWorkItem(subscriberId: string, id: string, mode: DeliveryMode = 'full', opts: { harness?: string } = {}): Promise<{ ok: true } | { error: string }> {
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
export async function commentWorkItem(id: string, body: string, authorId?: string, opts: { harness?: string } = {}): Promise<ThreadPostRow | null> {
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
}

/**
 * Field-edit a work-item's mutable metadata (title / body / severity / kind /
 * found-during / linked-feature). Replaces the retired issues:update onto the
 * unified work_items surface. Dispatches by family:
 *   - issue-family (bug | change | task) → engineer-issues updateIssue (notifies subs).
 *   - feature-family (feature | research-task | chunk) → unsupported: a feature's
 *     fields are owned by the pipeline (scoper/architect), not a direct edit.
 * Returns the refreshed WorkItem on success, or a typed reason on failure.
 */
export async function updateWorkItem(
  id: string,
  patch: UpdateWorkItemPatch,
  by?: string,
  opts: { harness?: string } = {},
): Promise<{ ok: true; item: WorkItem } | { ok: false; reason: 'not_found' | 'unsupported_family' }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { ok: false, reason: 'not_found' };
  if (wi.family !== 'issue') return { ok: false, reason: 'unsupported_family' };
  const issue = await updateIssue(id, { ...patch, by });
  if (!issue) return { ok: false, reason: 'not_found' };
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
export async function promoteToPipeline(id: string, opts: { harness?: string; actor?: string } = {}): Promise<PromoteToPipelineResult | { error: string }> {
  const wi = await getWorkItem(id, opts.harness);
  if (!wi) return { error: `work_item '${id}' not found` };
  if (wi.family === 'feature') {
    return { error: `work_item '${id}' (kind=${wi.kind}) is already a pipeline work-item` };
  }
  const res = await promoteIssue(id, { harness: opts.harness, actor: opts.actor });
  if ('error' in res) return res;
  return { workItem: issueToWorkItem(res.issue), feature: res.feature };
}
