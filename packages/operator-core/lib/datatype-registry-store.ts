/**
 * datatype-registry-store.ts — PG CRUD for the DATATYPE REGISTRY
 * (`harness_shared.datatype_registry`, migration 421;
 * reflexive-platform-extensibility-datatypes-2026-06-24 P-013).
 *
 * A DATATYPE is a reusable, named entity TYPE declared from inside Papercusp via
 * meta:define-datatype (P-001): the shared shape (`bet`, `wager`, `forecast`,
 * `position`, …) that blueprints reference by name through `dependencies.datatypes`
 * (P-012, D-009). Authority is DEDUP-ONLY (D-010): a hard unique id (the composite
 * PK) + a soft semantic-similarity surface at declaration ({@link findSimilarDatatypes}).
 *
 * WORKSPACE-LOCAL (D-010 local tier): every function takes `workspaceId` and scopes
 * to it (the table's RLS isolates by workspace too). Published/shared datatypes
 * additionally ride the Comb (the `published` flag; the Comb leg is layered later).
 *
 * Transport-agnostic: every function takes the `sql` handle so the same code serves
 * the live `getOrgPg()` connection and an integration test's handle. Pure PG: the
 * caller computes the embedding (a `number[] | null`, 384-dim) and passes it in
 * (dedup rides @papercusp/search over the columns this store writes, D-010).
 *
 * Server-only.
 */
import type postgres from 'postgres';

/** The two-tier datatype model (D-002) + the projection flavor (D-008). */
export const DATATYPE_TIERS = ['generic-kind', 'first-class', 'projection'] as const;
export type DatatypeTier = (typeof DATATYPE_TIERS)[number];
export function isDatatypeTier(t: string): t is DatatypeTier {
  return (DATATYPE_TIERS as readonly string[]).includes(t);
}

/**
 * Derive a stable kebab slug (the datatype id / PK) from a free-text name. Lowercase,
 * non-alphanumerics → single dashes, trimmed. Pure → exhaustively unit-testable.
 * `'Bet Thesis'` → `'bet-thesis'`; `'  P&L  '` → `'p-l'`.
 */
