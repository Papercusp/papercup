/**
 * Work-item admission census + shard planner.
 *
 * This is the deterministic P-001 runtime for
 * `work-queue-admission-and-bulk-dedup-2026-08-24`.  It extends the existing
 * work-item admission substrate instead of inventing a parallel queue:
 *
 * - the corpus is every non-terminal, non-observation work item in one
 *   workspace/harness;
 * - cosine edges >= 0.85 are recomputed into migration 944's `dedup_edges`;
 * - >= 0.90 edges form hard components, while cross-shard edges become capped
 *   read-only ghost context (D-006);
 * - the census counts only >= 0.90 pairs with NO adjudication (D-001);
 * - every run writes the owner-inspectable `admission_runs` ledger and an exact
 *   member-coverage assertion before any later model call can consume a shard.
 *
 * `buildAdmissionShardPlan` is pure and deliberately exported.  The live runner
 * and the real-PG guard exercise the same planner, so deterministic packing and
 * coverage are not claims inferred from a query shape.
 */
import { createHash, randomUUID } from 'node:crypto';
import { clusterPairs, type OverlapPair } from '@papercusp/overlap-clusters';
import { getOrgPg } from '@papercusp/db-org';
import { ALL_TERMINAL_STATUSES } from './work-item-blocking';
import type { OrgSql } from './work-items';

export const ADMISSION_EDGE_FLOOR = 0.85;
export const ADMISSION_COMPONENT_FLOOR = 0.9;
export const DEFAULT_SHARD_TARGET_TOKENS = 300_000;
export const DEFAULT_SHARD_CEILING_TOKENS = 1_000_000;
export const DEFAULT_GHOST_FRACTION = 0.15;
export const DEFAULT_EDGE_SCAN_CHUNKS = 16;
export const TEXT_CONTEXT_TRGM_FLOOR = 0.45;
export const TEXT_CONTEXT_NEIGHBOURS = 20;

export type AdmissionOriginClass = 'machine-emitter' | 'ideation' | 'agent-filed';

export interface AdmissionCensusItem {
  id: string;
  title: string;
  summary: string;
  estimatedTokens: number;
  originClass: AdmissionOriginClass;
  hasEmbedding: boolean;
  embeddingMode: string | null;
}

export interface AdmissionCensusEdge {
  a: string;
  b: string;
  similarity: number;
  trgm?: number | null;
  source: 'cosine' | 'text';
  /** Exact text identity is a hard component edge even without an embedding. */
  hard?: boolean;
}

export interface AdmissionShard {
  shardId: number;
  members: string[];
  ghosts: string[];
  memberTokens: number;
  ghostTokens: number;
}

export interface AdmissionMergeProjection {
  byPairClass: Record<string, number>;
  componentCollapseUpperBound: Record<string, number>;
  outsideMachineEmitterPairs: number;
  recommendedBulkScope: 'full-corpus' | 'machine-emitter-targeted';
  basis: string;
}

export interface AdmissionShardPlan {
  shards: AdmissionShard[];
  corpusSize: number;
  memberRows: number;
  ghostRows: number;
  ghostCandidatesDropped: number;
  splitOversizedComponents: number;
  fingerprint: string;
  projection: AdmissionMergeProjection;
}

export interface AdmissionShardConfig {
  targetTokens?: number;
  ceilingTokens?: number;
  ghostFraction?: number;
  fullCorpusPairThreshold?: number;
}

interface MutableShard {
  shardId: number;
  members: Set<string>;
  ghosts: Set<string>;
  memberTokens: number;
  ghostTokens: number;
}

function canonicalEdge(edge: AdmissionCensusEdge): AdmissionCensusEdge {
  return edge.a < edge.b ? edge : { ...edge, a: edge.b, b: edge.a };
}

function stableEdges(edges: readonly AdmissionCensusEdge[]): AdmissionCensusEdge[] {
  const byPair = new Map<string, AdmissionCensusEdge>();
  for (const raw of edges) {
    if (!raw.a || !raw.b || raw.a === raw.b || !Number.isFinite(raw.similarity)) continue;
    const edge = canonicalEdge(raw);
    const key = `${edge.a}\0${edge.b}`;
    const prior = byPair.get(key);
    if (!prior || edge.similarity > prior.similarity || (edge.hard === true && prior.hard !== true)) {
      byPair.set(key, edge);
    }
  }
  return [...byPair.values()].sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
}

