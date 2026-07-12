/**
 * engineer_issues store — the agent-facing issue surface (engineer-issues-2026-06-03, Phase 1).
 *
 * A separate table from the validator pipeline (harness_issues_consolidated). It rides the
 * coordination substrate (migration 123) for the shared capabilities:
 *   - Taggable    → topic tags (PgTaggableStore, coord_links rel='tagged')
 *   - Threadable  → comment timeline (PgThreadStore, coord_threads/_posts)
 *   - Subscribable→ followers (PgEntitySubscriptionStore, coord_entity_subscriptions)
 *   - Linkable    → blocking/relates edges (PgLinkStore, coord_links) — Phase 2
 *   - Claimable   → `assignee` scalar (here)
 *   - Lifecycle   → `state` scalar (here; open|resolved|closed)
 *
 * Every mutation fans out to the issue's subscribers (direct ∪ topic) via the local
 * fan-out (fanoutForObject) — D-009 v1 is workspace-local; harness-scoped federation is
 * the deferred upgrade (a capture trigger + peer-log projection).
 *
 * ObjectRef: kind 'issue', ref the GLOBALLY-unique 'EI-<n>' id (distinct from the
 * pipeline's per-harness 'I-NNNN', so both share the unified 'issue' kind for topic
 * fan-out without a ref collision).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from './work-items';
import { assertScopeWellFormed } from './work-item-scope';
import { neutralizeToolCallTags } from './text-safety';
import {
  PgTaggableStore,
  PgThreadStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  LIFECYCLE_STATES,
  type ObjectRef,
  type DeliveryMode,
  type ThreadPostRow,
  type LifecycleState,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { activeWorkspaceId } from './workspace-registry';
import { systemDistinctId } from './flag-distinct-id';
import { type InjectEvent } from './agent-tools/coordination/fanout-delivery';
import { coordScopeWorkspace } from './agent-tools/coordination/log';
import { fanoutForObject } from './sync/hyperbee/fanout-projection';
import { boundedOrgTxn } from './pg-bounded-txn';
import { resolveProject } from './harness-core';
import { mintFixFeatureRow } from './promote-issue';
import type { Issue as PipelineIssue } from './harness/issue-types';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';
import { DEFAULT_SIGNAL_ORIGIN, type SignalOrigin } from './harness/improvements/provenance';
import { ISSUE_TERMINAL_STATUSES } from './work-item-blocking';

/**
 * Upper bound on rows a single `listIssues` read returns. Kept in lock-step with
 * `WORK_ITEMS_MAX_LIMIT` (work-items.ts) — the unified work-items list requests
 * up to that many, and a lower inner cap here was silently truncating the issue
 * leg (the "938 of 1821" the pane showed: features loaded but issues pinned at
 * 500 while countIssues tallied them all). Declared as a local literal, NOT
 * imported from work-items.ts, because work-items.ts imports listIssues from
 * here — importing back would be a circular dependency. Callers beyond this cap
 * page via infinite scroll (a larger `limit`), so this is a per-read ceiling,
 * not a hard product cap.
 */
const ISSUES_MAX_LIMIT = 2000;

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type IssueSource = 'engineer' | 'su';
// Lifecycle vocabulary sourced from the ONE canonical LifecycleState (P-007) so a
// future 4th state can't drift across issues / work-items / conversations /
// improvements. The per-kind setState UPDATE bodies stay distinct (D-007).
export type IssueState = LifecycleState;
/** Work-item kind within the issue kind-table for the issues:* SURFACE
 *  (unify-work-items D-002). bug|change are the user-facing issue kinds. */
export type IssueKind = 'bug' | 'change';
/** Every kind physically stored in engineer_issues (collapse-delegate D-001):
 *  the issue-surface kinds PLUS `task` — a delegated unit of work (retired delegate
 *  durable record). `task` is a work_item kind only; the issues:* surface excludes it. */
export type IssueStoreKind = IssueKind | 'task';

export const ISSUE_KIND = 'issue';
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['critical', 'major', 'minor', 'nit'];
export const ISSUE_STATES: readonly IssueState[] = LIFECYCLE_STATES;
export const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'change'];
/** Storage kinds (incl. `task`). The default listIssues filter restricts to
 *  ISSUE_KINDS so delegated tasks never leak into the issues:* surface. */
export const ISSUE_STORE_KINDS: readonly IssueStoreKind[] = ['bug', 'change', 'task'];

