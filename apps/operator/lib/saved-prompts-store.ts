/**
 * saved-prompts-store.ts — PG CRUD for cross-client saved prompts
 * (`harness_shared.saved_prompts`, migration 105). Canonical store; the
 * on-disk command files are a projection of these rows (D-001).
 *
 * Transport-agnostic: every function takes the `sql` handle so the same
 * code serves a principal-gated tool's `ctx.tx`, the launch path's
 * workspace-resolved `getOrgPg()` connection, and the integration test's
 * testcontainer handle. Scope is explicit (`workspace` ⇒ harness_slug
 * NULL; `harness` ⇒ harness_slug = slug); rows are always filtered by
 * workspace_id (RLS is defense-in-depth on top).
 *
 * Server-only.
 */
import type postgres from 'postgres';

export type PromptScope = { kind: 'workspace' } | { kind: 'harness'; slug: string };

export interface SavedPromptRow {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  name: string;
  body: string;
  description: string | null;
  argHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSavedPromptInput {
  workspaceId: string;
  scope: PromptScope;
  name: string;
  body: string;
  description?: string | null;
  argHint?: string | null;
}

type DbRow = {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  name: string;
  body: string;
  description: string | null;
  arg_hint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asIso = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());

function mapRow(r: DbRow): SavedPromptRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    name: r.name,
    body: r.body,
    description: r.description,
    argHint: r.arg_hint,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
  };
}

/** List the prompts for exactly one scope (workspace-global, or a single harness). */
export async function listSavedPrompts(
  sql: postgres.Sql,
  workspaceId: string,
  scope: PromptScope,
): Promise<SavedPromptRow[]> {
  const rows =
    scope.kind === 'harness'
      ? await sql<DbRow[]>`
          SELECT * FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${scope.slug}
           ORDER BY name`
      : await sql<DbRow[]>`
          SELECT * FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug IS NULL
           ORDER BY name`;
  return rows.map(mapRow);
}

/** Insert a prompt, or update body/description/arg_hint in place for an existing same-scope name. */
export async function upsertSavedPrompt(
  sql: postgres.Sql,
  input: UpsertSavedPromptInput,
): Promise<SavedPromptRow> {
  const slug = input.scope.kind === 'harness' ? input.scope.slug : null;
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.saved_prompts
      (workspace_id, harness_slug, name, body, description, arg_hint, updated_at)
    VALUES (
      ${input.workspaceId}, ${slug}, ${input.name}, ${input.body},
      ${input.description ?? null}, ${input.argHint ?? null}, now()
    )
    ON CONFLICT (workspace_id, COALESCE(harness_slug, ''), name)
    DO UPDATE SET body = EXCLUDED.body,
                  description = EXCLUDED.description,
                  arg_hint = EXCLUDED.arg_hint,
                  updated_at = now()
    RETURNING *`;
  return mapRow(rows[0]);
}

/** Delete one prompt by scope + name; returns true iff a row was removed. */
export async function removeSavedPrompt(
  sql: postgres.Sql,
  workspaceId: string,
  scope: PromptScope,
  name: string,
): Promise<boolean> {
  const res =
    scope.kind === 'harness'
      ? await sql`
          DELETE FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${scope.slug} AND name = ${name}`
      : await sql`
          DELETE FROM harness_shared.saved_prompts
           WHERE workspace_id = ${workspaceId} AND harness_slug IS NULL AND name = ${name}`;
  return res.count > 0;
}
