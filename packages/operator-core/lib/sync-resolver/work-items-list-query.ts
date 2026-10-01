/**
 * Corpus-accurate Work Items list + companion summary (P-004).
 *
 * The mutable newest-first list is keyset-paged over (updated_ts, feature_id).
 * The row page and every aggregate compile from one normalized predicate; the
 * deliberately bounded states/perState picker/HUD branch remains a fair sample
 * and never claims corpus completeness.
 */
import type {
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import type { BoundedListPage } from './bounded-list-read';
import {
  observationLaneExclusionSql,
  type OrgSql,
} from '../work-items';
import { deriveWorkItemPresentationStage, readImplementationReadiness } from '../harness/improvements/agent-review-policy';
import type { WorkItemPresentation } from '../work-item-presentation-contract';
import { activeWorkItemDependencyRefsSql } from '../dbos/work-item-deps-store';
import { ALL_SUCCESSFUL_STATUSES, ALL_TERMINAL_STATUSES } from '../work-item-blocking';

export const WORK_ITEMS_CURSOR_PAGE_LIMIT = 500;
export const WORK_ITEMS_FAIR_STATE_LIMIT = 200;

export interface WorkItemsListWireFilters {
  id?: string;
  title?: string;
  kinds?: string[];
  states?: string[];
  stages?: string[];
  assignees?: string[];
  severities?: string[];
  plans?: string[];
  priorityMin?: number;
  priorityMax?: number;
  rankMin?: number;
  rankMax?: number;
}

export interface WorkItemsListWireArgs {
  harnessSlug?: string;
  harnessSlugs?: string[];
  /** Backward-compatible singular server filters. */
  kind?: string;
  state?: string;
  /** Global quick search over id/title/state/assignee. */
  q?: string;
  filters?: WorkItemsListWireFilters;
  cursor?: string | null;
  limit?: number;
  /** Legacy fair-slice branch used only by bounded pickers/HUD boards. */
  states?: string[];
  perState?: number;
}

export interface WorkItemsCursor {
  updatedTs: number;
  id: string;
}

export interface NormalizedWorkItemsListArgs {
  harnessSlug: string | null;
  harnessSlugs: string[];
  q: string | null;
  filters: {
    id: string | null;
    title: string | null;
    kinds: string[];
    states: string[];
    stages: string[];
    assignees: string[];
    severities: string[];
    plans: string[];
    priorityMin: number | null;
    priorityMax: number | null;
    rankMin: number | null;
    rankMax: number | null;
  };
  cursor: WorkItemsCursor | null;
  limit: number;
  fairStates: string[];
  perState: number;
}

export interface WorkItemsCompiledPredicate {
  args: NormalizedWorkItemsListArgs;
  fingerprint: string;
}

export interface WorkItemsListRow {
  id: string;
  kind: string;
  family: 'feature' | 'issue';
  title: string;
  summary: string;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedAt: string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  presentation?: WorkItemPresentation;
}

const uniq = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function decodeWorkItemsCursor(raw: string | null | undefined): WorkItemsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkItemsCursor>;
    return Number.isSafeInteger(parsed.updatedTs) && typeof parsed.id === 'string' && parsed.id.length > 0
      ? { updatedTs: parsed.updatedTs!, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

export const encodeWorkItemsCursor = (row: { updatedTs: number; id: string }): string =>
  JSON.stringify({ updatedTs: row.updatedTs, id: row.id });

export function normalizeWorkItemsListArgs(
  args: WorkItemsListWireArgs,
): NormalizedWorkItemsListArgs {
  const filters = args.filters ?? {};
  const harnessSlug = args.harnessSlug?.trim() || null;
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? WORK_ITEMS_CURSOR_PAGE_LIMIT), 1),
    WORK_ITEMS_CURSOR_PAGE_LIMIT,
  );
  const perState = Math.min(
    Math.max(Math.trunc(finite(args.perState) ?? 60), 1),
    WORK_ITEMS_FAIR_STATE_LIMIT,
  );
  return {
    harnessSlug,
    harnessSlugs: harnessSlug ? [] : uniq(args.harnessSlugs),
    q: args.q?.trim() || null,
    filters: {
      id: filters.id?.trim() || null,
      title: filters.title?.trim() || null,
      kinds: uniq([...(filters.kinds ?? []), ...(args.kind ? [args.kind] : [])]),
      states: uniq([...(filters.states ?? []), ...(args.state ? [args.state] : [])]),
      stages: uniq(filters.stages),
      assignees: uniq(filters.assignees),
      severities: uniq(filters.severities),
      plans: uniq(filters.plans),
      priorityMin: finite(filters.priorityMin),
      priorityMax: finite(filters.priorityMax),
      rankMin: finite(filters.rankMin),
      rankMax: finite(filters.rankMax),
    },
    cursor: decodeWorkItemsCursor(args.cursor),
    limit,
    fairStates: uniq(args.states),
    perState,
  };
}

