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
import {
  PgTaggableStore,
  PgThreadStore,
  PgEntitySubscriptionStore,
  PgLinkStore,
  PgTopicStore,
  resolveObjectSubscribers,
  type ObjectRef,
  type DeliveryMode,
  type ThreadPostRow,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { deliverInjectMany, type InjectEvent } from '@/lib/agent-tools/coordination/fanout-delivery';
import { resolveProject } from '@/lib/harness-core';
import { mintFixFeatureRow } from '@/lib/promote-issue';
import type { Issue as PipelineIssue } from '@/app/harness/issues/types';

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type IssueSource = 'engineer' | 'su';
export type IssueState = 'open' | 'resolved' | 'closed';

export const ISSUE_KIND = 'issue';
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['critical', 'major', 'minor', 'nit'];
export const ISSUE_STATES: readonly IssueState[] = ['open', 'resolved', 'closed'];

export interface EngineerIssue {
  id: string;
  scope: string; // 'operator' | 'harness:<slug>'
  title: string;
  body: string;
  severity: IssueSeverity;
  source: IssueSource;
  state: IssueState;
  assignee: string | null;
  foundDuring: string | null;
  linkedFeatureId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EngineerIssueDetail extends EngineerIssue {
  topics: string[];
  posts: ThreadPostRow[];
  /** Edges OUT of this issue (e.g. blocks → plan_item|feature). */
  links: { rel: string; dst: ObjectRef }[];
}

// ── Capability stores (the coordination layer runs in the single coord workspace
//    DEFAULT_COORD_WORKSPACE; SU broadcasts via '*' there). engineer_issues' own
//    workspace_id is a domain column; issue ids are global so the ObjectRef is
//    unambiguous across domain workspaces. ──────────────────────────────────────
const coordOpts = { getSql: () => getOrgPg().sql, ensureSchema: async () => {}, workspaceId: DEFAULT_COORD_WORKSPACE };
const tags = new PgTaggableStore(coordOpts);
const threads = new PgThreadStore(coordOpts);
const subs = new PgEntitySubscriptionStore(coordOpts);
const links = new PgLinkStore(coordOpts);
const topics = new PgTopicStore(coordOpts);

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
  scope: string;
  title: string;
  body: string;
  severity: string;
  source: string;
  state: string;
  assignee: string | null;
  found_during: string | null;
  linked_feature_id: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}
function tsIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function toIssue(r: IssueRowDb): EngineerIssue {
  return {
    id: r.issue_id,
    scope: r.scope,
    title: r.title,
    body: r.body,
    severity: r.severity as IssueSeverity,
    source: r.source as IssueSource,
    state: r.state as IssueState,
    assignee: r.assignee,
    foundDuring: r.found_during,
    linkedFeatureId: r.linked_feature_id,
    createdBy: r.created_by,
    createdAt: tsIso(r.created_at),
    updatedAt: tsIso(r.updated_at),
  };
}

const ISSUE_COLS = `issue_id, scope, title, body, severity, source, state, assignee,
  found_during, linked_feature_id, created_by, created_at, updated_at`;

/** Allocate the next globally-unique EI-<n> id. */
async function nextIssueId(): Promise<string> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: number }[]>`
    SELECT COALESCE(MAX((substring(issue_id from 4))::int), 0) AS n
      FROM harness_shared.engineer_issues
     WHERE issue_id ~ '^EI-[0-9]+$'`;
  return `EI-${(Number(rows[0]?.n) || 0) + 1}`;
}

async function deliver(issue: EngineerIssue, op: 'created' | 'updated' | 'commented' | 'resolved', summary: string, actor = 'substrate'): Promise<number> {
  // Resolve the issue's subscribers (direct ∪ topic) and exclude the actor, so an
  // agent is never notified of its own action (matches the conversations fan-out).
  const subscribers = (
    await resolveObjectSubscribers(issueRef(issue.id), { subscriptions: subs, tags, topics })
  ).filter((s) => s.subscriber_id !== actor);
  if (subscribers.length === 0) return 0;
  const ev: InjectEvent = {
    from: actor,
    subject: `${ISSUE_KIND}:${issue.id}`,
    summary,
    notify_kind:
      op === 'resolved' ? 'issue_resolved' : op === 'commented' ? 'issue_commented' : op === 'created' ? 'issue_created' : 'issue_updated',
    isResolution: op === 'resolved',
  };
  return deliverInjectMany(subscribers, ev);
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
}

