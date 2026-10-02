/**
 * GitHub Issues ticket connector (plan enterprise-data-sources-2026-10-01 P-019, D-025).
 *
 * GitHub Issues is the first source of the canonical ticket vocabulary (migration 1332).
 * Each provider object maps onto exactly one datatype, so each has exactly one nature (D-001):
 *   - an issue           -> `ticket` (record): a work_items row tagged nature='record' (D-011).
 *                           Never agent work, never claimable.
 *   - an issue comment   -> `ticket-comment` (document): one row in the documents corpus (D-005),
 *                           routed by the source's scope through corpusRouteFor.
 *   - open/close/reopen  -> `ticket-status-change` (event): a work_items row tagged nature='event'.
 * Pull requests come back from the same Issues API. They are skipped, and so are their comments
 * and events, because a pull request is not a ticket.
 *
 * Every write is idempotent. Ticket and status-change rows get DETERMINISTIC ids derived from
 * (workspace, data source, provider object), so a re-poll, a crash replay or two concurrent polls
 * converge on one row: a ticket that already exists has its payload merged, a status change that
 * already exists is left alone. Comment documents upsert on a dedupe key.
 *
 * Routing obeys the source row: a datatype is written only when destination_policy routes it to
 * its nature. A source with no `ticket -> record` route writes no tickets. Missing registry rows
 * fail closed (`ticket_datatype_unregistered:*`), because createWorkItem would otherwise mint
 * the kind as claimable agent work.
 *
 * Credential: the GitHub client defaults to the operator's own gh identity (getOctokit, the same
 * client the PR host poller uses, external-triggers-gmail-slack-2026-08-22#D-006). Organization
 * documents are read through the repository's permission list (source 'github', source_ref
 * `owner/repo`); `syncGitHubRepoMembership` fills it from the repository's collaborators. Until it
 * runs the list is empty, so nobody can read the comments (fail closed).
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOctokit } from '../identity/octokit-client';
import { getDatatype } from '../datatype-registry-store';
import { validateDatatypePayload } from '../datatype-payload-validation';
import {
  createWorkItem as defaultCreateWorkItem,
  mergeWorkItemPayload as defaultMergeWorkItemPayload,
  type CreateWorkItemInput,
} from '../work-items';
import {
  type ExternalTriggerSourceRow,
  updateExternalTriggerSourceSyncState,
  upsertOwnedExternalTriggerSource,
} from '../external-triggers/source-store';
import { corpusRouteFor, ensurePermissionList, writeCorpusDocument } from './chat-retrieval-units';
import { replacePermissionListMembers } from './documents-corpus';

export const GITHUB_ISSUES_PROVIDER = 'github';
export const TICKET_DATATYPE = 'ticket';
export const TICKET_COMMENT_DATATYPE = 'ticket-comment';
export const TICKET_STATUS_CHANGE_DATATYPE = 'ticket-status-change';
/** GitHub's maximum page size for the Issues list endpoints. */
export const GITHUB_ISSUES_PAGE = 100;
/** Pages read per list per poll step, so one step stays bounded on a large repository. */
export const GITHUB_ISSUES_MAX_PAGES = 5;
/** The identity work_items rows are created under. */
export const GITHUB_ISSUES_CREATED_BY = 'data-source:github-issues';

export interface GitHubUser { login?: string | null; id?: number | null }
export interface GitHubIssue {
  id?: number;
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  state_reason?: string | null;
  user?: GitHubUser | null;
  assignees?: Array<GitHubUser | null> | null;
  labels?: Array<string | { name?: string | null }> | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
}
export interface GitHubComment {
  id?: number;
  issue_url?: string | null;
  body?: string | null;
  user?: GitHubUser | null;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}
export interface GitHubIssueEvent {
  id?: number;
  event?: string | null;
  actor?: GitHubUser | null;
  created_at?: string | null;
  state_reason?: string | null;
  issue?: { number?: number; pull_request?: unknown } | null;
}

/** The subset of Octokit's REST client this connector calls. A real Octokit satisfies it. */
export interface GitHubIssuesClient {
  issues: {
    listForRepo(params: Record<string, unknown>): Promise<{ data: GitHubIssue[] }>;
    listCommentsForRepo(params: Record<string, unknown>): Promise<{ data: GitHubComment[] }>;
    listEventsForRepo(params: Record<string, unknown>): Promise<{ data: GitHubIssueEvent[] }>;
  };
  repos: {
    listCollaborators(params: Record<string, unknown>): Promise<{ data: GitHubUser[] }>;
  };
}