export function buildWorkItemsPredicate(
  args: NormalizedWorkItemsListArgs,
): WorkItemsCompiledPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export function workItemsSummarySelection(
  args: NormalizedWorkItemsListArgs,
): FacetSelection {
  const entries: Array<[string, ReadonlySet<string>]> = [];
  const add = (key: string, values: string[]) => {
    if (values.length > 0) entries.push([key, new Set(values)]);
  };
  add('kind', args.filters.kinds);
  add('state', args.filters.states);
  add('stage', args.filters.stages);
  add('assignee', args.filters.assignees);
  add('severity', args.filters.severities);
  add('plan', args.filters.plans);
  return new Map(entries);
}

const likeContainsPattern = (query: string): string =>
  `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

type FacetKey = 'kind' | 'state' | 'stage' | 'assignee' | 'severity' | 'plan';

function workItemScopeSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    wi.workspace_id = ${workspaceId}
    AND ${
      args.harnessSlug
        ? sql`wi.harness_slug = ${args.harnessSlug}`
        : args.harnessSlugs.length > 0
          ? sql`wi.harness_slug = ANY(${args.harnessSlugs}::text[])`
          : sql`FALSE`
    }
    AND (wi.parent_id IS NULL OR wi.parent_id = '')
    AND ${observationLaneExclusionSql(sql)}`;
}

