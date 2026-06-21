/**
 * code-recipes-store.ts — PG CRUD for agent-authored reusable code:run scripts
 * ("recipes": `harness_shared.code_recipes` + `harness_shared.code_recipe_runs`,
 * migration 349). Canonical store for the code-recipes-2026-06-21 feature; a
 * recipe is just a saved code:run script, captured on a successful run (D-002 /
 * D-012). Recipes are HIVE-scoped (`hive_slug` is the sharing boundary, D-005).
 *
 * Transport-agnostic: every function takes the `sql` handle so the same code
 * serves the code:run capture path's workspace-resolved `getOrgPg()` connection
 * and the integration test's testcontainer handle. Scope is explicit
 * (`hiveSlug` ⇒ the sharing boundary, NULL ⇒ workspace-global); rows are ALWAYS
 * filtered by workspace_id (RLS is defense-in-depth on top). Mirrors
 * saved-prompts-store.ts for style (D-008).
 *
 * Pure PG: no embedding-provider / search dependency here — the caller computes
 * the embedding (a `number[] | null`, 384-dim) and passes it in (Phase-2 dedup
 * rides @papercusp/search over the columns this store writes, D-009).
 *
 * Server-only.
 */
import type postgres from 'postgres';

export interface CodeRecipeRow {
  id: string;
  workspaceId: string;
  hiveSlug: string | null;
  title: string;
  description: string;
  script: string;
  authorRole: string | null;
  toolsUsed: string[];
  runCount: number;
  successCount: number;
  lastRunAt: string | null;
  status: string;
  promotedTool: string | null;
  mergedInto: string | null;
  tags: string[];
  /** True when an embedding is stored; the raw vector itself is not mapped back. */
  hasEmbedding: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCodeRecipeInput {
  /** Stable kebab slug derived from the title (the PRIMARY KEY). */
  id: string;
  workspaceId: string;
  /** Sharing boundary; null ⇒ workspace-global. */
  hiveSlug: string | null;
  title: string;
  description: string;
  script: string;
  authorRole?: string | null;
  toolsUsed?: string[];
  /** title+description embedding (384-dim). null when the embedder was unavailable. */
  embedding?: number[] | null;
  tags?: string[];
  /** The coord ownerId that authored the recipe (first-write attribution). */
  createdBy?: string | null;
}

export interface RecordRecipeRunInput {
  recipeId: string;
  workspaceId: string;
  hiveSlug: string | null;
  /** The coord ownerId that ran it (distinct-agent signal). */
  agentOwner?: string | null;
  agentRole?: string | null;
  success?: boolean;
  /** true when this was a recipes:run of an existing recipe (vs an authored code:run). */
  reused?: boolean;
}

type DbRow = {
  id: string;
  workspace_id: string;
  hive_slug: string | null;
  title: string;
  description: string;
  script: string;
  author_role: string | null;
  tools_used: string[] | null;
  run_count: number | string;
  success_count: number | string;
  last_run_at: Date | string | null;
  status: string;
  promoted_tool: string | null;
  merged_into: string | null;
  tags: string[] | null;
  has_embedding: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asIso = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const asIsoOrNull = (v: Date | string | null): string | null => (v == null ? null : asIso(v));
const asInt = (v: number | string): number => (typeof v === 'number' ? v : parseInt(v, 10));

function mapRow(r: DbRow): CodeRecipeRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    hiveSlug: r.hive_slug,
    title: r.title,
    description: r.description,
    script: r.script,
    authorRole: r.author_role,
    toolsUsed: r.tools_used ?? [],
    runCount: asInt(r.run_count),
    successCount: asInt(r.success_count),
    lastRunAt: asIsoOrNull(r.last_run_at),
    status: r.status,
    promotedTool: r.promoted_tool,
    mergedInto: r.merged_into,
    tags: r.tags ?? [],
    hasEmbedding: r.has_embedding,
    createdBy: r.created_by,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
  };
}

/** SELECT-list shared by every read so `has_embedding` is computed uniformly
 *  (the raw VECTOR is never serialized back into JS — only its presence). */