function overlapPairs(edges: readonly AdmissionCensusEdge[], ids: ReadonlySet<string>, floor: number): OverlapPair[] {
  return edges
    .filter((edge) => ids.has(edge.a) && ids.has(edge.b) && (edge.hard === true || edge.similarity >= floor))
    .map((edge) => ({
      a: edge.a,
      b: edge.b,
      groupA: edge.a,
      groupB: edge.b,
      similarity: edge.similarity,
    }));
}

function componentsFor(ids: readonly string[], edges: readonly AdmissionCensusEdge[], floor: number): string[][] {
  const idSet = new Set(ids);
  const clustered = clusterPairs(overlapPairs(edges, idSet, floor)).map((cluster) => [...cluster.ids].sort());
  const seen = new Set(clustered.flat());
  for (const id of [...ids].sort()) if (!seen.has(id)) clustered.push([id]);
  return clustered.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function sumTokens(ids: readonly string[], items: ReadonlyMap<string, AdmissionCensusItem>): number {
  return ids.reduce((sum, id) => sum + items.get(id)!.estimatedTokens, 0);
}

function splitOversized(
  component: readonly string[],
  edges: readonly AdmissionCensusEdge[],
  items: ReadonlyMap<string, AdmissionCensusItem>,
  targetTokens: number,
): { parts: string[][]; split: boolean } {
  if (sumTokens(component, items) <= targetTokens) return { parts: [[...component].sort()], split: false };

  // D-006's escape hatch: raise the hard threshold inside only the giant
  // component.  Severed edges remain available to the ghost pass below.
  for (const floor of [0.92, 0.94, 0.96, 0.98, 1]) {
    const parts = componentsFor(
      component,
      edges.filter((edge) => edge.hard !== true),
      floor,
    );
    if (parts.length > 1 && parts.every((part) => sumTokens(part, items) <= targetTokens)) {
      return { parts, split: true };
    }
  }

  // Exact-identity or identical-vector groups can remain connected at 1.0.  A
  // deterministic token-bounded split is the final escape hatch; every severed
  // edge still competes for ghost context, and the report records the split.
  const sorted = [...component].sort(
    (a, b) => items.get(b)!.estimatedTokens - items.get(a)!.estimatedTokens || a.localeCompare(b),
  );
  const parts: string[][] = [];
  const loads: number[] = [];
  for (const id of sorted) {
    const tokens = items.get(id)!.estimatedTokens;
    let slot = loads.findIndex((load) => load + tokens <= targetTokens);
    if (slot < 0) {
      slot = parts.length;
      parts.push([]);
      loads.push(0);
    }
    parts[slot]!.push(id);
    loads[slot] = loads[slot]! + tokens;
  }
  return { parts: parts.map((part) => part.sort()), split: true };
}

function projectionFor(
  items: ReadonlyMap<string, AdmissionCensusItem>,
  unadjudicated: readonly AdmissionCensusEdge[],
  fullCorpusPairThreshold: number,
): AdmissionMergeProjection {
  const byPairClass: Record<string, number> = {};
  let outsideMachineEmitterPairs = 0;
  for (const edge of unadjudicated) {
    const ca = items.get(edge.a)?.originClass ?? 'agent-filed';
    const cb = items.get(edge.b)?.originClass ?? 'agent-filed';
    const key = [ca, cb].sort().join(' × ');
    byPairClass[key] = (byPairClass[key] ?? 0) + 1;
    if (ca !== 'machine-emitter' || cb !== 'machine-emitter') outsideMachineEmitterPairs += 1;
  }

  const componentCollapseUpperBound: Record<string, number> = {};
  const ids = new Set([...unadjudicated.flatMap((edge) => [edge.a, edge.b])]);
  for (const component of componentsFor([...ids], unadjudicated, ADMISSION_COMPONENT_FLOOR).filter(
    (c) => c.length > 1,
  )) {
    const classes = [...new Set(component.map((id) => items.get(id)?.originClass ?? 'agent-filed'))].sort();
    const key = classes.length === 1 ? classes[0]! : `mixed:${classes.join('+')}`;
    componentCollapseUpperBound[key] = (componentCollapseUpperBound[key] ?? 0) + component.length - 1;
  }

  return {
    byPairClass,
    componentCollapseUpperBound,
    outsideMachineEmitterPairs,
    recommendedBulkScope:
      outsideMachineEmitterPairs > fullCorpusPairThreshold ? 'full-corpus' : 'machine-emitter-targeted',
    basis:
      'Unadjudicated >=0.90 pair counts plus connected-component collapse upper bounds; no model verdict is assumed. D-002 uses >150 outside-machine pairs as the working full-corpus threshold.',
  };
}

export function buildAdmissionShardPlan(
  rawItems: readonly AdmissionCensusItem[],
  rawEdges: readonly AdmissionCensusEdge[],
  unadjudicatedEdges: readonly AdmissionCensusEdge[] = rawEdges,
  config: AdmissionShardConfig = {},
): AdmissionShardPlan {
  const targetTokens = Math.max(1, Math.floor(config.targetTokens ?? DEFAULT_SHARD_TARGET_TOKENS));
  const ceilingTokens = Math.max(targetTokens, Math.floor(config.ceilingTokens ?? DEFAULT_SHARD_CEILING_TOKENS));
  const ghostFraction = config.ghostFraction ?? DEFAULT_GHOST_FRACTION;
  if (!(ghostFraction >= 0 && ghostFraction <= 1)) throw new Error('ghostFraction must be in [0,1]');

  const items = new Map<string, AdmissionCensusItem>();
  for (const item of rawItems) {
    if (!item.id) throw new Error('census item id is blank');
    if (items.has(item.id)) throw new Error(`duplicate census item id: ${item.id}`);
    if (!Number.isFinite(item.estimatedTokens) || item.estimatedTokens < 1) {
      throw new Error(`invalid token estimate for ${item.id}`);
    }
    if (item.estimatedTokens > ceilingTokens) {
      throw new Error(`item ${item.id} exceeds the ${ceilingTokens}-token shard ceiling`);
    }
    items.set(item.id, item);
  }

  const edges = stableEdges(rawEdges).filter((edge) => items.has(edge.a) && items.has(edge.b));
  const hardEdges = edges.filter((edge) => edge.hard === true || edge.similarity >= ADMISSION_COMPONENT_FLOOR);
  const baseComponents = componentsFor([...items.keys()], hardEdges, ADMISSION_COMPONENT_FLOOR);
  const components: string[][] = [];
  let splitOversizedComponents = 0;
  for (const component of baseComponents) {
    const split = splitOversized(component, hardEdges, items, targetTokens);
    components.push(...split.parts);
    if (split.split) splitOversizedComponents += 1;
  }
  components.sort((a, b) => sumTokens(b, items) - sumTokens(a, items) || a[0]!.localeCompare(b[0]!));

  const adjacency = new Map<string, Array<{ other: string; similarity: number }>>();
  for (const edge of edges) {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), { other: edge.b, similarity: edge.similarity }]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), { other: edge.a, similarity: edge.similarity }]);
  }

  const shards: MutableShard[] = [];
  const home = new Map<string, number>();
  for (const component of components) {
    const tokens = sumTokens(component, items);
    const scores = new Map<number, number>();
    for (const id of component) {
      for (const edge of adjacency.get(id) ?? []) {
        const shardId = home.get(edge.other);
        if (shardId !== undefined) scores.set(shardId, (scores.get(shardId) ?? 0) + edge.similarity);
      }
    }
    const candidates = shards
      .filter((shard) => shard.memberTokens + tokens <= targetTokens)
      .sort(
        (a, b) =>
          (scores.get(b.shardId) ?? 0) - (scores.get(a.shardId) ?? 0) ||
          a.memberTokens - b.memberTokens ||
          a.shardId - b.shardId,
      );
    const shard =
      candidates[0] ??
      (() => {
        const next: MutableShard = {
          shardId: shards.length,
          members: new Set<string>(),
          ghosts: new Set<string>(),
          memberTokens: 0,
          ghostTokens: 0,
        };
        shards.push(next);
        return next;
      })();
    for (const id of component) {
      shard.members.add(id);
      shard.memberTokens += items.get(id)!.estimatedTokens;
      home.set(id, shard.shardId);
    }
  }

  const ghostCandidates = new Map<number, Map<string, { similarity: number; tokens: number }>>();
  for (const edge of edges) {
    const homeA = home.get(edge.a)!;
    const homeB = home.get(edge.b)!;
    if (homeA === homeB) continue;
    const itemA = items.get(edge.a)!;
    const itemB = items.get(edge.b)!;
    const ghostId =
      itemA.estimatedTokens < itemB.estimatedTokens ||
      (itemA.estimatedTokens === itemB.estimatedTokens && edge.a.localeCompare(edge.b) < 0)
        ? edge.a
        : edge.b;
    const destination = ghostId === edge.a ? homeB : homeA;
    const byItem = ghostCandidates.get(destination) ?? new Map<string, { similarity: number; tokens: number }>();
    const prior = byItem.get(ghostId);
    if (!prior || edge.similarity > prior.similarity) {
      byItem.set(ghostId, { similarity: edge.similarity, tokens: items.get(ghostId)!.estimatedTokens });
    }
    ghostCandidates.set(destination, byItem);
  }

  const ghostBudget = Math.floor(targetTokens * ghostFraction);
  let ghostCandidatesDropped = 0;
  for (const shard of shards) {
    const candidates = [...(ghostCandidates.get(shard.shardId)?.entries() ?? [])].sort(
      (a, b) => b[1].similarity - a[1].similarity || a[1].tokens - b[1].tokens || a[0].localeCompare(b[0]),
    );
    for (const [id, candidate] of candidates) {
      if (shard.members.has(id) || shard.ghosts.has(id)) continue;
      if (shard.ghostTokens + candidate.tokens > ghostBudget) {
        ghostCandidatesDropped += 1;
        continue;
      }
      shard.ghosts.add(id);
      shard.ghostTokens += candidate.tokens;
    }
  }

  const memberIds = shards.flatMap((shard) => [...shard.members]);
  if (memberIds.length !== rawItems.length || new Set(memberIds).size !== rawItems.length) {
    throw new Error(
      `member coverage mismatch: rows=${memberIds.length}, unique=${new Set(memberIds).size}, corpus=${rawItems.length}`,
    );
  }

  const output = shards.map((shard) => ({
    shardId: shard.shardId,
    members: [...shard.members].sort(),
    ghosts: [...shard.ghosts].sort(),
    memberTokens: shard.memberTokens,
    ghostTokens: shard.ghostTokens,
  }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(output.map((shard) => ({ id: shard.shardId, m: shard.members, g: shard.ghosts }))))
    .digest('hex');

  return {
    shards: output,
    corpusSize: rawItems.length,
    memberRows: memberIds.length,
    ghostRows: output.reduce((sum, shard) => sum + shard.ghosts.length, 0),
    ghostCandidatesDropped,
    splitOversizedComponents,
    fingerprint,
    projection: projectionFor(
      items,
      stableEdges(unadjudicatedEdges).filter((edge) => items.has(edge.a) && items.has(edge.b)),
      config.fullCorpusPairThreshold ?? 150,
    ),
  };
}