export interface GitHubIssuesDeps {
  client?: GitHubIssuesClient;
  now?: () => Date;
  createWorkItem?: (input: CreateWorkItemInput) => Promise<unknown>;
  mergeWorkItemPayload?: (id: string, patch: Record<string, unknown>, opts: { harness?: string }) => Promise<unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function clientOf(deps: GitHubIssuesDeps): Promise<GitHubIssuesClient> {
  if (deps.client) return deps.client;
  const octokit = await getOctokit();
  if (!octokit) throw new Error('github_not_authenticated');
  return octokit as unknown as GitHubIssuesClient;
}

export interface GitHubRepoRef { owner: string; repo: string }

function repoOf(source: ExternalTriggerSourceRow): GitHubRepoRef & { harnessSlug: string } {
  const owner = text(source.config?.owner);
  const repo = text(source.config?.repo);
  const harnessSlug = text(source.config?.harnessSlug);
  if (!owner || !repo) throw new Error('github_issues_repo_missing');
  if (!harnessSlug) throw new Error('github_issues_harness_missing');
  return { owner, repo, harnessSlug };
}

export function githubRepoRef(ref: GitHubRepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** The provider-neutral external id of a ticket: `owner/repo#number`. */
export function githubTicketExternalId(ref: GitHubRepoRef, number: number): string {
  return `${githubRepoRef(ref)}#${number}`;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

/** Deterministic work-item id of one ticket: the same issue always lands on the same row. */
export function ticketWorkItemId(workspaceId: string, dataSourceId: string, ticketExternalId: string): string {
  return `TKT-${digest([workspaceId, dataSourceId, ticketExternalId])}`;
}

/** Deterministic work-item id of one status change (`opened:<ticket>` or `event:<event id>`). */
export function ticketStatusChangeWorkItemId(workspaceId: string, dataSourceId: string, changeKey: string): string {
  return `TKS-${digest([workspaceId, dataSourceId, changeKey])}`;
}

export function githubCommentDedupeKey(dataSourceId: string, commentId: number): string {
  return `github-comment:${dataSourceId}:${commentId}`;
}

/** Which nature, if any, the source routes a provider object's datatype to. */
function routedDatatype(source: ExternalTriggerSourceRow & RoutingColumns, mappingKey: string, fallback: string, nature: string): string | null {
  const mapped = text(source.datatypeMappings?.[mappingKey]);
  const datatype = mapped || fallback;
  const natures = source.destinationPolicy?.[datatype];
  return Array.isArray(natures) && natures.includes(nature) ? datatype : null;
}

interface RoutingColumns {
  scope: string;
  scopeRef: string | null;
  datatypeMappings: Record<string, unknown>;
  destinationPolicy: Record<string, unknown>;
  permissionMapping: Record<string, unknown>;
}

async function routingOf(sql: Sql, source: ExternalTriggerSourceRow): Promise<ExternalTriggerSourceRow & RoutingColumns> {
  const rows = await sql<Array<RoutingColumns>>`
    SELECT scope, scope_ref AS "scopeRef", datatype_mappings AS "datatypeMappings",
           destination_policy AS "destinationPolicy", permission_mapping AS "permissionMapping"
      FROM harness_shared.data_sources
     WHERE workspace_id = ${source.workspaceId} AND id = ${source.id}::uuid`;
  if (!rows[0]) throw new Error('github_issues_source_missing');
  return { ...source, ...rows[0] };
}

async function requireDatatype(sql: Sql, workspaceId: string, id: string, nature: string, tier: string) {
  const row = await getDatatype(sql, workspaceId, id);
  if (!row || row.status !== 'active' || row.tier !== tier || (row as { nature?: string }).nature !== nature) {
    throw new Error(`ticket_datatype_unregistered:${id}`);
  }
  if (tier === 'generic-kind' && row.workItemKind !== id) throw new Error(`ticket_datatype_unregistered:${id}`);
  return row;
}

function checkPayload(schema: Record<string, unknown> | null | undefined, payload: unknown, datatype: string): void {
  const validation = validateDatatypePayload(schema, payload);
  if (!validation.ok) throw new Error(`ticket_payload_invalid:${datatype}:${validation.errors.join('; ')}`);
}

async function workItemExists(sql: Sql, workspaceId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ one: number }>>`
    SELECT 1 AS one FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND feature_id = ${id} LIMIT 1`;
  return rows.length > 0;
}

/** Create the row, or report that it already existed (also when a concurrent poll won the race). */
async function createOnce(sql: Sql, workspaceId: string, input: CreateWorkItemInput & { id: string }, deps: GitHubIssuesDeps): Promise<boolean> {
  if (await workItemExists(sql, workspaceId, input.id)) return false;
  try {
    await (deps.createWorkItem ?? defaultCreateWorkItem)(input);
    return true;
  } catch (error) {
    if (await workItemExists(sql, workspaceId, input.id)) return false;
    throw error;
  }
}

function login(user: GitHubUser | null | undefined): string | undefined {
  return text(user?.login) || undefined;
}

function iso(value: string | null | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The canonical `ticket` payload for one GitHub issue. */
export function githubIssueToTicket(ref: GitHubRepoRef, issue: GitHubIssue, dataSourceId: string): Record<string, unknown> {
  const number = Number(issue.number);
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? text(label) : text(label?.name)))
    .filter(Boolean);
  const assignees = (issue.assignees ?? []).map((user) => login(user)).filter((x): x is string => Boolean(x));
  const payload: Record<string, unknown> = {
    provider: GITHUB_ISSUES_PROVIDER,
    externalId: githubTicketExternalId(ref, number),
    container: githubRepoRef(ref),
    number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    state: text(issue.state) === 'closed' ? 'closed' : 'open',
    assignees,
    labels,
    dataSourceId,
  };
  const optional: Record<string, string | undefined> = {
    stateReason: text(issue.state_reason) || undefined,
    author: login(issue.user),
    url: text(issue.html_url) || undefined,
    createdAt: iso(issue.created_at),
    updatedAt: iso(issue.updated_at),
    closedAt: iso(issue.closed_at),
  };
  for (const [key, value] of Object.entries(optional)) if (value) payload[key] = value;
  return payload;
}

/** Issue number of a comment, from its `issue_url` (`…/repos/o/r/issues/<n>`). */
export function commentIssueNumber(comment: GitHubComment): number | null {
  const match = /\/issues\/(\d+)$/.exec(text(comment.issue_url));
  return match ? Number(match[1]) : null;
}

/**
 * Connect one repository's issues as a data source. Routes issues to `ticket` records,
 * comments to `ticket-comment` documents and state transitions to `ticket-status-change`
 * events. `scope` defaults to organization (comments read through the repository's
 * permission list); `pot` scopes the comments to one pot instead.
 */
export async function connectGitHubIssuesSource(
  sql: Sql,
  input: {
    workspaceId: string;
    ownerUserId: string;
    owner: string;
    repo: string;
    harnessSlug: string;
    scope?: 'organization' | 'pot';
    potSlug?: string;
    credentialRef?: string;
    createdBy?: string | null;
  },
): Promise<ExternalTriggerSourceRow> {
  const owner = text(input.owner);
  const repo = text(input.repo);
  const harnessSlug = text(input.harnessSlug);
  if (!owner || !repo) throw new Error('github_issues_repo_missing');
  if (!harnessSlug) throw new Error('github_issues_harness_missing');
  const scope = input.scope ?? 'organization';
  const potSlug = text(input.potSlug);
  if (scope === 'pot' && !potSlug) throw new Error('github_issues_pot_missing');
  const source = await upsertOwnedExternalTriggerSource(sql, {
    workspaceId: input.workspaceId,
    kind: GITHUB_ISSUES_PROVIDER,
    ownerUserId: input.ownerUserId,
    providerAccountId: `repo:${owner}/${repo}`,
    credentialRef: text(input.credentialRef) || 'github:operator-gh-identity',
    status: 'connected',
    config: { owner, repo, harnessSlug, objects: 'issues' },
    createdBy: input.createdBy,
  });
  const permissionMapping = scope === 'organization' ? { mode: 'source-acl' } : { mode: 'pot' };
  await sql`
    UPDATE harness_shared.data_sources
       SET scope = ${scope},
           scope_ref = ${scope === 'pot' ? potSlug : null},
           permission_mapping = ${sql.json(permissionMapping)},
           datatype_mappings = ${sql.json({ issue: TICKET_DATATYPE, comment: TICKET_COMMENT_DATATYPE, event: TICKET_STATUS_CHANGE_DATATYPE })},
           destination_policy = ${sql.json({
             [TICKET_DATATYPE]: ['record'],
             [TICKET_COMMENT_DATATYPE]: ['document'],
             [TICKET_STATUS_CHANGE_DATATYPE]: ['event'],
           })},
           backfill_status = CASE WHEN backfill_status = 'complete' THEN backfill_status ELSE 'pending' END,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId} AND id = ${source.id}::uuid`;
  return source;
}

/** Replace the repository's permission list with its current collaborators (GitHub user ids). */
export async function syncGitHubRepoMembership(
  sql: Sql,
  source: ExternalTriggerSourceRow,
  deps: GitHubIssuesDeps = {},
): Promise<{ members: number; added: number; removed: number }> {
  const ref = repoOf(source);
  const client = await clientOf(deps);
  const members: string[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await client.repos.listCollaborators({ owner: ref.owner, repo: ref.repo, per_page: GITHUB_ISSUES_PAGE, page });
    for (const user of data) if (Number.isFinite(Number(user?.id)) && user?.id != null) members.push(String(user.id));
    if (data.length < GITHUB_ISSUES_PAGE) break;
  }
  const list = await ensurePermissionList(sql, source.workspaceId, GITHUB_ISSUES_PROVIDER, githubRepoRef(ref));
  const delta = await replacePermissionListMembers(
    sql, source.workspaceId, list.id,
    members.map((providerUserId) => ({ provider: GITHUB_ISSUES_PROVIDER, providerUserId })),
  );
  return { members: members.length, ...delta };
}

interface TicketCursor {
  issuesSince?: string;
  commentsSince?: string;
  eventsSince?: string;
  nextAt?: string;
}

function ticketCursor(source: ExternalTriggerSourceRow): TicketCursor {
  const raw = source.cursor?.tickets;
  return raw && typeof raw === 'object' ? { ...(raw as TicketCursor) } : {};
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export interface GitHubIssuesPollResult {
  status: 'paused' | 'rate-limited' | 'progressed';
  tickets: { created: number; updated: number };
  statusChanges: number;
  comments: { written: number; skipped: number };
  nextAt: string | null;
}

class GitHubRateLimited extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`github_issues_rate_limited:${retryAfterSec}`);
  }
}