export interface EngineerIssue {
  id: string;
  kind: IssueStoreKind; // work-item kind: bug | change (unify-work-items D-002) | task (collapse-delegate D-001)
  scope: string; // 'operator' | 'harness:<slug>'
  title: string;
  body: string;
  severity: IssueSeverity;
  source: IssueSource;
  state: IssueState;
  assignee: string | null;
  /** Durable delegator (collapse-delegate D-002): who created+assigned this item. */
  assignedBy: string | null;
  assignedAt: string | null;
  /** WI-2990/WI-3006: the real item-scoped progress signal (agent-activity-liveness-truth
   *  P-001), mirroring the feature-family's last_progress_at. Populated by markIssueProgress()
   *  on a checkpoint; null until the first one. Exposed on the engineer_issues compat view by
   *  migration 509 (it always existed on the unified work_items base table). */
  lastProgressAt: string | null;
  /** Kind-specific data (collapse-delegate D-001): a task's {agentSessionId,origin,backend}. */
  payload: unknown | null;
  /** Federation provenance from the physical work_items row. */
  origin: string | null;
  foundDuring: string | null;
  linkedFeatureId: string | null;
  createdBy: string | null;
  /** Learning-signal provenance (self-learning-frontier P-002/D-002, migration 241):
   *  organic | drill | replay | shadow. Learning consumers filter to organic unless
   *  explicitly opted in (read-items.ts). Distinct from the federation `origin` column. */
  signalOrigin: SignalOrigin;
  /** Position within the ASSIGNEE's ordered work-list (local-hive P-020). null = unranked. */
  assigneeRank: number | null;
  /** Who last set assigneeRank — 'bee' | 'queen' (+ dual-accept twins 'cup' | 'mug';
   *  the propose/dispose audit, D-008). */
  rankWriter: 'cup' | 'mug' | null;
  /** When assigneeRank was last written. */
  rankUpdatedAt: string | null;
  /** Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
   *  the claiming principal who drove this issue to its CURRENT terminal state
   *  (resolved|closed), or null if it has never reached one. Set only alongside
   *  a terminal setIssueState transition — never cleared on reopen. */
  terminalOwner: string | null;
  /** Paired with terminalOwner: the completion evidence (summary / commit / coord
   *  or plan-item ref) recorded for the CURRENT terminal state. Both are required
   *  together — a terminal transition without either is rejected by setIssueState. */
  terminalCompletionRef: string | null;
  /** EI-10421: the SHARED backlog priority (`feature_order` on the `work_items` base
   *  row) — the Queen's steer-don't-dispatch lever, DISTINCT from `assigneeRank` (a
   *  per-assignee post-claim queue order). Issue-family items joined the dispatched
   *  backlog under P-007/EI-7407 (`setWorkItemPriority` writes this for bug/change/task
   *  too, and `claimNextIssueWorkItem`'s claim order already reads it unconditionally);
   *  this column exposes that on the read side (was hardcoded null — migration 588).
   *  LOWER = claimed sooner (inverted scale, same convention as feature-family); null =
   *  unprioritized. */
  featureOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EngineerIssueDetail extends EngineerIssue {
  topics: string[];
  posts: ThreadPostRow[];
  /** Edges OUT of this issue (e.g. blocks → plan_item|feature). */
  links: { rel: string; dst: ObjectRef }[];
}

// ── Workspace scoping has TWO independent axes (EI-2760, the green-gate fix):
//
//  1. The engineer_issues ROWS are DOMAIN data → scoped per-workspace by
//     issuesScopeWorkspace() (workspace-data-isolation-leaks D-001: rows isolate when
//     papercusp-issues-per-workspace is ON, else the legacy shared 'default').
//  2. Their COORD METADATA (tags / threads / subscriptions / links) is SUBSTRATE data —
//     it rides the shared coordination plane and is keyed by the GLOBAL issue id. Every
//     substrate CONSUMER (fanoutForObject, topics-feed, issue-blocks-merge) reads it under
//     the COORD scope (coordScopeWorkspace). So the metadata stores MUST write under that
//     SAME coord scope, NOT the issue-row scope — otherwise, in any non-'default' workspace,
//     writes (issuesScope) and consumers (coordScope) silently desync and fan-out / topic
//     feeds / plan-item blocks all deliver nothing. D-001 scoped BOTH axes by the row scope;
//     that was the regression. Per-workspace issue COORDINATION returns coherently when the
//     substrate itself goes per-workspace (COORD_PER_WORKSPACE) — the rows already isolate.
//
// EI-<n> ids stay GLOBALLY allocated (nextIssueId is unchanged), so the global ObjectRef
// contract that lets metadata key by issue id across workspaces holds. ──────────────────
let issuesPerWorkspaceOn = false;
let issuesFlagReadAtMs = 0;
// Self-heal cadence for the cached flag (EI-1460). Short enough that a flip is
// honoured within a few seconds anywhere; long enough that the PG-backed getFlag
// (itself 5s-TTL-cached) is hit at most ~once per window per process.
const ISSUES_FLAG_TTL_MS = 3_000;
async function refreshIssuesPerWorkspace(): Promise<void> {
  try {
    issuesPerWorkspaceOn = await getFlag(FLAGS.ISSUES_PER_WORKSPACE, systemDistinctId());
  } catch {
    issuesPerWorkspaceOn = false;
  } finally {
    issuesFlagReadAtMs = Date.now();
  }
}
void refreshIssuesPerWorkspace();
onFlagChange((key) => {
  if (key === null || key === FLAGS.ISSUES_PER_WORKSPACE) void refreshIssuesPerWorkspace();
});
/** The engineer-issues workspace scope NOW (F): active workspace when the flag is ON,
 *  else the legacy shared `default` coord workspace.
 *
 *  EI-1460: `onFlagChange` is IN-PROCESS only and the registration happens at module
 *  load, so a flip via the PG override store in another operator process — or a flip
 *  that lands before this module is lazily imported — would leave the cached bool stale
 *  FOREVER (the flag would silently never take effect, the symptom that shipped a wrong
 *  data-backfill). Self-heal on a short TTL: a stale read kicks a fire-and-forget
 *  refresh through `getFlag`, which reads the PG-backed override (cross-process-correct).
 *  The sync contract is preserved; the value converges within one getFlag round-trip. */
export function issuesScopeWorkspace(): string {
  if (Date.now() - issuesFlagReadAtMs > ISSUES_FLAG_TTL_MS) void refreshIssuesPerWorkspace();
  return issuesPerWorkspaceOn ? activeWorkspaceId() : DEFAULT_COORD_WORKSPACE;
}

/**
 * WI-4308 interim mitigation: workspace ids to consult for DEDUP-ONLY reads
 * (`searchIssuesForDedup`, `findIssuesByWatchdogKeys`). ~1404 open engineer_issues
 * rows filed before ISSUES_PER_WORKSPACE flipped ON are permanently stuck under
 * workspace_id=DEFAULT_COORD_WORKSPACE ('default') and invisible to a single-scope
 * `issuesScopeWorkspace()` filter, so dedup can no longer see them at all — a
 * detector re-firing the same signal (same watchdogKey, same title) creates a fresh
 * duplicate instead of finding its still-open pre-flip twin. Additive/low-risk
 * stopgap: only widens DEDUP reads (never `searchIssues` itself, which also backs
 * the caller-visible `work_items:search` tool — see WI-4308 for the full
 * row+coord-metadata migration this is a stopgap for, and why a blind backfill of
 * the 1404 rows is NOT done here).
 */
function dedupScopeWorkspaces(): string[] {
  const active = issuesScopeWorkspace();
  return active === DEFAULT_COORD_WORKSPACE ? [active] : [active, DEFAULT_COORD_WORKSPACE];
}

// Substrate stores resolve under the COORD scope (axis 2 above) so writes land where every
// consumer reads. The engineer_issues ROW queries below keep issuesScopeWorkspace() (axis 1).
const coordOpts = {
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  getWorkspaceId: () => coordScopeWorkspace(),
};
const tags = new PgTaggableStore(coordOpts);
const threads = new PgThreadStore(coordOpts);
const subs = new PgEntitySubscriptionStore(coordOpts);
const links = new PgLinkStore(coordOpts);
// (topic-subscriber resolution now lives in fanoutForObject's own stores — A6.)

export function issueRef(id: string): ObjectRef {
  return { kind: ISSUE_KIND, ref: id };
}
function threadId(id: string): string {
  return `issue-thread-${id}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

interface IssueRowDb {
  issue_id: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  severity: string;
  source: string;
  state: string;
  assignee: string | null;
  assigned_by: string | null;
  assigned_at: unknown;
  last_progress_at: unknown;
  payload: unknown;
  origin: string | null;
  found_during: string | null;
  linked_feature_id: string | null;
  created_by: string | null;
  signal_origin: string | null;
  assignee_rank: number | null;
  rank_writer: string | null;
  rank_updated_at: unknown;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
  feature_order: number | null;
  created_at: unknown;
  updated_at: unknown;
}
function tsIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function tsIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
function toIssue(r: IssueRowDb): EngineerIssue {
  return {
    id: r.issue_id,
    kind: (r.kind as IssueStoreKind) ?? 'bug',
    scope: r.scope,
    title: r.title,
    body: r.body,
    severity: r.severity as IssueSeverity,
    source: r.source as IssueSource,
    state: r.state as IssueState,
    assignee: r.assignee,
    assignedBy: r.assigned_by,
    assignedAt: tsIsoOrNull(r.assigned_at),
    lastProgressAt: tsIsoOrNull(r.last_progress_at),
    payload: r.payload ?? null,
    origin: r.origin ?? 'local',
    foundDuring: r.found_during,
    linkedFeatureId: r.linked_feature_id,
    createdBy: r.created_by,
    // NULL only on a pre-migration-241 read (the column default backfills) —
    // legacy rows are organic by definition. Junk can't pass the CHECK constraint.
    signalOrigin: (r.signal_origin ?? DEFAULT_SIGNAL_ORIGIN) as SignalOrigin,
    assigneeRank: r.assignee_rank,
    rankWriter: r.rank_writer === 'cup' || r.rank_writer === 'mug' ? r.rank_writer : null,
    rankUpdatedAt: tsIsoOrNull(r.rank_updated_at),
    terminalOwner: r.terminal_owner,
    terminalCompletionRef: r.terminal_completion_ref,
    featureOrder: r.feature_order,
    createdAt: tsIso(r.created_at),
    updatedAt: tsIso(r.updated_at),
  };
}

const ISSUE_COLS = `issue_id, kind, scope, title, body, severity, source, state, assignee,
  assigned_by, assigned_at, last_progress_at, payload, found_during, linked_feature_id, created_by,
  origin, signal_origin, assignee_rank, rank_writer, rank_updated_at, terminal_owner,
  terminal_completion_ref, feature_order, created_at, updated_at`;

const TERMINAL_COMPLETION_EVIDENCE_KEY = '_completionEvidence';
function completionEvidencePayloadJson(evidence: CompletionVerificationEvidence | undefined): string | null {
  return evidence && Object.keys(evidence).length > 0
    ? JSON.stringify({ [TERMINAL_COMPLETION_EVIDENCE_KEY]: evidence })
    : null;
}

/** Allocate the next globally-unique EI-<n> id. */
async function nextIssueId(sql = getOrgPg().sql): Promise<string> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('papercusp:engineer_issues:next-id'))`;
  const rows = await sql<{ n: number }[]>`
    SELECT COALESCE(MAX((substring(issue_id from 4))::int), 0) AS n
      FROM harness_shared.engineer_issues
     WHERE issue_id ~ '^EI-[0-9]+$'`;
  return `EI-${(Number(rows[0]?.n) || 0) + 1}`;
}

/** Per-op notify_kind, as data (mirrors the fanout-projection registry shape —
 *  adopt-event-rules-engines D-005). `resolved` is the one lifecycle resolution. */
const ISSUE_NOTIFY_KINDS = {
  created: 'issue_created',
  updated: 'issue_updated',
  commented: 'issue_commented',
  resolved: 'issue_resolved',
} as const;

async function deliver(
  issue: EngineerIssue,
  op: keyof typeof ISSUE_NOTIFY_KINDS,
  summary: string,
  actor = 'substrate',
): Promise<number> {
  // Fan out to the issue's subscribers (direct ∪ topic), excluding the actor so
  // an agent is never notified of its own action. Routed through the canonical
  // fanoutForObject seam (A6) instead of an inline resolve→deliverInjectMany —
  // behaviour-preserving (it does the same actor-excluded resolve + deliver).
  // The author-exclusion on CREATE still holds: createIssue auto-subscribes the
  // author AFTER its deliver() call, so the author isn't a subscriber yet here.
  const ev: InjectEvent = {
    from: actor,
    subject: `${ISSUE_KIND}:${issue.id}`,
    summary,
    notify_kind: ISSUE_NOTIFY_KINDS[op],
    isResolution: op === 'resolved',
  };
  return fanoutForObject(issueRef(issue.id), ev, { excludeId: actor });
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  severity?: IssueSeverity;
  source?: IssueSource;
  scope?: string; // default 'operator'
  foundDuring?: string;
  topics?: string[];
  createdBy?: string;
  /** Work-item kind: bug (default) | change (unify-work-items D-002) | task (collapse-delegate D-001). */
  kind?: IssueStoreKind;
  /** Agent the item is assigned to at creation (collapse-delegate: the delegate session). */
  assignee?: string;
  /** Durable delegator (collapse-delegate D-002): who created+assigned it. Sets assigned_at=now(). */
  assignedBy?: string;
  /** Kind-specific data (collapse-delegate D-001): a task's resume metadata. */
  payload?: unknown;
  /** Learning-signal provenance (frontier P-002/D-002). Default 'organic'; only
   *  frontier loops (vaccination drills, replay, shadow ablation) pass non-organic. */
  signalOrigin?: SignalOrigin;
  /**
   * Explicit id — used by the unified work_items:create path to mint a
   * kind-independent WI-NNN id (D-008). Omit for the legacy issues:create path,
   * which allocates the next EI-<n>.
   */
  id?: string;
}

/** Create an issue: insert, tag topics, auto-subscribe the author, fan out. */
export async function createIssue(input: CreateIssueInput): Promise<EngineerIssue> {
  const created = nowIso();
  // unified-work-item-ledger P-001: a harness-attributable item must never be
  // silently filed operator-global via a missing/blank harness. operator stays
  // valid only as the EXPLICIT default; a malformed `harness:` (empty slug) throws.
  // allow-scope-default: 'operator' is the explicit top-level issue scope (vs harness:<slug>), not a workspace.
  const scope = input.scope ?? 'operator';
  assertScopeWellFormed(scope);
  // EI-9267: neutralize tool-call-lookalike tags (<invoke>/<parameter>/…) in the
  // free-text title/body BEFORE they are stored — the single choke point every
  // issue-family create path (improvements:capture, work_items:create) funnels
  // through, so a pasted-in or planted fake tool-call block can never later be
  // misread by a reading agent as a live continuation of its own tool stream.
  const safeTitle = neutralizeToolCallTags(input.title);
  const safeBody = neutralizeToolCallTags(input.body);
  const issue = await boundedOrgTxn(async (tx) => {
    const id = input.id ?? (await nextIssueId(tx));
    const rows = await tx<IssueRowDb[]>`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state, assignee,
         assigned_by, assigned_at, payload, found_during, created_by, signal_origin, created_at, updated_at)
      VALUES (${issuesScopeWorkspace()}, ${id}, ${input.kind ?? 'bug'}, ${scope}, ${safeTitle}, ${safeBody ?? ''},
              ${input.severity ?? 'minor'}, ${input.source ?? 'engineer'}, 'open', ${input.assignee ?? null},
              ${input.assignedBy ?? null}, ${input.assignedBy ? created : null},
              ${input.payload != null ? JSON.stringify(input.payload) : null}::text::jsonb, ${input.foundDuring ?? null},
              ${input.createdBy ?? null}, ${input.signalOrigin ?? DEFAULT_SIGNAL_ORIGIN}, ${created}, ${created})
      RETURNING ${tx.unsafe(ISSUE_COLS)}`;
    return toIssue(rows[0]);
  });
  const id = issue.id;

  for (const topic of input.topics ?? []) {
    await tags.addTag(issueRef(id), topic, { created_by: input.createdBy, created_ts: created });
  }
  // Deliver to topic subscribers BEFORE the author subscribes, so the author is
  // not notified of their own filing (but is subscribed for future updates).
  await deliver(
    issue,
    'created',
    `issue ${id} filed (${issue.severity}): ${issue.title}`,
    input.createdBy ?? 'substrate',
  );
  if (input.createdBy) {
    await subs.subscribe({
      subscriber_id: input.createdBy,
      target_kind: 'object',
      target_ref: `${ISSUE_KIND}:${id}`,
      delivery_mode: 'full',
      created_ts: created,
    });
  }
  return issue;
}

export interface ListIssuesFilter {
  state?: IssueState;
  scope?: string;
  assignee?: string;
  /** Durable delegator filter (collapse-delegate D-002): items this owner assigned. */
  assignedBy?: string;
  severity?: IssueSeverity;
  kind?: IssueStoreKind; // bug | change | task
  /** Explicit kind set. Overrides the default (which restricts to the bug|change
   *  issue surface — `task` items never leak into issues:* unless asked for). */
  kinds?: readonly IssueStoreKind[];
  topic?: string; // issues tagged with this topic
  /** Learning-signal provenance allowlist (frontier P-002/D-002). Omit = NO origin
   *  filter (the generic work-item surface shows everything); the LEARNING read
   *  seam (read-items.ts) is what defaults to organic-only. */
  signalOrigins?: readonly SignalOrigin[];
  limit?: number;
  /**
   * WI-3649: when true, exclude a federated (origin='remote') row — the issue-family
   * counterpart of `listWorkItems`'s feature-family `admissibleOnly` (EI-7841), applying
   * {@link isIssueLocallyClaimable}'s SAME predicate the actual claim path
   * (`claimIssue`'s engineer_issues_view_dml trigger, EI-7833) enforces. Default
   * false/omitted: byte-identical to before (every existing caller keeps seeing the
   * full backlog including remote-authored rows). Opt in for a SELF-SELECT consumer
   * (work_items:list's issue branch) so "claimable" actually means claimable.
   */
  admissibleOnly?: boolean;
  /**
   * fleet-leader-frictions P-005 (the issue-family leg of listWorkItems' audit):
   * 'no-evidence' restricts to TERMINAL-state rows with no structured completion
   * record (`terminal_completion_ref IS NULL`). Composes with an explicit `state`.
   */
  audit?: 'no-evidence';
  /**
   * EI-10422: exclude a `payload.lane === 'observation'` row — a turn-end reflection /
   * rubric scorecard filed via `improvements:capture { lane:'observation' }` that, by
   * design (D-005), "never enters the work queue/triage/auto-implement — only Scout's
   * corpus-digest + the Observations pane read it". The self-select claim path
   * (claimNextIssueWorkItem, via observationLaneExclusionSql in work-items.ts) already
   * honors this; `listIssues`/`countIssues` did not, so 2,677 open observation notes
   * masqueraded as claimable `change` work in every backlog/triage read that goes
   * through `work_items:list`/`search`/`count` (EI-10422). Default false/omitted:
   * byte-identical to before (a caller that wants the raw issue store, unfiltered,
   * keeps seeing observations) — `listWorkItems`/`countWorkItems` pass this as `true`
   * by default (via `includeObservations`) so the GENERAL work-item surface excludes
   * them; a curation surface reads observations directly via
   * harness/improvements/read-items.ts, not this general path.
   */
  excludeObservationLane?: boolean;
}

/** Issue-family terminal states for the P-005 audit (subset of the cross-family set). */
const ISSUE_TERMINAL_STATES: readonly string[] = ['resolved', 'closed', 'deprecated', 'done'];

/**
 * WI-4405: the issue-family `admissibleOnly` floor set, extended past the original
 * federated-origin-only gate to also mirror the real self-select claim path's floors
 * (claimNextIssueWorkItem, work-items.ts) that a generic backlog read never applied —
 * the D-005 observation-lane note (observationLaneExclusionSql), a peer's explicit
 * claim-hold (claimHoldExclusionSql), a row `improvements:resolve` already routed to
 * a human (needsHumanExclusionSql), and a row reserved to an ACTIVELY-driven plan
 * lane / a live plan_item_claims lease (reservedPlanLaneExclusionSql). ROOT CAUSE of a
 * 3-member idle fleet (bug-drain-nonp2p, 2026-07-12): a leader fed a 3-item tranche
 * (EI-10375 observation-lane, WI-3868/WI-4147 plan-reserved) that `admissibleOnly:true`
 * reported as claimable — measured live: 41 rows with admissibleOnly, 41 without, i.e.
 * it filtered NOTHING for that tranche — while `scheduler:get_next` correctly refused
 * all three. "Admissible" now actually means "the claim path would let this be
 * claimed" instead of only "not federated".
 *
 * Deliberately does NOT attempt the readiness/blocking-dep floor, swarm-affinity, or
 * redundancy exclusion here — those need a live bee/claim context (assignee, swarmId)
 * a generic listing read doesn't have, and are lower-value for a "would anyone ever be
 * able to claim this" read than the four unconditional per-row floors above.
 *
 * `aliased` selects the unaliased (bare `engineer_issues` table) vs `ei.`-prefixed
 * (topic-joined subqueries) column form — every call site here uses one or the other.
 */
function issueAdmissibleWhereSql(sql: OrgSql, aliased: boolean) {
  return aliased
    ? sql`(
        (ei.origin = 'local' OR ei.origin IS NULL)
        AND COALESCE(ei.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
        AND COALESCE(ei.payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
        AND COALESCE(ei.payload, '{}'::jsonb) ->> 'needsHuman' IS DISTINCT FROM 'true'
        AND NOT (
          COALESCE(ei.payload, '{}'::jsonb) ? 'plan_item' AND (
            EXISTS (
              SELECT 1 FROM harness_shared.harness_plans hp
               WHERE hp.plan_slug = ei.payload->'plan_item'->>'plan_slug'
                 AND hp.status = 'active'
            )
            OR EXISTS (
              SELECT 1 FROM harness_shared.plan_item_claims pic
               WHERE pic.plan_slug = ei.payload->'plan_item'->>'plan_slug'
                 AND pic.item_id  = ei.payload->'plan_item'->>'item_id'
                 AND pic.expires_ts > now()
            )
          )
        )
      )`
    : sql`(
        (origin = 'local' OR origin IS NULL)
        AND COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
        AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
        AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' IS DISTINCT FROM 'true'
        AND NOT (
          COALESCE(payload, '{}'::jsonb) ? 'plan_item' AND (
            EXISTS (
              SELECT 1 FROM harness_shared.harness_plans hp
               WHERE hp.plan_slug = payload->'plan_item'->>'plan_slug'
                 AND hp.status = 'active'
            )
            OR EXISTS (
              SELECT 1 FROM harness_shared.plan_item_claims pic
               WHERE pic.plan_slug = payload->'plan_item'->>'plan_slug'
                 AND pic.item_id  = payload->'plan_item'->>'item_id'
                 AND pic.expires_ts > now()
            )
          )
        )
      )`;
}

export async function listIssues(filter: ListIssuesFilter = {}): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  // Topic filter resolves through the tag edges (coord_links) first.
  let idsFromTopic: string[] | null = null;
  if (filter.topic) {
    const tagged = await tags.listTagged(filter.topic);
    idsFromTopic = tagged.filter((o) => o.kind === ISSUE_KIND).map((o) => o.ref);
    if (idsFromTopic.length === 0) return [];
  }
  // Kind gate: an explicit single `kind`, else an explicit `kinds` set, else the
  // default = ISSUE_KINDS (bug|change) so `task` work-items never surface as issues.
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)}
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${filter.scope ? sql`scope = ${filter.scope}` : sql`TRUE`}
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${filter.severity ? sql`severity = ${filter.severity}` : sql`TRUE`}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${idsFromTopic ? sql`issue_id = ANY(${idsFromTopic})` : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit === 'no-evidence'
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND terminal_completion_ref IS NULL)`
           : sql`TRUE`
       }
       -- EI-10422: mirrors observationLaneExclusionSql (work-items.ts) — the self-select
       -- claim path already excludes a lane:'observation' row; this hoists the SAME
       -- floor into the general list read when the caller opts in (listWorkItems does,
       -- by default, via includeObservations).
       AND ${filter.excludeObservationLane ? sql`COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'` : sql`TRUE`}
     ORDER BY created_at DESC
     LIMIT ${Math.min(filter.limit ?? 100, ISSUES_MAX_LIMIT)}`;
  return rows.map(toIssue);
}

/**
 * COUNT companion to {@link listIssues} — the true total for the same filter,
 * minus order/limit. Lets a capped read render "N of TOTAL" instead of the
 * downloaded length. Topic-filtered counts use the indexed coord_links join
 * directly; re-listing every matching issue here made infinite feeds do twice
 * the payload work for every page-window growth.
 */
export async function countIssues(filter: ListIssuesFilter = {}): Promise<number> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  if (filter.topic) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(DISTINCT ei.issue_id)::int AS n
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${filter.scope ? sql`ei.scope = ${filter.scope}` : sql`TRUE`}
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${filter.severity ? sql`ei.severity = ${filter.severity}` : sql`TRUE`}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit === 'no-evidence'
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ei.terminal_completion_ref IS NULL)`
             : sql`TRUE`
         }
         AND ${filter.excludeObservationLane ? sql`COALESCE(ei.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'` : sql`TRUE`}`;
    return rows[0]?.n ?? 0;
  }
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${filter.scope ? sql`scope = ${filter.scope}` : sql`TRUE`}
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${filter.severity ? sql`severity = ${filter.severity}` : sql`TRUE`}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit === 'no-evidence'
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND terminal_completion_ref IS NULL)`
           : sql`TRUE`
       }
       AND ${filter.excludeObservationLane ? sql`COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'` : sql`TRUE`}`;
  return rows[0]?.n ?? 0;
}

/**
 * Count observations by kind — returns a map of kind → count for the observations
 * matching the filter. Used by the Observations panel to show signal distribution
 * with real database counts instead of loaded-list-length fallback (WI-4374).
 * Each NULL kind is mapped to 'other'.
 */
export async function countObservationsByKind(filter: ListIssuesFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const kindSet: readonly IssueStoreKind[] = filter.kind ? [filter.kind] : (filter.kinds ?? ISSUE_KINDS);
  if (filter.topic) {
    const rows = await sql<{ kind: string | null; count: number }[]>`
      SELECT (ei.payload->'observation'->>'kind')::text AS kind, count(*)::int AS count
        FROM harness_shared.engineer_issues ei
        JOIN harness_shared.coord_links cl
          ON cl.workspace_id = ${coordScopeWorkspace()}
         AND cl.rel = 'tagged'
         AND cl.src_kind = ${ISSUE_KIND}
         AND cl.src_ref = ei.issue_id
         AND cl.dst_kind = 'topic'
         AND cl.dst_ref = ${filter.topic}
       WHERE ei.workspace_id = ${issuesScopeWorkspace()}
         AND ei.kind = ANY(${kindSet as string[]}::text[])
         AND ${filter.state ? sql`ei.state = ${filter.state}` : sql`TRUE`}
         AND ${filter.scope ? sql`ei.scope = ${filter.scope}` : sql`TRUE`}
         AND ${filter.assignee ? sql`ei.assignee = ${filter.assignee}` : sql`TRUE`}
         AND ${filter.assignedBy ? sql`ei.assigned_by = ${filter.assignedBy}` : sql`TRUE`}
         AND ${filter.severity ? sql`ei.severity = ${filter.severity}` : sql`TRUE`}
         AND ${filter.signalOrigins ? sql`ei.signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
         AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, true) : sql`TRUE`}
         AND ${
           filter.audit === 'no-evidence'
             ? sql`(ei.state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND ei.terminal_completion_ref IS NULL)`
             : sql`TRUE`
         }
      GROUP BY kind`;
    const result: Record<string, number> = {};
    for (const row of rows) {
      const k = row.kind || 'other';
      result[k] = row.count;
    }
    return result;
  }
  const rows = await sql<{ kind: string | null; count: number }[]>`
    SELECT (payload->'observation'->>'kind')::text AS kind, count(*)::int AS count
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = ANY(${kindSet as string[]}::text[])
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${filter.scope ? sql`scope = ${filter.scope}` : sql`TRUE`}
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.assignedBy ? sql`assigned_by = ${filter.assignedBy}` : sql`TRUE`}
       AND ${filter.severity ? sql`severity = ${filter.severity}` : sql`TRUE`}
       AND ${filter.signalOrigins ? sql`signal_origin = ANY(${filter.signalOrigins as string[]}::text[])` : sql`TRUE`}
       AND ${filter.admissibleOnly ? issueAdmissibleWhereSql(sql, false) : sql`TRUE`}
       AND ${
         filter.audit === 'no-evidence'
           ? sql`(state = ANY(${ISSUE_TERMINAL_STATES as string[]}::text[]) AND terminal_completion_ref IS NULL)`
           : sql`TRUE`
       }
    GROUP BY kind`;
  const result: Record<string, number> = {};
  for (const row of rows) {
    const k = row.kind || 'other';
    result[k] = row.count;
  }
  return result;
}

