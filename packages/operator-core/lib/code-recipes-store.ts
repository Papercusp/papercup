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
 *  (the raw VECTOR is never serialized back into JS — only its presence).
 *  Accepts a plain Sql OR a TransactionSql so the merge transaction can reuse it. */
const SELECT_COLS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
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

export interface MergeRecipesInput {
  workspaceId: string;
  /** The recipe every duplicate consolidates into. */
  survivorId: string;
  /** Near-duplicate recipe ids to fold into the survivor. */
  duplicateIds: string[];
}

export interface MergeRecipesResult {
  /** The updated survivor (with the duplicates' run/success counts added). */
  survivor: CodeRecipeRow;
  /** The ids actually merged (excludes the survivor itself + ids absent from the workspace). */
  mergedIds: string[];
}

/**
 * Consolidate near-duplicate recipes into a SURVIVOR (the Queen's merge action
 * from her recipe-graduation review, D-015). In ONE transaction, for each
 * duplicate: set `status='merged'`, `merged_into=survivorId`, AND add its
 * run_count/success_count onto the survivor so the consolidated recipe reflects
 * total usage. Idempotent + reversible (a pure status/pointer flip + counter
 * folding) and workspace-scoped — duplicate ids not in the workspace are skipped;
 * a recipe is NEVER merged into itself.
 *
 * Returns the updated survivor plus the ids that were actually merged. Throws if
 * the survivor does not exist in the workspace (nothing to merge INTO).
 */
export async function mergeRecipes(
  sql: postgres.Sql,
  input: MergeRecipesInput,
): Promise<MergeRecipesResult> {
  const { workspaceId, survivorId } = input;
  // De-dupe the request + drop self-merge before touching the DB.
  const requested = [...new Set(input.duplicateIds)].filter((id) => id !== survivorId);

  // postgres-js types `begin`'s return loosely (UnwrapPromiseArray) — cast the
  // structured result back, mirroring agent-governor-pg-store.ts's transact().
  return (await sql.begin(async (tx) => {
    const survivorRows = await tx<DbRow[]>`
      SELECT ${SELECT_COLS(tx)} FROM harness_shared.code_recipes
       WHERE workspace_id = ${workspaceId} AND id = ${survivorId}
       FOR UPDATE`;
    if (!survivorRows[0]) {
      throw new Error(`mergeRecipes: survivor ${survivorId} not found in workspace ${workspaceId}`);
    }

    if (requested.length === 0) {
      return { survivor: mapRow(survivorRows[0]), mergedIds: [] };
    }

    // Mark each duplicate merged, pointing at the survivor, and harvest its
    // counters in the SAME statement. RETURNING the ids confirms which rows
    // actually existed in the workspace (others are silently skipped).
    //
    // IDEMPOTENT: skip a duplicate ALREADY merged into THIS survivor — its
    // counters were folded on the first merge, so re-running must not re-add
    // them (a no-op replay). A duplicate merged into a DIFFERENT survivor, or
    // any non-merged status, is (re)pointed here and its counters folded once.
    const merged = await tx<{ id: string; run_count: number | string; success_count: number | string }[]>`
      UPDATE harness_shared.code_recipes
         SET status      = 'merged',
             merged_into = ${survivorId},
             updated_at  = now()
       WHERE workspace_id = ${workspaceId}
         AND id = ANY(${requested})
         AND id <> ${survivorId}
         AND NOT (status = 'merged' AND merged_into = ${survivorId})
       RETURNING id, run_count, success_count`;

    const mergedIds = merged.map((m) => m.id);
    const addRuns = merged.reduce((sum, m) => sum + asInt(m.run_count), 0);
    const addSuccess = merged.reduce((sum, m) => sum + asInt(m.success_count), 0);

    const updated = await tx<DbRow[]>`
      UPDATE harness_shared.code_recipes
         SET run_count     = run_count + ${addRuns},
             success_count = success_count + ${addSuccess},
             updated_at    = now()
       WHERE workspace_id = ${workspaceId} AND id = ${survivorId}
      RETURNING ${SELECT_COLS(tx)}`;

    return { survivor: mapRow(updated[0]), mergedIds };
  })) as unknown as MergeRecipesResult;
}

export interface SweepRecipesInput {
  workspaceId: string;
  /** Sharing boundary; omit ⇒ the whole workspace, explicit null ⇒ the workspace-global bucket. */
  hiveSlug?: string | null;
  /** Retire active recipes whose last_run_at is older than this (default 30). */
  staleDays?: number;
  /** Only one-offs: run_count at or below this (default 1 — nobody reused it). */
  maxRunCount?: number;
  /** Preview only — return the candidates WITHOUT changing anything (default false). */
  dryRun?: boolean;
}

export interface SweepRecipesResult {
  /** The swept (or, on a dryRun, would-be-swept) recipes. */
  swept: CodeRecipeRow[];
  dryRun: boolean;
}