function rateLimitOf(error: unknown, now: Date): GitHubRateLimited | null {
  const e = error as { status?: number; response?: { headers?: Record<string, string | undefined> } };
  if (e?.status !== 429 && e?.status !== 403) return null;
  const headers = e.response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new GitHubRateLimited(retryAfter);
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) {
    return new GitHubRateLimited(Math.max(1, Math.ceil(reset - now.getTime() / 1_000)));
  }
  return e.status === 429 ? new GitHubRateLimited(60) : null;
}

/**
 * One bounded poll of a repository: issues updated since the cursor, then their state
 * transitions, then comments. Each list reads at most GITHUB_ISSUES_MAX_PAGES pages and the
 * cursor advances to the newest timestamp it saw; GitHub's `since` is inclusive, so the boundary
 * object is read again and absorbed by the idempotent writes.
 */
export async function pollGitHubIssuesOnce(
  sql: Sql,
  source: ExternalTriggerSourceRow,
  deps: GitHubIssuesDeps = {},
): Promise<GitHubIssuesPollResult> {
  const ref = repoOf(source);
  const now = (deps.now ?? (() => new Date()))();
  const cursor = ticketCursor(source);
  const result: GitHubIssuesPollResult = {
    status: 'progressed',
    tickets: { created: 0, updated: 0 },
    statusChanges: 0,
    comments: { written: 0, skipped: 0 },
    nextAt: null,
  };
  const nextAtMs = Date.parse(text(cursor.nextAt));
  if (Number.isFinite(nextAtMs) && nextAtMs > now.getTime()) {
    return { ...result, status: 'paused', nextAt: new Date(nextAtMs).toISOString() };
  }
  const routed = await routingOf(sql, source);
  const ticketType = routedDatatype(routed, 'issue', TICKET_DATATYPE, 'record');
  const commentObject = { mappingKey: 'comment', defaultDatatype: TICKET_COMMENT_DATATYPE };
  const changeType = routedDatatype(routed, 'event', TICKET_STATUS_CHANGE_DATATYPE, 'event');
  const ticketDef = ticketType ? await requireDatatype(sql, source.workspaceId, ticketType, 'record', 'generic-kind') : null;
  const changeDef = changeType ? await requireDatatype(sql, source.workspaceId, changeType, 'event', 'generic-kind') : null;
  const client = await clientOf(deps);
  const create = (input: CreateWorkItemInput & { id: string }) => createOnce(sql, source.workspaceId, input, deps);
  const merge = deps.mergeWorkItemPayload ?? defaultMergeWorkItemPayload;
  const next: TicketCursor = { ...cursor };
  delete next.nextAt;

  const statusChange = async (key: string, ticketExternalId: string, payload: Record<string, unknown>, title: string) => {
    if (!changeType || !changeDef) return;
    const ticketId = ticketWorkItemId(source.workspaceId, source.id, ticketExternalId);
    const full = { provider: GITHUB_ISSUES_PROVIDER, ticketExternalId, ticketWorkItemId: ticketId, dataSourceId: source.id, ...payload };
    checkPayload(changeDef.payloadSchema, full, changeType);
    const created = await create({
      id: ticketStatusChangeWorkItemId(source.workspaceId, source.id, key),
      kind: changeType as CreateWorkItemInput['kind'],
      title,
      summary: title,
      harness: ref.harnessSlug,
      workspaceId: source.workspaceId,
      payload: full,
      createdBy: GITHUB_ISSUES_CREATED_BY,
    });
    if (created) result.statusChanges += 1;
  };

  const save = async (lastError: string | null) => {
    await updateExternalTriggerSourceSyncState(sql, source.workspaceId, source.id, {
      status: lastError ? 'degraded' : 'connected',
      cursor: { ...source.cursor, tickets: next },
      lastError,
    });
  };

  try {
    // 1. Issues -> ticket records (and a synthetic `opened` change the first time a ticket lands).
    const known = new Set<number>();
    for (let page = 1; page <= GITHUB_ISSUES_MAX_PAGES; page += 1) {
      const { data } = await client.issues.listForRepo({
        owner: ref.owner, repo: ref.repo, state: 'all', sort: 'updated', direction: 'asc',
        per_page: GITHUB_ISSUES_PAGE, page, ...(cursor.issuesSince ? { since: cursor.issuesSince } : {}),
      });
      for (const issue of data) {
        next.issuesSince = later(next.issuesSince, iso(issue.updated_at));
        if (issue.pull_request || !Number.isInteger(issue.number)) continue;
        const number = issue.number as number;
        known.add(number);
        if (!ticketType || !ticketDef) continue;
        const payload = githubIssueToTicket(ref, issue, source.id);
        checkPayload(ticketDef.payloadSchema, payload, ticketType);
        const externalId = String(payload.externalId);
        const id = ticketWorkItemId(source.workspaceId, source.id, externalId);
        const title = `${externalId}: ${String(payload.title) || '(untitled)'}`;
        const created = await create({
          id, kind: ticketType as CreateWorkItemInput['kind'], title, summary: String(payload.body ?? ''),
          harness: ref.harnessSlug, workspaceId: source.workspaceId, payload, createdBy: GITHUB_ISSUES_CREATED_BY,
        });
        if (created) {
          result.tickets.created += 1;
          await statusChange(`opened:${externalId}`, externalId, {
            externalId: `opened:${externalId}`,
            transition: 'opened',
            ...(payload.author ? { actor: payload.author } : {}),
            ...(payload.createdAt ? { occurredAt: payload.createdAt } : {}),
          }, `${externalId} opened`);
        } else {
          // mergeWorkItemPayload reads the row back in the operator's active workspace and
          // returns null when it cannot see it. Counting that as an update would drop the
          // change silently, so a miss fails the poll instead.
          const merged = await merge(id, payload, { harness: ref.harnessSlug });
          if (!merged) throw new Error(`ticket_merge_failed:${id}`);
          result.tickets.updated += 1;
        }
      }
      if (data.length < GITHUB_ISSUES_PAGE) break;
    }

    // 2. Close/reopen events -> ticket-status-change events. The list is newest first, so
    //    paging stops at the first event older than the cursor.
    if (changeType) {
      let newest: string | undefined;
      pages: for (let page = 1; page <= GITHUB_ISSUES_MAX_PAGES; page += 1) {
        const { data } = await client.issues.listEventsForRepo({ owner: ref.owner, repo: ref.repo, per_page: GITHUB_ISSUES_PAGE, page });
        for (const event of data) {
          const at = iso(event.created_at);
          if (cursor.eventsSince && at && Date.parse(at) < Date.parse(cursor.eventsSince)) break pages;
          newest = later(newest, at);
          const transition = text(event.event);
          const number = event.issue?.number;
          if ((transition !== 'closed' && transition !== 'reopened') || event.issue?.pull_request || !Number.isInteger(number) || event.id == null) continue;
          const externalId = githubTicketExternalId(ref, number as number);
          if (!(await workItemExists(sql, source.workspaceId, ticketWorkItemId(source.workspaceId, source.id, externalId)))) continue;
          await statusChange(`event:${event.id}`, externalId, {
            externalId: String(event.id),
            transition,
            ...(text(event.state_reason) ? { stateReason: text(event.state_reason) } : {}),
            ...(login(event.actor) ? { actor: login(event.actor) } : {}),
            ...(at ? { occurredAt: at } : {}),
          }, `${externalId} ${transition}`);
        }
        if (data.length < GITHUB_ISSUES_PAGE) break;
      }
      next.eventsSince = later(cursor.eventsSince, newest);
    }

    // 3. Comments -> ticket-comment documents, routed by the source's scope.
    const route = corpusRouteFor(
      { kind: routed.kind, scope: routed.scope, scope_ref: routed.scopeRef, owner_user_id: routed.ownerUserId,
        provider_account_id: routed.providerAccountId, datatype_mappings: routed.datatypeMappings,
        destination_policy: routed.destinationPolicy, permission_mapping: routed.permissionMapping },
      commentObject,
    );
    if (route.write) {
      const commentDef = await getDatatype(sql, source.workspaceId, text(routed.datatypeMappings?.comment) || TICKET_COMMENT_DATATYPE);
      const listId = route.scope === 'organization'
        ? (await ensurePermissionList(sql, source.workspaceId, route.source, githubRepoRef(ref))).id
        : null;
      for (let page = 1; page <= GITHUB_ISSUES_MAX_PAGES; page += 1) {
        const { data } = await client.issues.listCommentsForRepo({
          owner: ref.owner, repo: ref.repo, sort: 'updated', direction: 'asc',
          per_page: GITHUB_ISSUES_PAGE, page, ...(cursor.commentsSince ? { since: cursor.commentsSince } : {}),
        });
        for (const comment of data) {
          next.commentsSince = later(next.commentsSince, iso(comment.updated_at));
          const number = commentIssueNumber(comment);
          if (number === null || comment.id == null) { result.comments.skipped += 1; continue; }
          const ticketExternalId = githubTicketExternalId(ref, number);
          const ticketId = ticketWorkItemId(source.workspaceId, source.id, ticketExternalId);
          // A comment on a pull request (or on an issue this source never ingested) has no ticket.
          if (!known.has(number) && !(await workItemExists(sql, source.workspaceId, ticketId))) {
            result.comments.skipped += 1;
            continue;
          }
          const author = login(comment.user);
          const occurredAt = iso(comment.created_at);
          const canonical: Record<string, unknown> = {
            provider: GITHUB_ISSUES_PROVIDER,
            externalId: String(comment.id),
            ticketExternalId,
            text: typeof comment.body === 'string' ? comment.body : '',
            ...(author ? { author } : {}),
            ...(text(comment.html_url) ? { url: text(comment.html_url) } : {}),
            ...(occurredAt ? { occurredAt } : {}),
          };
          if (commentDef) checkPayload(commentDef.payloadSchema, canonical, commentDef.id);
          await writeCorpusDocument(sql, source.workspaceId, route, source.id, listId, {
            source: route.source,
            kind: commentDef?.id ?? TICKET_COMMENT_DATATYPE,
            dedupeKey: githubCommentDedupeKey(source.id, comment.id),
            externalId: String(comment.id),
            occurredAt: occurredAt ?? null,
            participants: author ? [author] : [],
            title: `${ticketExternalId} comment`,
            text: String(canonical.text),
            metadata: { ...canonical, ticketWorkItemId: ticketId, dataSourceId: source.id, updatedAt: iso(comment.updated_at) ?? null },
          });
          result.comments.written += 1;
        }
        if (data.length < GITHUB_ISSUES_PAGE) break;
      }
    }
    await save(null);
    return result;
  } catch (error) {
    const limited = rateLimitOf(error, now);
    if (!limited) throw error;
    const nextAt = new Date(now.getTime() + limited.retryAfterSec * 1_000).toISOString();
    // Keep the old watermarks: the step is replayed from the start once the limit lifts.
    next.issuesSince = cursor.issuesSince;
    next.commentsSince = cursor.commentsSince;
    next.eventsSince = cursor.eventsSince;
    next.nextAt = nextAt;
    await save(limited.message);
    return { ...result, status: 'rate-limited', nextAt };
  }
}