const SELECT_COLS = (sql: postgres.Sql) => sql`
  id, workspace_id, hive_slug, title, description, script, author_role,
  tools_used, run_count, success_count, last_run_at, status, promoted_tool,
  merged_into, tags, (embedding IS NOT NULL) AS has_embedding,
  created_by, created_at, updated_at
`;

/**
 * Insert a recipe, or update title/description/script/tools/embedding/tags in
 * place for an existing id (the kebab slug). updated_at bumps; run counters and
 * created_by/created_at are PRESERVED on update (they belong to the run-record /
 * first-write paths). Embedding is overwritten only when a non-null vector is
 * supplied — re-running without an available embedder must not WIPE a previously
 * computed embedding.
 */
export async function upsertRecipe(
  sql: postgres.Sql,
  input: UpsertCodeRecipeInput,
): Promise<CodeRecipeRow> {
  // pgvector wants the textual `[1,2,3]` form; null leaves/keeps it unset.
  const embeddingLiteral =
    input.embedding && input.embedding.length > 0 ? `[${input.embedding.join(',')}]` : null;
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.code_recipes
      (id, workspace_id, hive_slug, title, description, script, author_role,
       tools_used, tags, embedding, created_by, updated_at)
    VALUES (
      ${input.id}, ${input.workspaceId}, ${input.hiveSlug}, ${input.title},
      ${input.description}, ${input.script}, ${input.authorRole ?? null},
      ${input.toolsUsed ?? []}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${input.createdBy ?? null}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      hive_slug   = EXCLUDED.hive_slug,
      title       = EXCLUDED.title,
      description = EXCLUDED.description,
      script      = EXCLUDED.script,
      author_role = EXCLUDED.author_role,
      tools_used  = EXCLUDED.tools_used,
      tags        = EXCLUDED.tags,
      -- keep the existing embedding when this write carries none (no embedder)
      embedding   = COALESCE(EXCLUDED.embedding, harness_shared.code_recipes.embedding),
      updated_at  = now()
    RETURNING ${SELECT_COLS(sql)}`;
  return mapRow(rows[0]);
}

/**
 * Record one execution in `code_recipe_runs` AND (same transaction) bump the
 * denormalized counters on the parent `code_recipes` row: run_count +1,
 * success_count +1 when success, last_run_at = now(). The side-table is the
 * source of truth for the Phase-3 distinct-agent + frequency signals; the
 * counters are a cheap-read denormalization (migration 349 header).
 */
export async function recordRecipeRun(
  sql: postgres.Sql,
  input: RecordRecipeRunInput,
): Promise<void> {
  const success = input.success ?? true;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.code_recipe_runs
        (recipe_id, workspace_id, hive_slug, agent_owner, agent_role, success, reused)
      VALUES (
        ${input.recipeId}, ${input.workspaceId}, ${input.hiveSlug},
        ${input.agentOwner ?? null}, ${input.agentRole ?? null},
        ${success}, ${input.reused ?? false}
      )`;
    await tx`
      UPDATE harness_shared.code_recipes
         SET run_count     = run_count + 1,
             success_count = success_count + ${success ? 1 : 0},
             last_run_at   = now()
       WHERE id = ${input.recipeId} AND workspace_id = ${input.workspaceId}`;
  });
}

/** Fetch one recipe by id, scoped to its workspace. Null when absent. */
export async function getRecipe(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<CodeRecipeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
     WHERE workspace_id = ${workspaceId} AND id = ${id}
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * List recipes for a workspace, optionally narrowed to one hive (the sharing
 * boundary). Omitting `hiveSlug` returns the whole workspace; passing it
 * (incl. an explicit null for the workspace-global bucket) filters. Newest-run
 * first, then most-run, so the hot recipes surface (matches the run_count idx).
 */
export async function listRecipes(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { hiveSlug?: string | null } = {},
): Promise<CodeRecipeRow[]> {
  const hasHiveFilter = 'hiveSlug' in opts;
  const rows = hasHiveFilter
    ? opts.hiveSlug == null
      ? await sql<DbRow[]>`
          SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug IS NULL
           ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id`
      : await sql<DbRow[]>`
          SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug = ${opts.hiveSlug}
           ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id`
    : await sql<DbRow[]>`
        SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
         WHERE workspace_id = ${workspaceId}
         ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id`;
  return rows.map(mapRow);
}