function spawnedAgentScopeSql(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    sa.workspace_id = ${workspaceId}
    AND ${
      args.harnessSlug
        ? sql`sa.harness_slug = ${args.harnessSlug}`
        : args.harnessSlugs.length > 0
          ? sql`sa.harness_slug = ANY(${args.harnessSlugs}::text[])`
          : sql`FALSE`
    }`;
}

function predicateSql(
  sql: OrgSql,
  args: NormalizedWorkItemsListArgs,
  omit?: FacetKey,
) {
  const f = args.filters;
  const q = args.q ? likeContainsPattern(args.q) : null;
  const id = f.id ? likeContainsPattern(f.id) : null;
  const title = f.title ? likeContainsPattern(f.title) : null;
  return sql`
    ${
      q
        ? sql`(
            COALESCE(s.id, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.title, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.state, '') ILIKE ${q} ESCAPE '\\'
            OR COALESCE(s.assignee, '') ILIKE ${q} ESCAPE '\\'
          )`
        : sql`TRUE`
    }
    AND ${id ? sql`COALESCE(s.id, '') ILIKE ${id} ESCAPE '\\'` : sql`TRUE`}
    AND ${title ? sql`COALESCE(s.title, '') ILIKE ${title} ESCAPE '\\'` : sql`TRUE`}
    AND ${omit !== 'kind' && f.kinds.length > 0 ? sql`s.kind = ANY(${f.kinds}::text[])` : sql`TRUE`}
    AND ${omit !== 'state' && f.states.length > 0 ? sql`s.state = ANY(${f.states}::text[])` : sql`TRUE`}
    AND ${omit !== 'stage' && f.stages.length > 0 ? sql`s.spine_role = ANY(${f.stages}::text[])` : sql`TRUE`}
    AND ${omit !== 'assignee' && f.assignees.length > 0 ? sql`s.assignee = ANY(${f.assignees}::text[])` : sql`TRUE`}
    AND ${omit !== 'severity' && f.severities.length > 0 ? sql`s.severity = ANY(${f.severities}::text[])` : sql`TRUE`}
    AND ${omit !== 'plan' && f.plans.length > 0 ? sql`s.plan_slug = ANY(${f.plans}::text[])` : sql`TRUE`}
    AND ${f.priorityMin != null ? sql`s.priority >= ${f.priorityMin}` : sql`TRUE`}
    AND ${f.priorityMax != null ? sql`s.priority <= ${f.priorityMax}` : sql`TRUE`}
    AND ${f.rankMin != null ? sql`s.rank >= ${f.rankMin}` : sql`TRUE`}
    AND ${f.rankMax != null ? sql`s.rank <= ${f.rankMax}` : sql`TRUE`}`;
}

function scopedCtes(
  sql: OrgSql,
  workspaceId: string,
  args: NormalizedWorkItemsListArgs,
) {
  return sql`
    latest_spine AS MATERIALIZED (
      SELECT DISTINCT ON (sa.workspace_id, sa.harness_slug, sa.feature_id)
             sa.workspace_id,
             sa.harness_slug,
             sa.feature_id,
             sa.child_role,
             sa.status
        FROM harness_shared.spawned_agents sa
       WHERE ${spawnedAgentScopeSql(sql, workspaceId, args)}
         AND sa.feature_id IS NOT NULL
       ORDER BY sa.workspace_id, sa.harness_slug, sa.feature_id,
                sa.started_at DESC NULLS LAST, sa.spawn_id DESC
    ),
    scoped AS (
      SELECT wi.feature_id AS id,
             wi.harness_slug,
             wi.item_kind AS kind,
             CASE WHEN wi.item_kind = ANY(ARRAY['bug','change','task']::text[])
                  THEN 'issue' ELSE 'feature' END AS family,
             COALESCE(wi.title, '') AS title,
             COALESCE(wi.status, 'open') AS state,
             NULLIF(wi.taken_by, 'unassigned') AS assignee,
             CASE WHEN wi.item_kind = ANY(ARRAY['bug','change','task']::text[])
                  THEN wi.payload->'_ei'->>'assigned_by' ELSE NULL END AS assigned_by,
             CASE WHEN wi.item_kind = ANY(ARRAY['bug','change','task']::text[])
                  THEN COALESCE(wi.payload->'_ei'->>'severity', 'minor') ELSE NULL END AS severity,
             wi.feature_order AS priority,
             wi.assignee_rank AS rank,
             wi.source_plan_slug AS plan_slug,
             spine.child_role AS spine_role,
             spine.status AS spine_status,
             COALESCE(wi.updated_ts, 0)::bigint AS updated_ts,
             wi.origin,
             wi.audit_verdict,
             wi.verified_author_github_user_id
        FROM harness_shared.work_items wi
        LEFT JOIN latest_spine spine
          ON spine.workspace_id = wi.workspace_id
         AND spine.harness_slug = wi.harness_slug
         AND spine.feature_id = wi.feature_id
       WHERE ${workItemScopeSql(sql, workspaceId, args)}
    )`;
}

interface WorkItemsDbRow {
  id: string;
  harnessSlug: string;
  kind: string;
  family: 'feature' | 'issue';
  title: string;
  state: string;
  assignee: string | null;
  assignedBy: string | null;
  severity: string | null;
  priority: number | null;
  rank: number | null;
  planSlug: string | null;
  spineRole: string | null;
  spineStatus: string | null;
  updatedTs: number | string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | string | null;
}

const numberOrNull = (value: number | string | null | undefined): number | null => {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};

function mapWorkItemsRow(row: WorkItemsDbRow): WorkItemsListRow & { updatedTs: number } {
  const updatedTs = numberOrNull(row.updatedTs) ?? 0;
  return {
    id: row.id,
    kind: row.kind,
    family: row.family,
    title: row.title,
    summary: '',
    state: row.state,
    assignee: row.assignee,
    assignedBy: row.assignedBy,
    severity: row.severity,
    priority: numberOrNull(row.priority),
    rank: numberOrNull(row.rank),
    planSlug: row.planSlug,
    spineRole: row.spineRole,
    spineStatus: row.spineStatus,
    updatedAt: new Date(updatedTs).toISOString(),
    updatedTs,
    origin: row.origin,
    auditVerdict: row.auditVerdict,
    verifiedAuthorGithubUserId: numberOrNull(row.verifiedAuthorGithubUserId),
  };
}

const selectListColumns = (sql: OrgSql) => sql`
  id,
  harness_slug AS "harnessSlug",
  kind,
  family,
  title,
  state,
  assignee,
  assigned_by AS "assignedBy",
  severity,
  priority,
  rank,
  plan_slug AS "planSlug",
  spine_role AS "spineRole",
  spine_status AS "spineStatus",
  updated_ts AS "updatedTs",
  origin,
  audit_verdict AS "auditVerdict",
  verified_author_github_user_id AS "verifiedAuthorGithubUserId"`;

/** Reuse the acceptance classifier only for the bounded page (or one detail row).
 * Full payloads and source bodies never enter the list wire or summary census.
 */
export async function readWorkItemPresentations(
  sql: OrgSql,
  workspaceId: string,
  selected: readonly { id: string; harnessSlug: string }[],
): Promise<Map<string, WorkItemPresentation>> {
  if (selected.length === 0) return new Map();
  const rows = await sql<{
    id: string; harnessSlug: string; kind: string; status: string;
    title: string; summary: string | null; payload: unknown;
    assignee: string | null; terminalOwner: string | null;
    terminalCompletionRef: string | null; completionAuthority: string | null; blocked: boolean;
  }[]>`
    WITH active_dependencies AS (${activeWorkItemDependencyRefsSql(sql, {
      itemWorkspaceId: workspaceId,
      successfulStates: [...ALL_SUCCESSFUL_STATUSES], terminalStates: [...ALL_TERMINAL_STATUSES],
    })})
    SELECT wi.feature_id AS id, wi.harness_slug AS "harnessSlug",
           wi.item_kind AS kind, wi.status, wi.title, wi.summary,
           -- Preserve absent versus enrolled-null readiness. Only narrow fields
           -- needed by the shared classifier leave this bounded SQL read.
           (CASE WHEN wi.payload ? 'implementationReadiness'
             THEN jsonb_build_object('implementationReadiness', wi.payload->'implementationReadiness')
             ELSE '{}'::jsonb END) || jsonb_build_object(
             'lane', wi.payload->'lane', '_claimHold', wi.payload->'_claimHold',
             'needsOwnerAction', wi.payload->'needsOwnerAction',
             'humanCapability', wi.payload->'humanCapability',
             'externalBlockers', wi.payload->'externalBlockers') AS payload,
           wi.taken_by AS assignee, wi.terminal_owner AS "terminalOwner",
           wi.terminal_completion_ref AS "terminalCompletionRef", wi.authority AS "completionAuthority",
           EXISTS (SELECT 1 FROM active_dependencies d
             WHERE d.blocked_ref IN (wi.feature_id, wi.harness_slug || '#' || wi.feature_id)) AS blocked
      FROM harness_shared.work_items wi
      JOIN unnest(${selected.map(r => r.id)}::text[], ${selected.map(r => r.harnessSlug)}::text[])
        AS requested(id, harness) ON wi.feature_id = requested.id AND wi.harness_slug = requested.harness
     WHERE wi.workspace_id = ${workspaceId} AND wi.item_kind = ANY(ARRAY['bug','change','task']::text[])`;
  return new Map(rows.map((row): [string, WorkItemPresentation] => {
    const decision = deriveWorkItemPresentationStage(row);
    const readiness = readImplementationReadiness(row.payload);
    const refs = readiness?.evidence?.acceptance?.evidence;
    const evidenceRefs = Array.isArray(refs) ? refs : [];
    return [`${row.harnessSlug}#${row.id}`, {
      stage: decision.stage,
      reason: decision.reason + (readiness?.reason ? `: ${readiness.reason.slice(0, 500)}` : ''),
      evidenceRefs: evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 8).map(ref => ref.slice(0, 500)),
      completionRef: row.terminalCompletionRef?.slice(0, 500) ?? null,
    }];
  }));
}