export async function getIssue(id: string): Promise<EngineerIssue | null> {
  return getIssueInWorkspace(issuesScopeWorkspace(), id);
}

/**
 * Read one issue-family row scoped to an EXPLICIT workspace, bypassing the
 * `issuesScopeWorkspace()` re-derivation.
 *
 * EI-6480: the issue-claim path (`claimNextIssueWorkItem`) claims a row via an atomic
 * UPDATE that fixes the workspace to `issueWs = issuesScopeWorkspace()` captured ONCE,
 * then re-reads the claimed row to build its `WorkItem`. If that re-read calls the bare
 * `getIssue()` it re-derives `issuesScopeWorkspace()` a SECOND time — and that value can
 * drift between the two calls (the ISSUES_PER_WORKSPACE flag cache self-heals on a TTL,
 * so a mid-call refresh can flip `default` ⇄ the active workspace). A drift makes the
 * re-read miss the just-claimed row → `getIssue` returns null → the claim path returned
 * null while the row stayed `taken_by`-set: a LEAKED claim reported to the caller as a
 * spurious "ready but a peer raced you (retry)" miss. Re-reading in the SAME captured
 * workspace the row was claimed in removes that drift entirely.
 */
export async function getIssueInWorkspace(
  workspaceId: string,
  id: string,
  opts: { baseHarnessSlug?: string | null } = {},
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  // EI-7808: legacy/federated bugs left duplicate issue-family base rows with the
  // same (workspace_id, issue_id) but different physical harness_slug values (most
  // visibly '' beside operator:<workspace>). A caller that just claimed a specific
  // physical row must be able to re-read THAT row; otherwise this SELECT can return
  // a stale resolved twin and make a successful claim look terminal/no-op.
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId} AND issue_id = ${id}
       AND ${opts.baseHarnessSlug != null ? sql`base_harness_slug = ${opts.baseHarnessSlug}` : sql`TRUE`}`;
  return rows[0] ? toIssue(rows[0]) : null;
}

export async function getIssueDetail(id: string): Promise<EngineerIssueDetail | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const topics = await tags.listTags(issueRef(id));
  const thread = await threads.getThreadByParent(issueRef(id));
  const posts = thread ? await threads.listPosts(thread.thread_id) : [];
  const out = await links.listOut(issueRef(id));
  return {
    ...issue,
    topics,
    posts,
    links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })),
  };
}

export interface UpdateIssuePatch {
  title?: string;
  body?: string;
  severity?: IssueSeverity;
  /** Correct a mislabeled work-item kind (issue-surface kinds only — bug|change).
   *  The kind column is load-bearing post close-the-self-improvement-loop D-002
   *  (it picks the auto-implement lane), so mislabels must be fixable via the verb. */
  kind?: IssueKind;
  foundDuring?: string | null;
  linkedFeatureId?: string | null;
  by?: string;
  /** Skip the subscribe→inject fan-out (cosmetic edits like a generated title). */
  silent?: boolean;
  /** EI-8497: bypass the fat-finger body-shrink guard below — pass true when a large
   *  reduction in body length is genuinely intended (not a mis-call). */
  confirmShrink?: boolean;
}

/**
 * EI-8497 fat-finger guard: a mis-called `work_items:update` silently overwrote a
 * substantial description with a short placeholder body, and there was no revision
 * history to recover the prior text from. Rather than build full body versioning,
 * this stops the destructive class at the door: an edit that would replace a
 * substantial existing body with something far shorter is REJECTED (nothing is
 * written) unless the caller explicitly confirms it. Trips only when BOTH hold —
 * below either threshold a shrink reads as a plausible genuine simplification, not
 * a fat-finger:
 *   - the existing body is at least `BODY_SHRINK_GUARD_MIN_LENGTH` chars (a short
 *     body has little to lose), AND
 *   - the new body keeps less than `BODY_SHRINK_GUARD_RETAIN_RATIO` of that length.
 */
export const BODY_SHRINK_GUARD_MIN_LENGTH = 40;
export const BODY_SHRINK_GUARD_RETAIN_RATIO = 0.15;

export interface ShrinkGuardTripped {
  shrinkGuardTripped: true;
  field: 'body';
  existingLength: number;
  newLength: number;
}

/** Exported for a fast pure-function unit test (no DB) — see issues-engineer.body-shrink-guard.test.ts. */
export function bodyShrinkTripped(existingBody: string | undefined | null, newBody: string): ShrinkGuardTripped | null {
  if (!existingBody || existingBody.length < BODY_SHRINK_GUARD_MIN_LENGTH) return null;
  if (newBody.length >= existingBody.length * BODY_SHRINK_GUARD_RETAIN_RATIO) return null;
  return { shrinkGuardTripped: true, field: 'body', existingLength: existingBody.length, newLength: newBody.length };
}

export async function updateIssue(
  id: string,
  patch: UpdateIssuePatch,
): Promise<EngineerIssue | null | ShrinkGuardTripped> {
  const { sql } = getOrgPg();
  if (patch.body !== undefined && !patch.confirmShrink) {
    const existing = await getIssue(id);
    const tripped = existing ? bodyShrinkTripped(existing.body, patch.body) : null;
    if (tripped) return tripped;
  }
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET
      title = ${patch.title ?? sql`title`},
      body = ${patch.body ?? sql`body`},
      severity = ${patch.severity ?? sql`severity`},
      kind = ${patch.kind ?? sql`kind`},
      found_during = ${patch.foundDuring !== undefined ? patch.foundDuring : sql`found_during`},
      linked_feature_id = ${patch.linkedFeatureId !== undefined ? patch.linkedFeatureId : sql`linked_feature_id`},
      origin = 'local',
      updated_at = now()
    WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  if (!patch.silent) {
    await deliver(issue, 'updated', `issue ${id} updated: ${issue.title}`, patch.by ?? 'substrate');
  }
  return issue;
}

/** Claimable.claim — assign the issue. ATOMIC compare-and-claim (matches the
 *  feature-family path in work-items.ts claimWorkItem): the UPDATE only succeeds
 *  when the issue is UNCLAIMED or already held by THIS assignee (idempotent re-claim).
 *  A competing claim on an already-held issue gets null — exactly one agent wins,
 *  instead of a last-write-wins overwrite that silently stole a live grip. Stamps
 *  assigned_at: the implement lane's stale-claim reclaim (plan-implement.ts inFlight)
 *  ages claims off it — a claim without assigned_at reads as in-flight FOREVER and
 *  wedges the auto lane. */
export async function claimIssue(id: string, assignee: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET assignee = ${assignee}, assigned_at = now(), origin = 'local', updated_at = now()
     WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ${id}
       AND (assignee IS NULL OR assignee = '' OR assignee = ${assignee})
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  // The claimer follows the issue.
  await subs.subscribe({
    subscriber_id: assignee,
    target_kind: 'object',
    target_ref: `${ISSUE_KIND}:${id}`,
    delivery_mode: 'full',
    created_ts: nowIso(),
  });
  await deliver(issue, 'updated', `issue ${id} claimed by ${assignee}`, assignee);
  return issue;
}

/**
 * WI-2990/WI-3006: bump an issue-family (bug/change/task) row's `last_progress_at`
 * to now — the issue-family mirror of {@link ../work-items.markFeatureProgress}.
 *
 * Writes the BASE `harness_shared.work_items` table directly (not through the
 * `engineer_issues` compat view) so it can match by (workspace_id, feature_id)
 * alone — issue ids are globally unique, and matching this way sidesteps the
 * harness_slug encoding split (`<slug>` vs `operator:<workspace_id>`) that a
 * `markFeatureProgress`-style `harness_slug = <caller's harness>` match would
 * get wrong for an operator-scoped issue. Only a CLAIMED row is credited — an
 * unclaimed/terminal row matches 0 rows and is a harmless no-op (mirrors
 * markFeatureProgress's own guard). Fail-soft: swallows errors so a progress
 * bump can never break the caller's primary write (e.g. a checkpoint write).
 *
 * @returns true if a held issue-family row was bumped, false otherwise.
 */
export async function markIssueProgress(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const { sql } = getOrgPg();
    const res = await sql`
      UPDATE harness_shared.work_items
         SET last_progress_at = now()
       WHERE workspace_id = ${issuesScopeWorkspace()} AND feature_id = ${id}
         AND item_kind IN ('bug', 'change', 'task')
         AND taken_by IS NOT NULL AND taken_by <> ''`;
    return res.count > 0;
  } catch {
    return false;
  }
}