/** Create an issue: insert, tag topics, auto-subscribe the author, fan out. */
export async function createIssue(input: CreateIssueInput): Promise<EngineerIssue> {
  const { sql } = getOrgPg();
  const id = await nextIssueId();
  const created = nowIso();
  const rows = await sql<IssueRowDb[]>`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, severity, source, state, found_during, created_by, created_at, updated_at)
    VALUES (${DEFAULT_COORD_WORKSPACE}, ${id}, ${input.scope ?? 'operator'}, ${input.title}, ${input.body ?? ''},
            ${input.severity ?? 'minor'}, ${input.source ?? 'engineer'}, 'open', ${input.foundDuring ?? null},
            ${input.createdBy ?? null}, ${created}, ${created})
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  const issue = toIssue(rows[0]);

  for (const topic of input.topics ?? []) {
    await tags.addTag(issueRef(id), topic, { created_by: input.createdBy, created_ts: created });
  }
  // Deliver to topic subscribers BEFORE the author subscribes, so the author is
  // not notified of their own filing (but is subscribed for future updates).
  await deliver(issue, 'created', `issue ${id} filed (${issue.severity}): ${issue.title}`, input.createdBy ?? 'substrate');
  if (input.createdBy) {
    await subs.subscribe({ subscriber_id: input.createdBy, target_kind: 'object', target_ref: `${ISSUE_KIND}:${id}`, delivery_mode: 'full', created_ts: created });
  }
  return issue;
}

export interface ListIssuesFilter {
  state?: IssueState;
  scope?: string;
  assignee?: string;
  severity?: IssueSeverity;
  topic?: string; // issues tagged with this topic
  limit?: number;
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
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)}
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND ${filter.state ? sql`state = ${filter.state}` : sql`TRUE`}
       AND ${filter.scope ? sql`scope = ${filter.scope}` : sql`TRUE`}
       AND ${filter.assignee ? sql`assignee = ${filter.assignee}` : sql`TRUE`}
       AND ${filter.severity ? sql`severity = ${filter.severity}` : sql`TRUE`}
       AND ${idsFromTopic ? sql`issue_id = ANY(${idsFromTopic})` : sql`TRUE`}
     ORDER BY created_at DESC
     LIMIT ${Math.min(filter.limit ?? 100, 500)}`;
  return rows.map(toIssue);
}

export async function getIssue(id: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND issue_id = ${id}`;
  return rows[0] ? toIssue(rows[0]) : null;
}

export async function getIssueDetail(id: string): Promise<EngineerIssueDetail | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const topics = await tags.listTags(issueRef(id));
  const thread = await threads.getThreadByParent(issueRef(id));
  const posts = thread ? await threads.listPosts(thread.thread_id) : [];
  const out = await links.listOut(issueRef(id));
  return { ...issue, topics, posts, links: out.filter((l) => l.rel !== 'tagged').map((l) => ({ rel: l.rel, dst: l.dst })) };
}

export interface UpdateIssuePatch {
  title?: string;
  body?: string;
  severity?: IssueSeverity;
  foundDuring?: string | null;
  linkedFeatureId?: string | null;
  by?: string;
}

export async function updateIssue(id: string, patch: UpdateIssuePatch): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET
      title = ${patch.title ?? sql`title`},
      body = ${patch.body ?? sql`body`},
      severity = ${patch.severity ?? sql`severity`},
      found_during = ${patch.foundDuring !== undefined ? patch.foundDuring : sql`found_during`},
      linked_feature_id = ${patch.linkedFeatureId !== undefined ? patch.linkedFeatureId : sql`linked_feature_id`}
    WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  await deliver(issue, 'updated', `issue ${id} updated: ${issue.title}`, patch.by ?? 'substrate');
  return issue;
}

/** Claimable.claim — assign the issue. */
export async function claimIssue(id: string, assignee: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET assignee = ${assignee}
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  // The claimer follows the issue.
  await subs.subscribe({ subscriber_id: assignee, target_kind: 'object', target_ref: `${ISSUE_KIND}:${id}`, delivery_mode: 'full', created_ts: nowIso() });
  await deliver(issue, 'updated', `issue ${id} claimed by ${assignee}`, assignee);
  return issue;
}

export async function releaseIssue(id: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET assignee = NULL
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  await deliver(issue, 'updated', `issue ${id} released (unassigned)`);
  return issue;
}

/** Lifecycle.setState — close/resolve/reopen the issue. */
export async function setIssueState(id: string, state: IssueState, by?: string): Promise<EngineerIssue | null> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    UPDATE harness_shared.engineer_issues SET state = ${state}
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND issue_id = ${id}
    RETURNING ${sql.unsafe(ISSUE_COLS)}`;
  if (!rows[0]) return null;
  const issue = toIssue(rows[0]);
  const resolved = state === 'resolved' || state === 'closed';
  await deliver(issue, resolved ? 'resolved' : 'updated', `issue ${id} → ${state}: ${issue.title}`, by ?? 'substrate');
  return issue;
}

/** Threadable.addPost — comment on the issue (creates the thread on first post). */
export async function commentIssue(id: string, body: string, authorId?: string): Promise<ThreadPostRow | null> {
  const issue = await getIssue(id);
  if (!issue) return null;
  const created = nowIso();
  const thread = await threads.getOrCreateThread(issueRef(id), { thread_id: threadId(id), title: issue.title, created_by: issue.createdBy ?? undefined, created_ts: issue.createdAt });
  const post = await threads.addPost({ thread_id: thread.thread_id, author_id: authorId, body, created_ts: created });
  await deliver(issue, 'commented', `issue ${id} — new comment${authorId ? ` from ${authorId}` : ''}`, authorId ?? 'substrate');
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
  await subs.subscribe({ subscriber_id: subscriberId, target_kind: 'object', target_ref: `${ISSUE_KIND}:${id}`, delivery_mode: mode, created_ts: nowIso() });
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

  const harness =
    opts.harness ?? (issue.scope.startsWith('harness:') ? issue.scope.slice('harness:'.length) : null);
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
  return { issue: updated ?? issue, feature: { id: feature.id, title: feature.title } };
}

export async function searchIssues(query: string, limit = 50): Promise<EngineerIssue[]> {
  const { sql } = getOrgPg();
  const rows = await sql<IssueRowDb[]>`
    SELECT ${sql.unsafe(ISSUE_COLS)} FROM harness_shared.engineer_issues
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND _search @@ websearch_to_tsquery('english', ${query})
     ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
     LIMIT ${Math.min(limit, 200)}`;
  return rows.map(toIssue);
}