interface CorpusDbRow {
  id: string;
  title: string;
  summary: string;
  has_embedding: boolean;
  embedding_mode: string | null;
  condition_key: string | null;
  idea_origin: string | null;
}

interface EdgeDbRow {
  a: string;
  b: string;
  cos: number;
  trgm: number | null;
  adjudicated?: boolean;
}

interface TextEdgeDbRow {
  missing_id: string;
  other_id: string;
  trgm: number;
  exact_key: boolean;
}

export interface AdmissionCensusRunOptions extends AdmissionShardConfig {
  workspaceId: string;
  harnessSlug: string;
  chunkCount?: number;
  runId?: string;
  sql?: OrgSql;
  now?: () => number;
}

export interface AdmissionCensusRunResult extends AdmissionShardPlan {
  runId: string;
  embeddingMode: string | null;
  embeddedItems: number;
  missingEmbeddingItems: number;
  cosineEdges: number;
  hardEdges: number;
  textContextEdges: number;
  censusBefore: number;
  censusAfter: number;
  chunkCoverage: number[];
  latencyMs: number;
}

function classifyOrigin(row: CorpusDbRow): AdmissionOriginClass {
  if (row.condition_key) return 'machine-emitter';
  if (row.idea_origin) return 'ideation';
  return 'agent-filed';
}