export function slugifyDatatype(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface DatatypeRow {
  id: string;
  workspaceId: string;
  hiveSlug: string | null;
  title: string;
  description: string;
  tier: DatatypeTier;
  /** The registered work_item kind (generic-kind tier; accepted by work_items:create — P-001). */
  workItemKind: string | null;
  /** JSON-Schema shape the kind's payload is validated against. */
  payloadSchema: Record<string, unknown> | null;
  /** 'papercusp' | 'engine:<name>' — projection tier's single writer is external (D-008). */
  authoritativeWriter: string;
  /** The REQUIRED self-improvement surface (P-010): { improvements, scorecard, gym }. */
  selfImprovement: Record<string, unknown> | null;
  status: string;
  published: boolean;
  tags: string[];
  /** True when an embedding is stored; the raw vector itself is not mapped back. */
  hasEmbedding: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDatatypeInput {
  /** Stable kebab slug (the id, unique within the workspace). Derive via {@link slugifyDatatype}. */
  id: string;
  workspaceId: string;
  hiveSlug?: string | null;
  title: string;
  description: string;
  tier: DatatypeTier;
  workItemKind?: string | null;
  payloadSchema?: Record<string, unknown> | null;
  authoritativeWriter?: string | null;
  selfImprovement?: Record<string, unknown> | null;
  published?: boolean;
  tags?: string[];
  /** title+description embedding (384-dim). null when the embedder was unavailable. */
  embedding?: number[] | null;
  createdBy?: string | null;
}

type DbRow = {
  id: string;
  workspace_id: string;
  hive_slug: string | null;
  title: string;
  description: string;
  tier: string;
  work_item_kind: string | null;
  payload_schema: Record<string, unknown> | null;
  authoritative_writer: string;
  self_improvement: Record<string, unknown> | null;
  status: string;
  published: boolean;
  tags: string[] | null;
  has_embedding: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/** JSONB columns come back parsed on some driver configs and as raw text on others
 *  (e.g. the integration fixture's admin client) — normalize to an object|null. */
function parseJsonbMaybe(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function mapRow(r: DbRow): DatatypeRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    hiveSlug: r.hive_slug,
    title: r.title,
    description: r.description,
    tier: (isDatatypeTier(r.tier) ? r.tier : 'generic-kind'),
    workItemKind: r.work_item_kind,
    payloadSchema: parseJsonbMaybe(r.payload_schema),
    authoritativeWriter: r.authoritative_writer,
    selfImprovement: parseJsonbMaybe(r.self_improvement),
    status: r.status,
    published: r.published,
    tags: r.tags ?? [],
    hasEmbedding: r.has_embedding,
    createdBy: r.created_by,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
  };
}

/** SELECT-list shared by every read (the raw VECTOR is never serialized back — only its presence). */
const SELECT_COLS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, workspace_id, hive_slug, title, description, tier, work_item_kind,
  payload_schema, authoritative_writer, self_improvement, status, published, tags,
  (embedding IS NOT NULL) AS has_embedding, created_by, created_at, updated_at
`;

/**
 * Declare a datatype, or update its definition in place for an existing
 * (workspace_id, id). updated_at bumps; created_by/created_at are PRESERVED on
 * update. Embedding is overwritten only when a non-null vector is supplied — a
 * re-declare without an available embedder must not WIPE a previously computed one.
 */
export async function upsertDatatype(
  sql: postgres.Sql,
  input: UpsertDatatypeInput,
): Promise<DatatypeRow> {
  const embeddingLiteral =
    input.embedding && input.embedding.length > 0 ? `[${input.embedding.join(',')}]` : null;
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.datatype_registry
      (id, workspace_id, hive_slug, title, description, tier, work_item_kind,
       payload_schema, authoritative_writer, self_improvement, published, tags,
       embedding, created_by, updated_at)
    VALUES (
      ${input.id}, ${input.workspaceId}, ${input.hiveSlug ?? null}, ${input.title},
      ${input.description}, ${input.tier}, ${input.workItemKind ?? null},
      ${input.payloadSchema ? JSON.stringify(input.payloadSchema) : null}::jsonb,
      ${input.authoritativeWriter ?? 'papercusp'},
      ${input.selfImprovement ? JSON.stringify(input.selfImprovement) : null}::jsonb,
      ${input.published ?? false}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${input.createdBy ?? null}, now()
    )
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      hive_slug            = EXCLUDED.hive_slug,
      title                = EXCLUDED.title,
      description          = EXCLUDED.description,
      tier                 = EXCLUDED.tier,
      work_item_kind       = EXCLUDED.work_item_kind,
      payload_schema       = EXCLUDED.payload_schema,
      authoritative_writer = EXCLUDED.authoritative_writer,
      self_improvement     = EXCLUDED.self_improvement,
      published            = EXCLUDED.published,
      tags                 = EXCLUDED.tags,
      -- keep the existing embedding when this write carries none (no embedder)
      embedding            = COALESCE(EXCLUDED.embedding, harness_shared.datatype_registry.embedding),
      updated_at           = now()
    RETURNING ${SELECT_COLS(sql)}`;
  return mapRow(rows[0]);
}

/** Fetch one datatype by id within a workspace. Null when absent. */
export async function getDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<DatatypeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND id = ${id}
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 2000;
function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

/** List a workspace's datatypes (newest first). Optionally filter by tier / active-only. */
export async function listDatatypes(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { limit?: number; tier?: DatatypeTier; activeOnly?: boolean } = {},
): Promise<DatatypeRow[]> {
  const lim = clampLimit(opts.limit);
  const tierFilter = opts.tier ? sql`AND tier = ${opts.tier}` : sql``;
  const statusFilter = opts.activeOnly === false ? sql`` : sql`AND status = 'active'`;
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} ${tierFilter} ${statusFilter}
     ORDER BY updated_at DESC, id
     LIMIT ${lim}`;
  return rows.map(mapRow);
}

/** Count a workspace's active datatypes. */
export async function countDatatypes(sql: postgres.Sql, workspaceId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'`;
  return rows[0]?.n ?? 0;
}