export async function readWorkItemsPageFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: WorkItemsCompiledPredicate,
): Promise<BoundedListPage<WorkItemsListRow>> {
  const args = predicate.args;
  if (args.fairStates.length > 0) {
    const rows = await sql<WorkItemsDbRow[]>`
      WITH ${scopedCtes(sql, workspaceId, args)},
      ranked AS (
        SELECT s.*,
               row_number() OVER (
                 PARTITION BY s.state
                 ORDER BY s.updated_ts DESC, s.id DESC
               ) AS state_rank
          FROM scoped s
         WHERE ${predicateSql(sql, args)}
           AND s.state = ANY(${args.fairStates}::text[])
      )
      SELECT ${selectListColumns(sql)}
        FROM ranked
       WHERE state_rank <= ${args.perState}
       ORDER BY updated_ts DESC, id DESC`;
    const presentations = await readWorkItemPresentations(sql, workspaceId, rows);
    return { rows: rows.map(row => ({ ...mapWorkItemsRow(row), presentation: presentations.get(`${row.harnessSlug}#${row.id}`) })), nextCursor: null, hasMore: false };
  }

  const rows = await sql<WorkItemsDbRow[]>`
    WITH ${scopedCtes(sql, workspaceId, args)}
    SELECT ${selectListColumns(sql)}
      FROM scoped s
     WHERE ${predicateSql(sql, args)}
       AND ${
         args.cursor
           ? sql`(s.updated_ts, s.id) < (${args.cursor.updatedTs}::bigint, ${args.cursor.id}::text)`
           : sql`TRUE`
       }
     ORDER BY s.updated_ts DESC, s.id DESC
     LIMIT ${args.limit + 1}`;
  const hasMore = rows.length > args.limit;
  const pageRows = hasMore ? rows.slice(0, args.limit) : rows;
  const presentations = await readWorkItemPresentations(sql, workspaceId, pageRows);
  const mapped = pageRows.map(row => ({ ...mapWorkItemsRow(row), presentation: presentations.get(`${row.harnessSlug}#${row.id}`) }));
  const tail = mapped[mapped.length - 1];
  return {
    rows: mapped.map(({ updatedTs: _updatedTs, ...row }) => row),
    previousCursor: args.cursor ? encodeWorkItemsCursor(args.cursor) : null,
    nextCursor: hasMore && tail ? encodeWorkItemsCursor({ updatedTs: tail.updatedTs, id: tail.id }) : null,
    hasMore,
  };
}

