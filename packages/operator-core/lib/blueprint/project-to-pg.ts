/**
 * Blueprint → PG projection — the operator half of the file-read/parse loader
 * (`harness-blueprint-orchestration-2026-06-03` P-002 / D-006 / D-021).
 *
 * The git-canonical `.papercusp/blueprint.yaml` is resolved + validated by the
 * pure loader in `@papercusp/orchestrator/blueprint`; THIS module writes that
 * resolved result into the PG cache (`harness_shared.blueprints`) the interpreter
 * reads, and reads it back. The live-edit "commit → reproject" path (D-007)
 * calls `projectBlueprintToPg` after a commit; the runtime resolver
 * `getEffectiveBlueprint` reads the cache and lazily projects on a miss.
 *
 * NOT the Hyperbee CRDT projector (D-021) — a plain upsert keyed by
 * (workspace_id, harness_slug). Takes an injected `Sql` (the live admin pool),
 * mirroring the gym control-plane, so the routes and the loader share one core.
 */
import { existsSync } from 'node:fs';
import type { Sql } from 'postgres';
import {
  BlueprintSchema,
  blueprintHash,
  loadBlueprintFromFile,
  type Blueprint,
} from '@papercusp/orchestrator/blueprint';

export interface ProjectBlueprintInput {
  workspaceId: string;
  harnessSlug: string;
  blueprint: Blueprint;
  /** Precomputed hash from the loader; recomputed if absent. */
  contentHash?: string;
  sourcePath?: string | null;
  sourceCommit?: string | null;
}

/**
 * Upsert a resolved blueprint into the PG cache. Idempotent on
 * (workspace_id, harness_slug). Returns the content hash written.
 *
 * The jsonb binds as `${JSON.stringify}::text::jsonb` (EI-2 /
 * agent-insights/postgres-js-jsonb-binding) — `sql.json()` throws
 * "string argument … Received an instance of Object" under the getOrgPg
 * runtime pool, which made every lazy projection through that pool (the
 * `system:blueprint-run` resolver) silently fall back to `coding`.
 */
export async function projectBlueprintToPg(
  sql: Sql,
  input: ProjectBlueprintInput,
): Promise<{ contentHash: string }> {
  const contentHash = input.contentHash ?? blueprintHash(input.blueprint);
  await sql`
    INSERT INTO harness_shared.blueprints
      (workspace_id, harness_slug, blueprint_id, version, resolved, content_hash, source_path, source_commit)
    VALUES (
      ${input.workspaceId}, ${input.harnessSlug}, ${input.blueprint.id}, ${input.blueprint.version},
      ${JSON.stringify(input.blueprint)}::text::jsonb, ${contentHash},
      ${input.sourcePath ?? null}, ${input.sourceCommit ?? null}
    )
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
      blueprint_id  = EXCLUDED.blueprint_id,
      version       = EXCLUDED.version,
      resolved      = EXCLUDED.resolved,
      content_hash  = EXCLUDED.content_hash,
      source_path   = EXCLUDED.source_path,
      source_commit = EXCLUDED.source_commit,
      projected_at  = now()
  `;
  return { contentHash };
}

/**
 * Read the cached resolved blueprint, re-validated through the schema (D-021:
 * validate on load — a corrupt cache row never reaches the interpreter). Returns
 * null when no row exists.
 */
export async function readBlueprintFromPg(
  sql: Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<Blueprint | null> {
  const rows = await sql<{ resolved: unknown }[]>`
    SELECT resolved FROM harness_shared.blueprints
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return BlueprintSchema.parse(rows[0].resolved);
}

/** Read just the cached content hash — a cheap drift check (no deserialize). */
export async function readBlueprintHashFromPg(
  sql: Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<string | null> {
  const rows = await sql<{ content_hash: string }[]>`
    SELECT content_hash FROM harness_shared.blueprints
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
    LIMIT 1
  `;
  return rows[0]?.content_hash ?? null;
}

export interface EffectiveBlueprintOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The git-canonical source to load on a cache miss (e.g. `<harnessDir>/.papercusp/blueprint.yaml`). */
  blueprintPath?: string | null;
}

/**
 * Resolve the effective blueprint for a harness: PG cache first; on a miss, load
 * the git-canonical file, project it, and return. Returns null when neither a
 * cache row nor a source file exists (caller falls back to the built-in default).
 */
export async function getEffectiveBlueprint(
  sql: Sql,
  opts: EffectiveBlueprintOpts,
): Promise<Blueprint | null> {
  const cached = await readBlueprintFromPg(sql, opts.workspaceId, opts.harnessSlug);
  if (cached) return cached;
  if (!opts.blueprintPath || !existsSync(opts.blueprintPath)) return null;
  const loaded = loadBlueprintFromFile(opts.blueprintPath);
  await projectBlueprintToPg(sql, {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    blueprint: loaded.blueprint,
    contentHash: loaded.contentHash,
    sourcePath: loaded.sourcePath,
  });
  return loaded.blueprint;
}