function corpusWhere(sql: OrgSql, opts: Pick<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug'>, alias: string) {
  const terminal = [...ALL_TERMINAL_STATUSES];
  const a = sql.unsafe(alias);
  return sql`${a}.workspace_id = ${opts.workspaceId}
    AND ${a}.harness_slug = ${opts.harnessSlug}
    AND ${a}.lane IS DISTINCT FROM 'observation'
    AND (${a}.status IS NULL OR NOT (${a}.status = ANY(${terminal}::text[])))`;
}

async function readCorpus(sql: OrgSql, opts: AdmissionCensusRunOptions): Promise<AdmissionCensusItem[]> {
  const rows = await sql<CorpusDbRow[]>`
    SELECT wi.feature_id AS id,
           COALESCE(wi.title, '') AS title,
           COALESCE(wi.summary, '') AS summary,
           (wi.embedding IS NOT NULL) AS has_embedding,
           wi.embedding_mode,
           wi.condition_key,
           idea.origin AS idea_origin
      FROM harness_shared.work_items wi
      LEFT JOIN LATERAL (
        SELECT sri.origin
          FROM harness_shared.scout_routed_ideas sri
         WHERE sri.workspace_id = wi.workspace_id
           AND sri.harness_slug = wi.harness_slug
           AND sri.routed_ref = wi.feature_id
         ORDER BY sri.routed_at DESC
         LIMIT 1
      ) idea ON TRUE
     WHERE ${corpusWhere(sql, opts, 'wi')}
     ORDER BY wi.feature_id`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    estimatedTokens: Math.max(1, Math.ceil((row.title.length + row.summary.length) / 4)),
    originClass: classifyOrigin(row),
    hasEmbedding: row.has_embedding,
    embeddingMode: row.embedding_mode,
  }));
}

