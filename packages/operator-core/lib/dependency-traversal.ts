/**
 * Cross-store dependency traversal.
 *
 * Plan-item dependencies and work-item dependencies deliberately have different
 * stores and identities:
 *
 *   - plan items: harness_plans.items / the normalized plan_items index;
 *   - plan-item <-> work-item coverage: source-plan stamps plus legacy
 *     coord_links `implements` edges;
 *   - work items: canonical work_item_deps;
 *   - typed external blockers: work_items.payload.externalBlockers.
 *
 * Consumers must not stitch those surfaces together independently. This module
 * executes ONE recursive PostgreSQL query over the union graph and returns the
 * reached nodes and edges. Later renderers may rank, diff, or draw the result;
 * this module owns only graph truth.
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';

export type DependencyTraversalDirection = 'blockers' | 'blocked';

export type DependencyTraversalStart =
  | { kind: 'plan_item'; planSlug: string; itemId: string }
  | { kind: 'work_item'; id: string };

export type DependencyTraversalNodeKind = 'plan_item' | 'work_item' | 'external';

export interface DependencyTraversalNode {
  key: string;
  kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  itemId: string | null;
  depth: number;
}

export type DependencyTraversalRelation =
  | 'plan-blocks'
  | 'work-item-blocks'
  | 'coverage'
  | 'external-blocker';

/**
 * Edges use the storage/readiness orientation: subject -> dependency.
 * For a blocking edge, `subjectKey` is the blocked item and `dependencyKey` is
 * the blocker. Coverage is identity-like and is traversed in both directions.
 */
export interface DependencyTraversalEdge {
  key: string;
  subjectKey: string;
  dependencyKey: string;
  relation: DependencyTraversalRelation;
  externalRef: string | null;
}

export interface DependencyTraversalResult {
  startKey: string;
  direction: DependencyTraversalDirection;
  found: boolean;
  nodes: DependencyTraversalNode[];
  edges: DependencyTraversalEdge[];
  truncated: boolean;
  maxDepth: number;
}

interface DependencyTraversalRow {
  node_key: string;
  node_kind: DependencyTraversalNodeKind;
  ref: string;
  status: string | null;
  title: string | null;
  harness_slug: string | null;
  plan_slug: string | null;
  item_id: string | null;
  depth: number | string;
  edge_key: string | null;
  subject_key: string | null;
  dependency_key: string | null;
  relation: DependencyTraversalRelation | null;
  external_ref: string | null;
  hit_depth_limit: boolean;
}

type DependencyTraversalQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<DependencyTraversalRow[]>;

const ISSUE_FAMILY_KINDS = ['bug', 'change', 'task'];
const PLAN_ITEM_RE = /^P-\d{3,}$/;
const WORK_ITEM_RE = /^(?:WI|EI|F)-\d+$/i;

export const DEFAULT_DEPENDENCY_TRAVERSAL_MAX_DEPTH = 64;

/**
 * Resolve a work-item identity only from a typed blocker's stable ref.
 *
 * Event/gate refs commonly namespace their owning item (for example
 * `harness:papercusp:wi-40086-qualified-current-tip`). We intentionally do not
 * inspect summary/evidence prose: prose can mention many items and is not an
 * identity surface.
 */
export function workItemIdFromExternalBlockerRef(ref: string): string | null {
  const match = /(?:^|[^a-z0-9])((?:WI|EI|F)-\d+)(?=$|[^a-z0-9])/i.exec(ref);
  return match?.[1]?.toUpperCase() ?? null;
}

export function dependencyTraversalStartKey(start: DependencyTraversalStart): string {
  if (start.kind === 'plan_item') {
    const planSlug = start.planSlug.trim();
    const itemId = start.itemId.trim().toUpperCase();
    if (!planSlug || !PLAN_ITEM_RE.test(itemId)) {
      throw new Error('plan-item traversal start requires a non-empty planSlug and a P-NNN itemId');
    }
    return `plan_item:${planSlug}#${itemId}`;
  }
  const id = start.id.trim().toUpperCase();
  if (!WORK_ITEM_RE.test(id)) {
    throw new Error('work-item traversal start requires a WI-/EI-/F- numeric id');
  }
  return `work_item:${id}`;
}