export async function releaseIssue(
  id: string,
  opts: { expectedAssignee?: string } = {},
): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const ws = issuesScopeWorkspace();
  // EI-6480: capture the prior assignee BEFORE clearing it, so we can clean up that owner's
  // stale per-Hive claim lease below — else the just-freed issue stays lease-poisoned (reads
  // unclaimed yet fails lease arbitration for every new claimer) until the lease TTL lapses.
  const prev = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE workspace_id = ${ws} AND issue_id = ${id}`;
  const formerAssignee = prev[0]?.assignee ?? null;
  // EI-7588: when `expectedAssignee` is given (the work_items:release TOOL's holder guard),
  // the UPDATE itself only touches the row when it is unclaimed OR already held by the
  // expected caller — atomic compare-and-release, no fetch-then-write race. A row held by
  // someone ELSE matches 0 rows and this returns null, same as "not found"; the caller
  // (release.ts) re-reads to tell the two apart and report an honest `not_holder` + holder.
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET assignee = NULL, assigned_at = NULL, origin = 'local', updated_at = now()
     WHERE workspace_id = ${ws} AND issue_id = ${id}
       AND (${opts.expectedAssignee ?? null}::text IS NULL OR assignee IS NULL OR assignee = ${opts.expectedAssignee ?? null})
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  // EI-6480: harness-agnostic (issue ids are globally unique), flag-gated, best-effort lease
  // cleanup so the released issue is IMMEDIATELY re-claimable, not lease-poisoned until TTL.
  // Covers every voluntary release path (work_items:release + the improvement resolve-core
  // paths) and every scope (operator-scope issues, whose bare harness releaseWorkItem can't
  // recover, are the confirmed-failing case). Dynamic import avoids a static cycle.
  if (formerAssignee) {
    // Workspace defaults to activeWorkspaceId() inside releaseIssueClaimLease — the workspace
    // leaseClaimedWorkItem keyed the lease under at acquire (which is NOT necessarily the
    // issue's scope-workspace `ws`); passing `ws` here would miss the lease if they diverge.
    void import('./work-item-claim-lease-wiring')
      .then((m) => m.releaseIssueClaimLease({ workItemId: id, owner: formerAssignee }))
      .catch(() => {});
  }
  await deliver(issue, 'updated', `issue ${id} released (unassigned)`);
  return issue;
}

/**
 * Lifecycle.setState — close/resolve/reopen the issue.
 *
 * Completion-integrity gate (work-item-completion-integrity-2026-07-01 WI-1403):
 * a transition INTO a terminal state (resolved|closed, per ISSUE_TERMINAL_STATUSES)
 * must carry both `by` (the claiming principal) and `completionRef` (a completion
 * summary / commit / coord / plan-item reference — any non-empty evidence string).
 * Reject otherwise, so a bare/anonymous flip — e.g. a watchdog dedup marker — can
 * never masquerade as a genuine completion. `opts.skipCompletionGate` is a narrow,
 * explicit bypass for TRUSTED internal restore paths (e.g. the autonomy tripwire
 * reverting to a captured prior state) that are not completions at all.
 */
export async function setIssueState(
  id: string,
  state: IssueState,
  by?: string,
  completionRef?: string,
  opts: { completionEvidence?: CompletionVerificationEvidence; skipCompletionGate?: boolean } = {},
): Promise<EngineerIssue | null> {
  const isTerminal = ISSUE_TERMINAL_STATUSES.has(state);
  if (isTerminal && !opts.skipCompletionGate) {
    if (!by || !by.trim()) {
      throw new Error(
        `completion-integrity: issue '${id}' → '${state}' rejected — a terminal transition requires an owner (by)`,
      );
    }
    if (!completionRef || !completionRef.trim()) {
      // EI-7119: a bare rejection here sent callers on a 3-call round-trip (complete
      // without state → set_state without completionRef → rejected → re-complete with
      // both). Name the actual fix inline so the FIRST rejection is the last one.
      throw new Error(
        `completion-integrity: issue '${id}' → '${state}' rejected — a terminal transition requires a completionRef. ` +
          `Pass one directly (set_state { id, state, completionRef: "..." }), or prefer ` +
          `work_items:complete { id, state: "${state}", completion: { summary: "..." } } which supplies it ` +
          `from completion.summary automatically — a prior work_items:complete WITHOUT \`state\` does NOT persist ` +
          `anything this call can reuse, so re-call complete with both, not set_state alone.`,
      );
    }
  }
  const { sql } = getOrgPg();
  const evidencePayloadJson = completionEvidencePayloadJson(opts.completionEvidence);
  const rows = isTerminal
    ? await sql<IssueRowDb[]>`
        UPDATE harness_shared.engineer_issues
           SET state = ${state}, origin = 'local', updated_at = now(),
               assignee = NULL, assigned_at = NULL,
               terminal_owner = ${by ?? null}, terminal_completion_ref = ${completionRef ?? null},
               payload = CASE WHEN ${evidencePayloadJson}::text::jsonb IS NULL
                              THEN payload
                              ELSE jsonb_strip_nulls(COALESCE(payload, '{}'::jsonb) || ${evidencePayloadJson}::text::jsonb)
                         END
         WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ${id}
        RETURNING ${sql.unsafe(ISSUE_COLS)}`
    : await sql<IssueRowDb[]>`
        UPDATE harness_shared.engineer_issues SET state = ${state}, origin = 'local', updated_at = now()
         WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ${id}
        RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  const resolved = state === 'resolved' || state === 'closed';
  await deliver(issue, resolved ? 'resolved' : 'updated', `issue ${id} → ${state}: ${issue.title}`, by ?? 'substrate');
  return issue;
}

/**
 * HARD-delete issues by id, with the coupled coordination edges (tags/links,
 * thread + posts, subscriptions) so no orphaned coord_* rows are left to grow.
 * No FK references engineer_issues (migration 131), and the coord_* tables key
 * the issue only by its string ObjectRef (`issue:<id>`), so a plain row delete is
 * clean — this helper just sweeps those by-ref edges in the same pass.
 *
 * This is a TRUE deletion, NOT the lifecycle close (`setIssueState(...'closed')`)
 * — it is for DISPOSABLE rows whose recall value has expired (the observation-lane
 * retention sweep, turn-end-reflection-observations-2026-06-14 P-045). Do NOT use
 * it on improvement-lane items: those close through the reject route so the
 * recurrence matcher can recall "already decided" on a re-capture.
 *
 * Returns the count of engineer_issues rows actually removed. No fan-out — a
 * deleted disposable signal has no subscribers to notify.
 */
export async function deleteIssues(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { sql } = getOrgPg();
  const idList = ids as string[];
  const refs = idList.map((id) => `${ISSUE_KIND}:${id}`);
  // Sweep the coordination edges first (they reference the issue only by string
  // ref, so the order is cosmetic — but deleting edges before the row keeps a
  // reader from seeing a dangling row mid-sweep). thread_ids are deterministic
  // (`issue-thread-<id>`), so posts + threads delete by id without a join.
  const threadIds = idList.map((id) => threadId(id));
  await sql`
    DELETE FROM harness_shared.coord_links
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND ((src_kind = ${ISSUE_KIND} AND src_ref = ANY(${idList}))
         OR (dst_kind = ${ISSUE_KIND} AND dst_ref = ANY(${idList})))`;
  await sql`
    DELETE FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${issuesScopeWorkspace()} AND thread_id = ANY(${threadIds})`;
  await sql`
    DELETE FROM harness_shared.coord_threads
     WHERE workspace_id = ${issuesScopeWorkspace()} AND thread_id = ANY(${threadIds})`;
  await sql`
    DELETE FROM harness_shared.coord_entity_subscriptions
     WHERE workspace_id = ${issuesScopeWorkspace()} AND target_kind = 'object' AND target_ref = ANY(${refs})`;
  const deleted = await sql`
    DELETE FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ANY(${idList})`;
  return deleted.count ?? 0;
}

/** A row's id + age — the minimal shape a retention/cap sweep needs (no body). */
export interface IssueAgeRow {
  id: string;
  createdAt: string;
}

/**
 * List EVERY issue tagged `topic` (all states + all origins), newest-first, as a
 * minimal id+createdAt projection — UNCAPPED, unlike `listIssues` (which clamps to
 * 500 for the interactive surfaces). A retention/row-cap sweep must see the whole
 * lane to decide what is beyond a hard cap, so it reads here, not through
 * `listIssues`. Loads no body/payload — id + created_at only, joined to the topic
 * tag edge (coord_links, rel='tagged'). (P-045.)
 */
export async function listIssueAgesByTopic(topic: string): Promise<IssueAgeRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ issue_id: string; created_at: unknown }[]>`
    SELECT ei.issue_id, ei.created_at
      FROM harness_shared.engineer_issues ei
      JOIN harness_shared.coord_links cl
        ON cl.workspace_id = ${coordScopeWorkspace()}
       AND cl.rel = 'tagged'
       AND cl.src_kind = ${ISSUE_KIND}
       AND cl.src_ref = ei.issue_id
       AND cl.dst_kind = 'topic'
       AND cl.dst_ref = ${topic}
     WHERE ei.workspace_id = ${issuesScopeWorkspace()}
     ORDER BY ei.created_at DESC`;
  return rows.map((r) => ({ id: r.issue_id, createdAt: tsIso(r.created_at) }));
}

/**
 * Shallow-merge keys into the issue's kind-specific `payload` jsonb (NULL payload
 * treated as `{}`). Silent — no fan-out (payload is loop bookkeeping, e.g. the
 * self-improvement `implementAttempts` / `needsHuman` / `paths` keys, not a
 * subscriber-visible mutation). Set a key to null to store an explicit null.
 */
export async function mergeIssuePayload(id: string, patch: Record<string, unknown>): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues
       SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb,
           origin = 'local',
           updated_at = now()
     WHERE workspace_id = ${issuesScopeWorkspace()} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  return rows[0] ? toIssue(rows[0]) : null;
}

/** Threadable.addPost — comment on the issue (creates the thread on first post). */
export async function commentIssue(id: string, body: string, authorId?: string): Promise<ThreadPostRow | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const created = nowIso();
  // The durable write (get-or-create thread + add post) runs in ONE bounded txn
  // (pg-bounded-txn): ATOMIC so the post row + the coord_threads post_count bump
  // commit together (no half-write a retry would duplicate), and BOUNDED by a
  // SET LOCAL statement_timeout so a stalled query fails fast + typed instead of
  // hanging the MCP call indefinitely (the admin pool has no default
  // statement_timeout). A tx-bound PgThreadStore reuses the exact tested store SQL.
  const post = await boundedOrgTxn(async (tx) => {
    const txThreads = new PgThreadStore({ ...coordOpts, getSql: () => tx });
    const thread = await txThreads.getOrCreateThread(issueRef(id), {
      thread_id: threadId(id),
      title: issue.title,
      created_by: issue.createdBy ?? undefined,
      created_ts: issue.createdAt,
    });
    return txThreads.addPost({ thread_id: thread.thread_id, author_id: authorId, body, created_ts: created });
  });
  // Fan-out is best-effort + deadline-bounded (fanoutForObject) — it runs AFTER the
  // durable write commits and can never hang or roll back the caller's comment.
  await deliver(
    issue,
    'commented',
    `issue ${id} — new comment${authorId ? ` from ${authorId}` : ''}`,
    authorId ?? 'substrate',
  );
  return post;
}

/** Taggable.addTag / removeTag. */
export async function tagIssue(id: string, topic: string, by?: string): Promise<void> {
  await tags.addTag(issueRef(id), topic, { created_by: by, created_ts: nowIso() });
}
export async function untagIssue(id: string, topic: string): Promise<void> {
  await tags.removeTag(issueRef(id), topic);
}

/** Subscribable.subscribe / unsubscribe to the issue object. */
export async function subscribeIssue(subscriberId: string, id: string, mode: DeliveryMode = 'full'): Promise<void> {
  await subs.subscribe({
    subscriber_id: subscriberId,
    target_kind: 'object',
    target_ref: `${ISSUE_KIND}:${id}`,
    delivery_mode: mode,
    created_ts: nowIso(),
  });
}
export async function unsubscribeIssue(subscriberId: string, id: string): Promise<void> {
  await subs.unsubscribe(subscriberId, 'object', `${ISSUE_KIND}:${id}`);
}

/** Linkable.link — an issue→target edge (rel 'blocks' | 'relates' | 'duplicates' | …). Phase 2. */
export async function linkIssue(id: string, dst: ObjectRef, rel: string, by?: string): Promise<void> {
  await links.link(issueRef(id), dst, rel, { created_by: by, created_ts: nowIso() });
}
export async function unlinkIssue(id: string, dst: ObjectRef, rel: string): Promise<void> {
  await links.unlink(issueRef(id), dst, rel);
}

/** One outbound edge from an issue, as {@link issuesOutLinksMany} returns it. */
export interface IssueOutLink {
  rel: string;
  dst: ObjectRef;
}

/**
 * Bulk outbound-link read over many issues in ONE batched query (no N+1) —
 * WI-3594 (scorecard→improvement flow): ScorecardDetail needs each scorecard's
 * linked follow-up items, and a per-row `links.listOut` call would be an N+1
 * over a scorecard list. Excludes `tagged` (topic tags are not references,
 * same convention as {@link issueLinkCounts}'s inboundRefs). Every requested id
 * gets an entry (empty array when unlinked).
 */
export async function issuesOutLinksMany(ids: readonly string[]): Promise<Map<string, IssueOutLink[]>> {
  const out = new Map<string, IssueOutLink[]>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, []);
  const rows = await links.listOutMany(ids.map(issueRef));
  for (const r of rows) {
    if (r.rel === 'tagged') continue;
    out.get(r.src.ref)?.push({ rel: r.rel, dst: r.dst });
  }
  return out;
}

/** Link-degree of one issue, as the blocking-impact ranking reads it
 *  (self-improvement-consume-edges-2026-06-12 P-022). */
export interface IssueLinkCounts {
  /** Outbound `blocks` edges — downstream things THIS issue blocks. */
  blocksOut: number;
  /** Inbound edges from other objects referencing this issue. Excludes `tagged`
   *  (topics are not references) and inbound `blocks` (an upstream dependency —
   *  something blocking THIS issue is not downstream impact). */
  inboundRefs: number;
}

/** Bulk link-degree read over many issues in two batched queries (no N+1).
 *  Every requested id gets an entry (zero counts when unlinked). */
export async function issueLinkCounts(ids: readonly string[]): Promise<Map<string, IssueLinkCounts>> {
  const out = new Map<string, IssueLinkCounts>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { blocksOut: 0, inboundRefs: 0 });
  const refs = ids.map(issueRef);
  const [outRows, inRows] = await Promise.all([links.listOutMany(refs, { rel: 'blocks' }), links.listInMany(refs)]);
  for (const r of outRows) {
    const c = out.get(r.src.ref);
    if (c) c.blocksOut += 1;
  }
  for (const r of inRows) {
    if (r.rel === 'tagged' || r.rel === 'blocks') continue;
    const c = out.get(r.dst.ref);
    if (c) c.inboundRefs += 1;
  }
  return out;
}

export interface PromoteResult {
  issue: EngineerIssue;
  feature: { id: string; title: string };
}

/**
 * issues:promote — mint an F-FIX feature from this issue (reusing the pipeline's
 * mintFixFeatureRow) and link it. Harness-scoped issues mint into their harness;
 * an operator-scope issue must name a target harness. The issue stays open (it
 * resolves when the feature lands); the linked feature is recorded + a note added.
 */
export async function promoteIssue(
  id: string,
  opts: { harness?: string; actor?: string } = {},
): Promise<PromoteResult | { error: string }> {
  const issue = await getIssue(id);
  if (!issue) return { error: 'issue not found' };
  if (issue.linkedFeatureId) return { error: `already promoted to ${issue.linkedFeatureId}` };

  const harness = opts.harness ?? (issue.scope.startsWith('harness:') ? issue.scope.slice('harness:'.length) : null);
  if (!harness) return { error: 'operator-scope issue needs a target harness — pass { harness }' };
  const project = await resolveProject(harness);
  if (!project) return { error: `unknown harness '${harness}'` };

  const pipelineIssue: PipelineIssue = {
    id: issue.id,
    title: issue.title,
    severity: issue.severity,
    source: 'system',
    foundAt: issue.createdAt,
    foundDuring: issue.foundDuring ?? undefined,
    status: 'open',
    evidence: issue.body || undefined,
    attempts: 0,
    notes: [],
  };
  const feature = await mintFixFeatureRow(project, pipelineIssue, { actor: opts.actor ?? 'issue-promote' });

  const updated = await updateIssue(id, { linkedFeatureId: feature.id, by: opts.actor });
  await commentIssue(id, `Promoted to ${feature.id} in harness ${harness}.`, opts.actor);
  const promotedIssue = updated && 'shrinkGuardTripped' in updated ? issue : (updated ?? issue);
  return { issue: promotedIssue, feature: { id: feature.id, title: feature.title } };
}

/**
 * Find the open delegated-task (kind=task) work-item carrying this delegate
 * session id in its payload (collapse-delegate D-001). Used by the historical delegate
 * resume path to re-attach a follow-up turn to its existing work-item.
 */
export async function findTaskBySessionId(agentSessionId: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND kind = 'task' AND state = 'open'
       AND payload ->> 'agentSessionId' = ${agentSessionId}
     ORDER BY created_at DESC
     LIMIT 1`;
  return rows[0] ? toIssue(rows[0]) : null;
}