async function readUnadjudicatedCensus(sql: OrgSql, opts: AdmissionCensusRunOptions): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM harness_shared.dedup_edges e
      JOIN harness_shared.work_items wa ON wa.feature_id = e.a
      JOIN harness_shared.work_items wb ON wb.feature_id = e.b
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id
       AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND d.a IS NULL
       AND ${corpusWhere(sql, opts, 'wa')}
       AND ${corpusWhere(sql, opts, 'wb')}`;
  return Number(rows[0]?.n ?? 0);
}

async function scanEdgeChunk(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  mode: string,
  chunkIndex: number,
  chunkCount: number,
): Promise<{ anchors: number; edges: number; hard: number }> {
  const rows = await sql<Array<{ anchors: number; edges: number; hard: number }>>`
    WITH corpus AS MATERIALIZED (
      SELECT wi.feature_id AS id,
             COALESCE(wi.title, '') AS title,
             wi.embedding,
             row_number() OVER (ORDER BY wi.feature_id) AS rn
        FROM harness_shared.work_items wi
       WHERE ${corpusWhere(sql, opts, 'wi')}
         AND wi.embedding IS NOT NULL
         AND wi.embedding_mode = ${mode}
    ), anchors AS MATERIALIZED (
      SELECT * FROM corpus
       WHERE mod((rn - 1)::int, ${chunkCount}) = ${chunkIndex}
    ), pairs AS MATERIALIZED (
      SELECT a.id AS a,
             b.id AS b,
             (1 - (a.embedding <=> b.embedding))::real AS cos,
             similarity(a.title, b.title)::real AS trgm
        FROM anchors a
        JOIN corpus b ON a.id < b.id
    ), written AS (
      INSERT INTO harness_shared.dedup_edges
        (workspace_id, harness_slug, a, b, cos, trgm, run_id, computed_at)
      SELECT ${opts.workspaceId}, ${opts.harnessSlug}, a, b, cos, trgm, ${runId}, clock_timestamp()
        FROM pairs
       WHERE cos >= ${ADMISSION_EDGE_FLOOR}
      ON CONFLICT (workspace_id, harness_slug, a, b) DO UPDATE SET
        cos = EXCLUDED.cos,
        trgm = EXCLUDED.trgm,
        run_id = EXCLUDED.run_id,
        computed_at = EXCLUDED.computed_at
      RETURNING cos
    )
    SELECT (SELECT count(*)::int FROM anchors) AS anchors,
           count(*)::int AS edges,
           count(*) FILTER (WHERE cos >= ${ADMISSION_COMPONENT_FLOOR})::int AS hard
      FROM written`;
  return {
    anchors: Number(rows[0]?.anchors ?? 0),
    edges: Number(rows[0]?.edges ?? 0),
    hard: Number(rows[0]?.hard ?? 0),
  };
}

async function removeStaleEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  mode: string,
  startedAt: string,
): Promise<void> {
  await sql`
    DELETE FROM harness_shared.dedup_edges e
     USING harness_shared.work_items wa, harness_shared.work_items wb
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.a = wa.feature_id
       AND e.b = wb.feature_id
       AND e.run_id <> ${runId}
       AND e.computed_at < ${startedAt}::timestamptz
       AND wa.embedding IS NOT NULL AND wb.embedding IS NOT NULL
       AND wa.embedding_mode = ${mode} AND wb.embedding_mode = ${mode}
       AND ${corpusWhere(sql, opts, 'wa')}
       AND ${corpusWhere(sql, opts, 'wb')}`;
}

async function readCosineEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
): Promise<{ all: AdmissionCensusEdge[]; unadjudicated: AdmissionCensusEdge[]; hard: number }> {
  const hardRows = await sql<EdgeDbRow[]>`
    SELECT e.a, e.b, e.cos, e.trgm, (d.a IS NOT NULL) AS adjudicated
      FROM harness_shared.dedup_edges e
      JOIN harness_shared.work_items wa ON wa.feature_id = e.a
      JOIN harness_shared.work_items wb ON wb.feature_id = e.b
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.run_id = ${runId}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND ${corpusWhere(sql, opts, 'wa')}
       AND ${corpusWhere(sql, opts, 'wb')}
     ORDER BY e.a, e.b`;

  // Ghost context is capped, so reading every one of a dense million-edge soft
  // band would waste memory.  Keep each endpoint's top 20; hard edges are always
  // unioned back in above and therefore never disappear from the planner.
  const softRows = await sql<EdgeDbRow[]>`
    WITH scoped AS MATERIALIZED (
      SELECT e.a, e.b, e.cos, e.trgm
        FROM harness_shared.dedup_edges e
        JOIN harness_shared.work_items wa ON wa.feature_id = e.a
        JOIN harness_shared.work_items wb ON wb.feature_id = e.b
       WHERE e.workspace_id = ${opts.workspaceId}
         AND e.harness_slug = ${opts.harnessSlug}
         AND e.run_id = ${runId}
         AND e.cos >= ${ADMISSION_EDGE_FLOOR}
         AND e.cos < ${ADMISSION_COMPONENT_FLOOR}
         AND ${corpusWhere(sql, opts, 'wa')}
         AND ${corpusWhere(sql, opts, 'wb')}
    ), ranked AS (
      SELECT a, b, cos, trgm,
             row_number() OVER (PARTITION BY a ORDER BY cos DESC, b) AS rn
        FROM scoped
      UNION ALL
      SELECT a, b, cos, trgm,
             row_number() OVER (PARTITION BY b ORDER BY cos DESC, a) AS rn
        FROM scoped
    )
    SELECT a, b, max(cos)::real AS cos, max(trgm)::real AS trgm
      FROM ranked
     WHERE rn <= ${TEXT_CONTEXT_NEIGHBOURS}
     GROUP BY a, b
     ORDER BY a, b`;

  const all = stableEdges([
    ...hardRows.map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    })),
    ...softRows.map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    })),
  ]);
  const unadjudicated = hardRows
    .filter((row) => row.adjudicated !== true)
    .map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    }));
  return { all, unadjudicated, hard: hardRows.length };
}

async function readTextContextEdges(sql: OrgSql, opts: AdmissionCensusRunOptions): Promise<AdmissionCensusEdge[]> {
  const rows = await sql<TextEdgeDbRow[]>`
    WITH corpus AS MATERIALIZED (
      SELECT wi.feature_id AS id,
             COALESCE(wi.title, '') AS title,
             wi.payload #>> '{admissionIdentity,titleKey}' AS title_key,
             wi.embedding
        FROM harness_shared.work_items wi
       WHERE ${corpusWhere(sql, opts, 'wi')}
    ), missing AS MATERIALIZED (
      SELECT * FROM corpus WHERE embedding IS NULL
    )
    SELECT m.id AS missing_id,
           neighbour.id AS other_id,
           neighbour.trgm,
           neighbour.exact_key
      FROM missing m
      JOIN LATERAL (
        SELECT c.id,
               similarity(m.title, c.title)::real AS trgm,
               (m.title_key IS NOT NULL AND m.title_key = c.title_key) AS exact_key
          FROM corpus c
         WHERE c.id <> m.id
         ORDER BY (m.title_key IS NOT NULL AND m.title_key = c.title_key) DESC,
                  similarity(m.title, c.title) DESC,
                  c.id
         LIMIT ${TEXT_CONTEXT_NEIGHBOURS}
      ) neighbour ON neighbour.exact_key OR neighbour.trgm >= ${TEXT_CONTEXT_TRGM_FLOOR}
     ORDER BY m.id, neighbour.exact_key DESC, neighbour.trgm DESC, neighbour.id`;
  return stableEdges(
    rows.map((row) => ({
      a: row.missing_id,
      b: row.other_id,
      similarity: row.exact_key ? 1 : Number(row.trgm),
      trgm: Number(row.trgm),
      source: 'text' as const,
      hard: row.exact_key,
    })),
  );
}

async function persistShardMap(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  plan: AdmissionShardPlan,
): Promise<void> {
  const rows = plan.shards.flatMap((shard) => [
    ...shard.members.map((itemId) => ({
      run_id: runId,
      workspace_id: opts.workspaceId,
      harness_slug: opts.harnessSlug,
      shard_id: shard.shardId,
      item_id: itemId,
      role: 'member',
    })),
    ...shard.ghosts.map((itemId) => ({
      run_id: runId,
      workspace_id: opts.workspaceId,
      harness_slug: opts.harnessSlug,
      shard_id: shard.shardId,
      item_id: itemId,
      role: 'ghost',
    })),
  ]);

  await sql.begin(async (tx) => {
    await tx`DELETE FROM harness_shared.dedup_shard_map WHERE run_id = ${runId}`;
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      const batch = rows.slice(offset, offset + 1_000);
      if (batch.length === 0) continue;
      await tx`
        INSERT INTO harness_shared.dedup_shard_map
          ${tx(batch, 'run_id', 'workspace_id', 'harness_slug', 'shard_id', 'item_id', 'role')}`;
    }
    const coverage = await tx<Array<{ members: number; unique_members: number }>>`
      SELECT count(*) FILTER (WHERE role = 'member')::int AS members,
             count(DISTINCT item_id) FILTER (WHERE role = 'member')::int AS unique_members
        FROM harness_shared.dedup_shard_map
       WHERE run_id = ${runId}`;
    const members = Number(coverage[0]?.members ?? 0);
    const unique = Number(coverage[0]?.unique_members ?? 0);
    if (members !== plan.corpusSize || unique !== plan.corpusSize) {
      throw new Error(
        `persisted member coverage mismatch: rows=${members}, unique=${unique}, corpus=${plan.corpusSize}`,
      );
    }
  });
}

export async function runWorkItemAdmissionCensus(opts: AdmissionCensusRunOptions): Promise<AdmissionCensusRunResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `admission-census-${startedMs}-${randomUUID().slice(0, 8)}`;
  const chunkCount = Math.max(1, Math.floor(opts.chunkCount ?? DEFAULT_EDGE_SCAN_CHUNKS));
  const config = {
    edgeFloor: ADMISSION_EDGE_FLOOR,
    componentFloor: ADMISSION_COMPONENT_FLOOR,
    targetTokens: opts.targetTokens ?? DEFAULT_SHARD_TARGET_TOKENS,
    ceilingTokens: opts.ceilingTokens ?? DEFAULT_SHARD_CEILING_TOKENS,
    ghostFraction: opts.ghostFraction ?? DEFAULT_GHOST_FRACTION,
    chunkCount,
  };

  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, 'census', ${startedAt}::timestamptz,
            ${JSON.stringify({ schemaVersion: 'work-item-admission-census-v1', status: 'running', config })}::text::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      harness_slug = EXCLUDED.harness_slug,
      run_kind = EXCLUDED.run_kind,
      started_at = EXCLUDED.started_at,
      finished_at = NULL,
      detail = EXCLUDED.detail`;

  try {
    const corpus = await readCorpus(sql, opts);
    const embedded = corpus.filter((item) => item.hasEmbedding);
    const modes = [
      ...new Set(embedded.map((item) => item.embeddingMode).filter((mode): mode is string => Boolean(mode))),
    ];
    if (embedded.some((item) => !item.embeddingMode)) {
      throw new Error('embedded work-item rows exist without embedding_mode');
    }
    if (modes.length > 1) throw new Error(`mixed embedding modes in census corpus: ${modes.sort().join(', ')}`);
    const mode = modes[0] ?? null;
    const censusBefore = await readUnadjudicatedCensus(sql, opts);

    const chunkCoverage: number[] = [];
    let cosineEdges = 0;
    let scannedHardEdges = 0;
    if (mode) {
      for (let i = 0; i < chunkCount; i += 1) {
        const result = await scanEdgeChunk(sql, opts, runId, mode, i, chunkCount);
        chunkCoverage.push(result.anchors);
        cosineEdges += result.edges;
        scannedHardEdges += result.hard;
      }
      const covered = chunkCoverage.reduce((sum, n) => sum + n, 0);
      if (covered !== embedded.length) {
        throw new Error(`edge-scan coverage mismatch: chunks=${covered}, embedded=${embedded.length}`);
      }
      await removeStaleEdges(sql, opts, runId, mode, startedAt);
    }

    const [cosine, textContext] = await Promise.all([
      readCosineEdges(sql, opts, runId),
      readTextContextEdges(sql, opts),
    ]);
    if (cosine.hard !== scannedHardEdges) {
      throw new Error(`hard-edge count drift: chunk scan=${scannedHardEdges}, readback=${cosine.hard}`);
    }
    const plan = buildAdmissionShardPlan(corpus, [...cosine.all, ...textContext], cosine.unadjudicated, opts);
    await persistShardMap(sql, opts, runId, plan);
    const censusAfter = await readUnadjudicatedCensus(sql, opts);
    const latencyMs = Math.max(0, now() - startedMs);
    const detail = {
      schemaVersion: 'work-item-admission-census-v1',
      status: 'complete',
      config,
      corpus: {
        size: corpus.length,
        embedded: embedded.length,
        missingEmbedding: corpus.length - embedded.length,
        embeddingMode: mode,
        originClasses: Object.fromEntries(
          (['machine-emitter', 'ideation', 'agent-filed'] as const).map((originClass) => [
            originClass,
            corpus.filter((item) => item.originClass === originClass).length,
          ]),
        ),
      },
      edges: {
        cosine: cosineEdges,
        hard: cosine.hard,
        textContext: textContext.length,
        chunkCoverage,
      },
      shards: {
        count: plan.shards.length,
        memberRows: plan.memberRows,
        ghostRows: plan.ghostRows,
        ghostCandidatesDropped: plan.ghostCandidatesDropped,
        splitOversizedComponents: plan.splitOversizedComponents,
        fingerprint: plan.fingerprint,
        maxMemberTokens: Math.max(0, ...plan.shards.map((shard) => shard.memberTokens)),
        maxGhostTokens: Math.max(0, ...plan.shards.map((shard) => shard.ghostTokens)),
      },
      projection: plan.projection,
      coverageAssertion: {
        expected: corpus.length,
        memberRows: plan.memberRows,
        uniqueMembers: plan.memberRows,
        ok: plan.memberRows === corpus.length,
      },
    };
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(),
             batch_size = ${corpus.length},
             promoted = 0,
             merged = 0,
             held = 0,
             auto_promoted_unreviewed = 0,
             census_before = ${censusBefore},
             census_after = ${censusAfter},
             model_id = NULL,
             tokens_in = 0,
             tokens_out = 0,
             latency_ms = ${latencyMs},
             detail = ${JSON.stringify(detail)}::text::jsonb
       WHERE id = ${runId}`;

    return {
      ...plan,
      runId,
      embeddingMode: mode,
      embeddedItems: embedded.length,
      missingEmbeddingItems: corpus.length - embedded.length,
      cosineEdges,
      hardEdges: cosine.hard,
      textContextEdges: textContext.length,
      censusBefore,
      censusAfter,
      chunkCoverage,
      latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(),
             latency_ms = ${Math.max(0, now() - startedMs)},
             detail = COALESCE(detail, '{}'::jsonb) ||
                      ${JSON.stringify({ status: 'failed', error: message })}::text::jsonb
       WHERE id = ${runId}`.catch(() => undefined);
    throw error;
  }
}