interface WorkItemsAggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

export async function readWorkItemsSummaryFromStore(
  sql: OrgSql,
  workspaceId: string,
  predicate: WorkItemsCompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const args = predicate.args;
  const rows = await sql<WorkItemsAggregateDbRow[]>`
    WITH ${scopedCtes(sql, workspaceId, args)},
    totals AS (
      SELECT count(*)::int AS n FROM scoped
    ),
    matched AS (
      SELECT count(*)::int AS n FROM scoped s WHERE ${predicateSql(sql, args)}
    ),
    kind_facets AS (
      SELECT s.kind AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'kind')} AND s.kind IS NOT NULL AND s.kind <> ''
       GROUP BY s.kind
    ),
    state_facets AS (
      SELECT s.state AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'state')} AND s.state IS NOT NULL AND s.state <> ''
       GROUP BY s.state
    ),
    stage_facets AS (
      SELECT s.spine_role AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'stage')} AND s.spine_role IS NOT NULL AND s.spine_role <> ''
       GROUP BY s.spine_role
    ),
    assignee_facets AS (
      SELECT s.assignee AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'assignee')} AND s.assignee IS NOT NULL AND s.assignee <> ''
       GROUP BY s.assignee
    ),
    severity_facets AS (
      SELECT s.severity AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'severity')} AND s.severity IS NOT NULL AND s.severity <> ''
       GROUP BY s.severity
    ),
    plan_facets AS (
      SELECT s.plan_slug AS value, count(*)::int AS n
        FROM scoped s
       WHERE ${predicateSql(sql, args, 'plan')} AND s.plan_slug IS NOT NULL AND s.plan_slug <> ''
       GROUP BY s.plan_slug
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched
      FROM totals CROSS JOIN matched
    UNION ALL SELECT 'facet', 'kind', 'Kind', value, n, NULL, NULL FROM kind_facets
    UNION ALL SELECT 'facet', 'state', 'State', value, n, NULL, NULL FROM state_facets
    UNION ALL SELECT 'facet', 'stage', 'Stage', value, n, NULL, NULL FROM stage_facets
    UNION ALL SELECT 'facet', 'assignee', 'Assignee', value, n, NULL, NULL FROM assignee_facets
    UNION ALL SELECT 'facet', 'severity', 'Severity', value, n, NULL, NULL FROM severity_facets
    UNION ALL SELECT 'facet', 'plan', 'Plan', value, n, NULL, NULL FROM plan_facets`;

  return rows.map((row): CompanionSummaryAggregateRow =>
    row.kind === 'totals'
      ? { kind: 'totals', total: row.total ?? 0, matched: row.matched ?? 0 }
      : {
          kind: 'facet',
          facet: row.facet ?? '',
          label: row.label ?? undefined,
          value: row.value ?? '',
          count: row.count ?? 0,
        },
  );
}