/**
 * Full-text search over the issue store. Scoping note (watchdog-audit-2026-06-09
 * P-013): the DEFAULT_COORD_WORKSPACE filter here is BY DESIGN, not a bug — every
 * write path (createIssue) stores into that single coord workspace (see the
 * capability-stores comment above: engineer_issues' workspace_id is a domain
 * column; the coordination layer runs in the one coord workspace). Searching the
 * same constant the writes use keeps dedup consistent. If the store ever becomes
 * genuinely multi-workspace, the WRITE path must change first and this follows.
 */
export async function searchIssues(query: string, limit = 50): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND _search @@ websearch_to_tsquery('english', ${query})
     ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
     LIMIT ${Math.min(limit, 200)}`;
  return rows.map(toIssue);
}

/**
 * WI-4308 interim mitigation: the SAME lexical search as `searchIssues`, widened
 * to ALSO match rows still sitting under the legacy DEFAULT_COORD_WORKSPACE
 * (see `dedupScopeWorkspaces`'s doc). For DEDUP READS ONLY — wired into
 * capture-core.ts's search-first pass so a fresh capture can find (and decline
 * to re-duplicate) a still-open pre-flip twin. Deliberately a SEPARATE function
 * rather than widening `searchIssues` in place: `searchIssues` also backs the
 * general, caller-visible `work_items:search` tool (via work-items.ts), which
 * must NOT start surfacing the pre-flip backlog to ordinary listing/search.
 */
export async function searchIssuesForDedup(query: string, limit = 50): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ANY(${dedupScopeWorkspaces()}::text[])
       AND _search @@ websearch_to_tsquery('english', ${query})
     ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
     LIMIT ${Math.min(limit, 200)}`;
  return rows.map(toIssue);
}