export interface SimilarDatatype {
  id: string;
  title: string;
  description: string;
  tier: DatatypeTier;
  /** 0..1 — lexical (title_tsv) rank, optionally fused with embedding cosine when a vector is given. */
  score: number;
}

/**
 * The SOFT semantic-dedup surface at declaration (D-010): surface existing datatypes
 * that look like the one being declared, so the caller can prompt "a datatype like
 * this exists: X — reuse or confirm distinct" with a force/moderation path for the
 * ambiguous middle. Lexical leg (title_tsv ⟂ websearch_to_tsquery over title+description)
 * is embedder-independent; when an `embedding` is supplied the cosine leg is fused in.
 * Returns the top matches (excluding `excludeId`), strongest first.
 */
export async function findSimilarDatatypes(
  sql: postgres.Sql,
  workspaceId: string,
  q: { title: string; description?: string; embedding?: number[] | null; excludeId?: string; limit?: number },
): Promise<SimilarDatatype[]> {
  // OR semantics (any shared keyword is a dedup candidate, ranked by ts_rank) — NOT
  // websearch_to_tsquery, which ANDs the words and would miss near-duplicates that
  // share only some terms. Sanitize to alphanumeric tokens (len≥2 drops 'a'/noise)
  // and join with ' | '; the english config stems + drops stopwords.
  const tokens = `${q.title} ${q.description ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const orQuery = tokens.join(' | ');
  const lim = Math.max(1, Math.min(20, q.limit ?? 5));
  const embeddingLiteral =
    q.embedding && q.embedding.length > 0 ? `[${q.embedding.join(',')}]` : null;
  const exclude = q.excludeId ? sql`AND id <> ${q.excludeId}` : sql``;
  // ts_rank for the lexical leg; when an embedding is present, fuse (1 - cosine distance)
  // in 60/40 favour of the vector — the same two-leg shape code_recipes dedup uses.
  const rows = await sql<{ id: string; title: string; description: string; tier: string; score: number }[]>`
    SELECT id, title, description, tier,
      ${
        embeddingLiteral
          ? sql`GREATEST(
                  ts_rank(title_tsv, to_tsquery('english', ${orQuery})),
                  CASE WHEN embedding IS NULL THEN 0
                       ELSE 0.4 * ts_rank(title_tsv, to_tsquery('english', ${orQuery}))
                            + 0.6 * (1 - (embedding <=> ${embeddingLiteral}::vector)) END
                )`
          : sql`ts_rank(title_tsv, to_tsquery('english', ${orQuery}))`
      } AS score
      FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active' ${exclude}
       AND (
         title_tsv @@ to_tsquery('english', ${orQuery})
         ${embeddingLiteral ? sql`OR embedding IS NOT NULL` : sql``}
       )
     ORDER BY score DESC
     LIMIT ${lim}`;
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      tier: (isDatatypeTier(r.tier) ? r.tier : 'generic-kind') as DatatypeTier,
      score: Number(r.score) || 0,
    }))
    .filter((r) => r.score > 0);
}

/**
 * Is `kind` a registered generic-kind datatype in this workspace? The gate
 * work_items:create consults to accept a runtime-registered kind alongside the
 * built-in WORK_ITEM_KINDS (P-001 generic-kind tier).
 */
export async function hasGenericKind(
  sql: postgres.Sql,
  workspaceId: string,
  kind: string,
): Promise<boolean> {
  if (!kind) return false;
  const rows = await sql<{ ok: boolean }[]>`
    SELECT TRUE AS ok FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'
       AND tier = 'generic-kind' AND work_item_kind = ${kind}
     LIMIT 1`;
  return Boolean(rows[0]?.ok);
}

/**
 * The registered generic-kind datatype names for a workspace — feeds the blueprint
 * dependency resolver's `availableDatatypes` host set (P-012) and the work_items
 * kind gate (P-001). Returns the datatype ids (the names blueprints reference).
 */
export async function listRegisteredDatatypeNames(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'`;
  return rows.map((r) => r.id);
}