/**
 * ONE query builds and traverses the union graph. Parameters:
 *   $1 workspace id; $2 harness; $3 coordination workspace; $4 start key;
 *   $5 direction; $6 max depth; $7 issue-family kinds.
 *
 * `raw_plan_nodes` keeps the normalized index authoritative while retaining the
 * rebuildable harness_plans.items compatibility leg. Coverage uses the same
 * precedence as planStampOf(): payload.plan_item wins for the plan namespace and
 * its item id is unioned with source_plan_item_ids. Legacy `implements` links are
 * retained because they are the reconciliation substrate for rows predating the
 * column/payload stamps.
 */
const DEPENDENCY_TRAVERSAL_SQL = String.raw`
WITH RECURSIVE
raw_plan_nodes AS (
  SELECT 0 AS source_rank,
         'plan_item:' || pi.plan_slug || '#' || pi.item_id AS node_key,
         pi.plan_slug,
         pi.item_id,
         pi.status,
         pi.item_text AS title,
         pi.blocked_by
    FROM harness_shared.plan_items pi
   WHERE pi.workspace_id = $1 AND pi.harness_slug = $2
  UNION ALL
  SELECT 1 AS source_rank,
         'plan_item:' || hp.plan_slug || '#' || (item ->> 'id') AS node_key,
         hp.plan_slug,
         item ->> 'id' AS item_id,
         COALESCE(NULLIF(item ->> 'status', ''), 'todo') AS status,
         COALESCE(item ->> 'text', '') AS title,
         COALESCE(
           ARRAY(SELECT jsonb_array_elements_text(COALESCE(item -> 'blockedBy', '[]'::jsonb))),
           ARRAY[]::text[]
         ) AS blocked_by
    FROM harness_shared.harness_plans hp
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(hp.items, '[]'::jsonb)) AS item
   WHERE hp.workspace_id = $1 AND hp.harness_slug = $2
     AND item ->> 'id' ~ '^P-[0-9]{3,}$'
),
plan_nodes AS (
  SELECT DISTINCT ON (node_key)
         node_key, plan_slug, item_id, status, title, blocked_by
    FROM raw_plan_nodes
   ORDER BY node_key, source_rank
),
work_nodes AS (
  SELECT 'work_item:' || upper(wi.feature_id) AS node_key,
         upper(wi.feature_id) AS item_id,
         wi.status,
         COALESCE(wi.title, wi.summary, wi.feature_id) AS title,
         wi.harness_slug,
         wi.item_kind,
         wi.payload,
         wi.source_plan_slug,
         wi.source_plan_item_ids,
         CASE WHEN wi.item_kind = ANY($7::text[]) THEN 'issue' ELSE 'feature' END AS endpoint_kind,
         CASE WHEN wi.item_kind = ANY($7::text[])
              THEN upper(wi.feature_id)
              ELSE wi.harness_slug || '#' || upper(wi.feature_id)
          END AS endpoint_ref
    FROM harness_shared.work_items wi
   WHERE wi.workspace_id = $1 AND wi.harness_slug = $2
),
plan_edges AS (
  SELECT 'plan-blocks:' || blocked.plan_slug || '#' || blocked.item_id || '<-' || blocker_id AS edge_key,
         blocked.node_key AS subject_key,
         'plan_item:' || blocked.plan_slug || '#' || blocker_id AS dependency_key,
         'plan-blocks'::text AS relation,
         NULL::text AS external_ref
    FROM plan_nodes blocked
   CROSS JOIN LATERAL unnest(blocked.blocked_by) AS blocker_id
),
column_coverage AS (
  SELECT DISTINCT
         'coverage:column:' || pn.plan_slug || '#' || pn.item_id || '<->' || wn.item_id AS edge_key,
         pn.node_key AS subject_key,
         wn.node_key AS dependency_key,
         'coverage'::text AS relation,
         NULL::text AS external_ref
    FROM work_nodes wn
   CROSS JOIN LATERAL (
     SELECT COALESCE(
              NULLIF(btrim(wn.payload -> 'plan_item' ->> 'plan_slug'), ''),
              NULLIF(btrim(wn.source_plan_slug), '')
            ) AS plan_slug,
            ARRAY(
              SELECT DISTINCT candidate
                FROM unnest(
                  ARRAY_REMOVE(
                    ARRAY[
                      CASE
                        WHEN wn.payload -> 'plan_item' ->> 'item_id' ~ '^P-[0-9]{3,}$'
                        THEN wn.payload -> 'plan_item' ->> 'item_id'
                        ELSE NULL
                      END
                    ],
                    NULL
                  ) || COALESCE(wn.source_plan_item_ids, ARRAY[]::text[])
                ) AS candidate
               WHERE candidate ~ '^P-[0-9]{3,}$'
            ) AS item_ids
   ) stamp
    JOIN plan_nodes pn
      ON pn.plan_slug = stamp.plan_slug AND pn.item_id = ANY(stamp.item_ids)
),
link_coverage AS (
  SELECT DISTINCT
         'coverage:link:' || pn.plan_slug || '#' || pn.item_id || '<->' || wn.item_id AS edge_key,
         pn.node_key AS subject_key,
         wn.node_key AS dependency_key,
         'coverage'::text AS relation,
         NULL::text AS external_ref
    FROM harness_shared.coord_links link
    JOIN work_nodes wn
      ON wn.endpoint_kind = link.src_kind AND wn.endpoint_ref = link.src_ref
    JOIN plan_nodes pn
      ON pn.plan_slug || '#' || pn.item_id = link.dst_ref
   WHERE link.workspace_id IN ($1, $3)
     AND link.rel = 'implements' AND link.dst_kind = 'plan_item'
),
coverage_edges AS (
  SELECT DISTINCT ON (subject_key, dependency_key)
         edge_key, subject_key, dependency_key, relation, external_ref
    FROM (
      SELECT * FROM column_coverage
      UNION ALL
      SELECT * FROM link_coverage
    ) coverage
   ORDER BY subject_key, dependency_key, edge_key
),
work_edges AS (
  SELECT 'work-item-blocks:' || dep.blocked_kind || ':' || dep.blocked_ref || '<-' ||
         dep.blocker_kind || ':' || dep.blocker_ref AS edge_key,
         COALESCE(blocked.node_key, 'dependency:' || dep.blocked_kind || ':' || dep.blocked_ref) AS subject_key,
         COALESCE(blocker.node_key, 'dependency:' || dep.blocker_kind || ':' || dep.blocker_ref) AS dependency_key,
         'work-item-blocks'::text AS relation,
         NULL::text AS external_ref
    FROM harness_shared.work_item_deps dep
    LEFT JOIN work_nodes blocked
      ON blocked.endpoint_kind = dep.blocked_kind AND blocked.endpoint_ref = dep.blocked_ref
    LEFT JOIN work_nodes blocker
      ON blocker.endpoint_kind = dep.blocker_kind AND blocker.endpoint_ref = dep.blocker_ref
   WHERE dep.workspace_id = $3 AND dep.dep_type = 'blocks'
),
external_edge_data AS (
  SELECT wn.node_key AS subject_key,
         blocker ->> 'ref' AS external_ref,
         substring(upper(blocker ->> 'ref') from '(WI-[0-9]+|EI-[0-9]+|F-[0-9]+)') AS work_item_id,
         blocker ->> 'kind' AS blocker_kind
    FROM work_nodes wn
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE
       WHEN jsonb_typeof(wn.payload -> 'externalBlockers') = 'array'
       THEN wn.payload -> 'externalBlockers'
       ELSE '[]'::jsonb
     END
   ) AS blocker
   WHERE blocker ->> 'status' = 'active'
     AND blocker ->> 'ref' <> ''
),
external_edges AS (
  SELECT 'external-blocker:' || data.subject_key || '<-' || data.external_ref AS edge_key,
         data.subject_key,
         COALESCE(target.node_key, 'external:' || COALESCE(NULLIF(data.blocker_kind, ''), 'unknown') || ':' || data.external_ref) AS dependency_key,
         'external-blocker'::text AS relation,
         data.external_ref
    FROM external_edge_data data
    LEFT JOIN work_nodes target ON target.item_id = data.work_item_id
),
all_edges AS (
  SELECT * FROM plan_edges
  UNION ALL SELECT * FROM work_edges
  UNION ALL SELECT * FROM coverage_edges
  UNION ALL SELECT * FROM external_edges
),
placeholder_nodes AS (
  SELECT DISTINCT edge_key AS node_key,
         CASE WHEN edge_key LIKE 'external:%' THEN 'external' ELSE 'plan_item' END AS node_kind,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '#(P-[0-9]+)$')
              ELSE regexp_replace(edge_key, '^[^:]+:[^:]*:', '')
          END AS ref,
         NULL::text AS status,
         NULL::text AS title,
         NULL::text AS harness_slug,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '^plan_item:(.*)#P-[0-9]+$')
              ELSE NULL
          END AS plan_slug,
         CASE WHEN edge_key LIKE 'plan_item:%#%'
              THEN substring(edge_key from '#(P-[0-9]+)$')
              ELSE NULL
          END AS item_id
    FROM (
      SELECT subject_key AS edge_key FROM all_edges
      UNION
      SELECT dependency_key AS edge_key FROM all_edges
    ) edge_keys
   WHERE NOT EXISTS (SELECT 1 FROM plan_nodes pn WHERE pn.node_key = edge_key)
     AND NOT EXISTS (SELECT 1 FROM work_nodes wn WHERE wn.node_key = edge_key)
),
all_nodes AS (
  SELECT pn.node_key, 'plan_item'::text AS node_kind, pn.item_id AS ref,
         pn.status, pn.title, $2::text AS harness_slug, pn.plan_slug, pn.item_id
    FROM plan_nodes pn
  UNION ALL
  SELECT wn.node_key, 'work_item'::text AS node_kind, wn.item_id AS ref,
         wn.status, wn.title, wn.harness_slug, NULL::text AS plan_slug, wn.item_id
    FROM work_nodes wn
  UNION ALL
  SELECT placeholder.node_key, placeholder.node_kind, placeholder.ref,
         placeholder.status, placeholder.title, placeholder.harness_slug,
         placeholder.plan_slug, placeholder.item_id
    FROM placeholder_nodes placeholder
),
walk AS (
  SELECT $4::text AS node_key,
         0 AS depth,
         ARRAY[$4::text] AS path,
         NULL::text AS edge_key,
         NULL::text AS subject_key,
         NULL::text AS dependency_key,
         NULL::text AS relation,
         NULL::text AS external_ref
  UNION ALL
  SELECT next_step.next_key,
         walk.depth + 1,
         walk.path || next_step.next_key,
         next_step.edge_key,
         next_step.subject_key,
         next_step.dependency_key,
         next_step.relation,
         next_step.external_ref
    FROM walk
    JOIN LATERAL (
      SELECT edge.edge_key, edge.subject_key, edge.dependency_key,
             edge.relation, edge.external_ref,
             CASE
               WHEN edge.relation = 'coverage' AND edge.subject_key = walk.node_key
                 THEN edge.dependency_key
               WHEN edge.relation = 'coverage' AND edge.dependency_key = walk.node_key
                 THEN edge.subject_key
               WHEN $5 = 'blockers' AND edge.subject_key = walk.node_key
                 THEN edge.dependency_key
               WHEN $5 = 'blocked' AND edge.dependency_key = walk.node_key
                 THEN edge.subject_key
             END AS next_key
        FROM all_edges edge
       WHERE (edge.relation = 'coverage' AND walk.node_key IN (edge.subject_key, edge.dependency_key))
          OR ($5 = 'blockers' AND edge.subject_key = walk.node_key)
          OR ($5 = 'blocked' AND edge.dependency_key = walk.node_key)
    ) next_step ON next_step.next_key IS NOT NULL
   WHERE walk.depth < $6
     AND NOT next_step.next_key = ANY(walk.path)
)
SELECT node.node_key,
       node.node_kind,
       node.ref,
       node.status,
       node.title,
       node.harness_slug,
       node.plan_slug,
       node.item_id,
       walk.depth,
       walk.edge_key,
       walk.subject_key,
       walk.dependency_key,
       walk.relation,
       walk.external_ref,
       (walk.depth = $6 AND EXISTS (
         SELECT 1 FROM all_edges edge
          WHERE (edge.relation = 'coverage' AND walk.node_key IN (edge.subject_key, edge.dependency_key))
             OR ($5 = 'blockers' AND edge.subject_key = walk.node_key)
             OR ($5 = 'blocked' AND edge.dependency_key = walk.node_key)
       )) AS hit_depth_limit
  FROM walk
  JOIN all_nodes node ON node.node_key = walk.node_key
 ORDER BY walk.depth, node.node_key, walk.edge_key NULLS FIRST
`;