/**
 * Semantic (cosine top-k) search over the issue store — the P-008 leg
 * (shared-embedding-sidecar-and-enrichment-2026-07-10) work_items:search
 * merges with the lexical hits above. `mode` is the ACTIVE embedder mode the
 * query vector was produced in: rows are filtered `embedding_mode = mode`
 * (migration 551's space discriminator) so a stored vector from a different
 * embedder is never ranked against — cosine across spaces is noise, not a
 * weaker match (embedding-space-vs-dimension).
 *
 * The embedding columns live on the BASE table harness_shared.work_items
 * (engineer_issues is a hand-mapped compat view since migration 374 and does
 * NOT expose them) — so rank there, restricted to issue-family kinds, then
 * hydrate the issue shape through the view preserving distance order. Same
 * workspace scoping as searchIssues. Throws when migration 551 (or pgvector)
 * is absent — callers fail open to lexical-only.
 */
export async function semanticSearchIssues(vec: number[], mode: string, limit = 20): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  const hits = await sql<Array<{ id: string }>>`
    SELECT feature_id AS id
      FROM harness_shared.work_items
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND item_kind IN ('bug', 'change', 'task')
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${Math.min(limit, 200)}`;
  if (hits.length === 0) return [];
  const ids = hits.map((r) => r.id);
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND issue_id = ANY(${ids}::text[])`;
  const rank = new Map(ids.map((id, i) => [id, i]));
  return rows.map(toIssue).sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}

/**
 * Watchdog-key dedup feed (watchdog-audit-2026-06-09 P-004 / D-001): every issue
 * carrying one of the given `payload.watchdogKey` values — ONE indexed query
 * (engineer_issues_watchdog_key_idx, migration 207). The improvement watchdog
 * pre-filters its collected signals against this BEFORE planning captures, so a
 * standing already-filed signal never consumes the per-tick capture budget.
 *
 * WI-4308 interim mitigation: scoped via `dedupScopeWorkspaces()` (not a bare
 * `issuesScopeWorkspace()`) so a still-open watchdogKey match filed under the
 * legacy DEFAULT_COORD_WORKSPACE is found too — every caller of this function
 * (the improvement watchdog, scorecard-emission-pulse, overwatch's
 * scorecard-backstop, known-open-aging's coalescing sweep, p2p-perf-actions,
 * the calibration resolve-sweep) is itself a dedup/aging/coalescing consumer,
 * never a general caller-visible listing — so widening here is safe by the
 * same reasoning as `searchIssuesForDedup` above.
 */
export async function findIssuesByWatchdogKeys(keys: string[]): Promise<EngineerIssue[]> {
  if (keys.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ANY(${dedupScopeWorkspaces()}::text[])
       AND payload ? 'watchdogKey'
       AND payload->>'watchdogKey' = ANY(${keys}::text[])
     ORDER BY updated_at DESC`;
  return rows.map(toIssue);
}