/**
 * Retire the stale long-tail of never-reused one-off recipes (mirror
 * learning_packs:sweep). Selects ACTIVE recipes whose `last_run_at` is older
 * than `staleDays` AND `run_count <= maxRunCount` (a one-off nobody reused) and
 * — on a real run — flips them to `status='retired'`. A `dryRun` returns the
 * candidates without mutating. NEVER touches a hot recipe (run_count over the
 * cap), a recipe run recently, or a promoted/merged/already-retired one (the
 * `status='active'` filter), so hygiene can't strand a graduated or consolidated
 * recipe. Reversible (a status flip) + workspace-scoped.
 *
 * A recipe with a NULL last_run_at (saved, never run) is NOT swept here — it has
 * no staleness clock yet; it ages in only once it's been run and then idled.
 */
export async function sweepRecipes(
  sql: postgres.Sql,
  input: SweepRecipesInput,
): Promise<SweepRecipesResult> {
  const { workspaceId } = input;
  const staleDays = input.staleDays ?? 30;
  const maxRunCount = input.maxRunCount ?? 1;
  const dryRun = input.dryRun ?? false;
  const hasHiveFilter = 'hiveSlug' in input;

  // The hive narrowing is shared by both the dry-run SELECT and the real UPDATE
  // so the candidate set can never diverge between preview and commit.
  const hiveClause = hasHiveFilter
    ? input.hiveSlug == null
      ? sql`AND hive_slug IS NULL`
      : sql`AND hive_slug = ${input.hiveSlug}`
    : sql``;

  if (dryRun) {
    const rows = await sql<DbRow[]>`
      SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
       WHERE workspace_id = ${workspaceId}
         AND status = 'active'
         AND run_count <= ${maxRunCount}
         AND last_run_at IS NOT NULL
         AND last_run_at < now() - make_interval(days => ${staleDays})
         ${hiveClause}
       ORDER BY last_run_at ASC NULLS LAST, run_count ASC, id`;
    return { swept: rows.map(mapRow), dryRun: true };
  }

  // Real run: retire the candidates and RETURN the retired rows (single
  // statement — selection + mutation are atomic, no select-then-update race).
  const rows = await sql<DbRow[]>`
    UPDATE harness_shared.code_recipes
       SET status = 'retired', updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND status = 'active'
       AND run_count <= ${maxRunCount}
       AND last_run_at IS NOT NULL
       AND last_run_at < now() - make_interval(days => ${staleDays})
       ${hiveClause}
    RETURNING ${SELECT_COLS(sql)}`;
  return { swept: rows.map(mapRow), dryRun: false };
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

/** Default cap on a recipe list read — generous, so a normal hive's whole
 *  corpus comes back, but bounded so a runaway store can't ship 50k rows to the
 *  desktop. Clamped to MAX_LIST_LIMIT. */
export const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 2000;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

/**
 * List recipes for a workspace, optionally narrowed to one hive (the sharing
 * boundary). Omitting `hiveSlug` returns the whole workspace; passing it
 * (incl. an explicit null for the workspace-global bucket) filters. Newest-run
 * first, then most-run, so the hot recipes surface (matches the run_count idx).
 *
 * Capped at `limit` (default {@link DEFAULT_LIST_LIMIT}, clamped to
 * {@link MAX_LIST_LIMIT}) so a large corpus can't flood the sync transport;
 * pair with {@link countRecipes} for the true total (attachListMeta).
 */
export async function listRecipes(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { hiveSlug?: string | null; limit?: number } = {},
): Promise<CodeRecipeRow[]> {
  const lim = clampLimit(opts.limit);
  const hasHiveFilter = 'hiveSlug' in opts;
  const rows = hasHiveFilter
    ? opts.hiveSlug == null
      ? await sql<DbRow[]>`
          SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug IS NULL
           ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id
           LIMIT ${lim}`
      : await sql<DbRow[]>`
          SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug = ${opts.hiveSlug}
           ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id
           LIMIT ${lim}`
    : await sql<DbRow[]>`
        SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
         WHERE workspace_id = ${workspaceId}
         ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id
         LIMIT ${lim}`;
  return rows.map(mapRow);
}

/**
 * Count recipes for a workspace under the SAME hive filter as {@link listRecipes}
 * (the true total, independent of any list LIMIT). Cheap `COUNT(*)` over the
 * run_count index — pair with listRecipes + attachListMeta so the UI shows
 * "N of TOTAL".
 */
export async function countRecipes(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { hiveSlug?: string | null } = {},
): Promise<number> {
  const hasHiveFilter = 'hiveSlug' in opts;
  const rows = hasHiveFilter
    ? opts.hiveSlug == null
      ? await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug IS NULL`
      : await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM harness_shared.code_recipes
           WHERE workspace_id = ${workspaceId} AND hive_slug = ${opts.hiveSlug}`
    : await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.code_recipes
         WHERE workspace_id = ${workspaceId}`;
  return rows[0]?.n ?? 0;
}