export async function traverseDependencies(
  args: {
    workspaceId: string;
    harnessSlug: string;
    start: DependencyTraversalStart;
    direction?: DependencyTraversalDirection;
    maxDepth?: number;
    coordinationWorkspaceId?: string;
  },
  deps: { query?: DependencyTraversalQuery } = {},
): Promise<DependencyTraversalResult> {
  const workspaceId = args.workspaceId.trim();
  const harnessSlug = args.harnessSlug.trim();
  if (!workspaceId || !harnessSlug) throw new Error('dependency traversal requires workspaceId and harnessSlug');
  const startKey = dependencyTraversalStartKey(args.start);
  const direction = args.direction ?? 'blockers';
  const maxDepth = Math.max(1, Math.min(256, Math.floor(args.maxDepth ?? DEFAULT_DEPENDENCY_TRAVERSAL_MAX_DEPTH)));
  const coordinationWorkspaceId = args.coordinationWorkspaceId?.trim() || DEFAULT_COORD_WORKSPACE;
  const query: DependencyTraversalQuery =
    deps.query ??
    ((text, params) => getOrgPg().sql.unsafe<DependencyTraversalRow[]>(text, params as unknown[]));
  const rows = await query(DEPENDENCY_TRAVERSAL_SQL, [
    workspaceId,
    harnessSlug,
    coordinationWorkspaceId,
    startKey,
    direction,
    maxDepth,
    ISSUE_FAMILY_KINDS,
  ]);

  const nodes = new Map<string, DependencyTraversalNode>();
  const edges = new Map<string, DependencyTraversalEdge>();
  let truncated = false;
  for (const row of rows) {
    const depth = Number(row.depth);
    const current = nodes.get(row.node_key);
    if (!current || depth < current.depth) {
      nodes.set(row.node_key, {
        key: row.node_key,
        kind: row.node_kind,
        ref: row.ref,
        status: row.status,
        title: row.title,
        harnessSlug: row.harness_slug,
        planSlug: row.plan_slug,
        itemId: row.item_id,
        depth,
      });
    }
    if (
      row.edge_key &&
      row.subject_key &&
      row.dependency_key &&
      row.relation
    ) {
      edges.set(row.edge_key, {
        key: row.edge_key,
        subjectKey: row.subject_key,
        dependencyKey: row.dependency_key,
        relation: row.relation,
        externalRef: row.external_ref,
      });
    }
    if (row.hit_depth_limit) truncated = true;
  }

  return {
    startKey,
    direction,
    found: nodes.has(startKey),
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key)),
    edges: [...edges.values()].sort((a, b) => a.key.localeCompare(b.key)),
    truncated,
    maxDepth,
  };
}
