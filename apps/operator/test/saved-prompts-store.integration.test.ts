/**
 * Integration test for saved-prompts-store against a real Postgres.
 * Targets the real `harness_shared.saved_prompts` table (mirrors migration
 * 105's DDL subset + migration 598's organizer columns — no RLS/grants or
 * the change-notify trigger, which need cluster roles/functions). Isolation
 * is by unique workspace ids per test, not a private schema, so it can share
 * the reused testcontainer with other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { withTestSchema } from '@papercusp/test-config/pg';
import {
  listSavedPrompts,
  upsertSavedPrompt,
  removeSavedPrompt,
} from '@papercusp/operator-core/lib/saved-prompts-store';
import {
  materializeWorkspacePrompts,
  materializeCodexPrompts,
} from '@papercusp/operator-core/lib/saved-prompts-materialize';

let sql: postgres.Sql;

const ws = () => `ws-${randomBytes(5).toString('hex')}`;

beforeAll(async () => {
  const handle = await withTestSchema();
  sql = postgres(handle.connectionUri, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.saved_prompts (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL,
      harness_slug text,
      name         text NOT NULL,
      body         text NOT NULL,
      description  text,
      arg_hint     text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS saved_prompts_scope_name
      ON harness_shared.saved_prompts (workspace_id, COALESCE(harness_slug, ''), name)
  `);
  // Organizer columns (migration 598, quick-panel-saved-prompts-2026-07-13) —
  // idempotent ALTERs exactly like the real migration, because the reused
  // testcontainer may already hold the pre-598 table from an earlier run.
  // mapRow() in saved-prompts-store reads these on every RETURNING *.
  await sql.unsafe(`
    ALTER TABLE harness_shared.saved_prompts
      ADD COLUMN IF NOT EXISTS parent_id uuid,
      ADD COLUMN IF NOT EXISTS position text,
      ADD COLUMN IF NOT EXISTS title text,
      ADD COLUMN IF NOT EXISTS collapsed boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
      ADD COLUMN IF NOT EXISTS archived_at timestamptz
  `);
  // Workflowy-style checkoff (migration 606, quick-panel-workflowy-clone-2026-07-14
  // P-001 / WI-4840). NULL = active. mapRow()'s asIsoOrNull(r.completed_at) reads
  // this column on every RETURNING * / SELECT * — omitting it here makes `postgres`
  // hand back `undefined` (no such property) rather than SQL NULL, and
  // asIsoOrNull's `v === null` check does not catch `undefined`, so asIso(undefined)
  // crashes on `.toISOString()`. This mirrors migration 606's DDL exactly.
  await sql.unsafe(`
    ALTER TABLE harness_shared.saved_prompts
      ADD COLUMN IF NOT EXISTS completed_at timestamptz
  `);
  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE harness_shared.saved_prompts
        ADD CONSTRAINT saved_prompts_parent_fk FOREIGN KEY (parent_id)
          REFERENCES harness_shared.saved_prompts(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe('saved-prompts-store', () => {
  it('upserts and lists a workspace-global prompt', async () => {
    const w = ws();
    const row = await upsertSavedPrompt(sql, {
      workspaceId: w,
      scope: { kind: 'workspace' },
      name: 'note',
      body: 'Jot a note.',
      description: 'quick note',
      argHint: '<topic>',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.harnessSlug).toBeNull();
    expect(row.argHint).toBe('<topic>');

    const list = await listSavedPrompts(sql, w, { kind: 'workspace' });
    expect(list.map((r) => r.name)).toEqual(['note']);
  });

  it('scopes harness prompts: a harness prompt is not in the workspace list and vice versa', async () => {
    const w = ws();
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'global', body: 'g' });
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'harness', slug: 'papercup' }, name: 'local', body: 'l' });

    const wsList = await listSavedPrompts(sql, w, { kind: 'workspace' });
    const hList = await listSavedPrompts(sql, w, { kind: 'harness', slug: 'papercup' });
    expect(wsList.map((r) => r.name)).toEqual(['global']);
    expect(hList.map((r) => r.name)).toEqual(['local']);
  });

  it('the same name may exist in both the workspace scope and a harness scope as distinct rows', async () => {
    const w = ws();
    const a = await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'dup', body: 'ws' });
    const b = await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'harness', slug: 'papercup' }, name: 'dup', body: 'hn' });
    expect(a.id).not.toBe(b.id);
  });

  it('upsert updates the body of an existing same-scope name in place (no duplicate row)', async () => {
    const w = ws();
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'edit', body: 'v1' });
    const updated = await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'edit', body: 'v2', description: 'now described' });
    const list = await listSavedPrompts(sql, w, { kind: 'workspace' });
    expect(list).toHaveLength(1);
    expect(updated.body).toBe('v2');
    expect(updated.description).toBe('now described');
  });

  it('isolates workspaces: a list for one workspace never sees another workspace rows', async () => {
    const a = ws();
    const b = ws();
    await upsertSavedPrompt(sql, { workspaceId: a, scope: { kind: 'workspace' }, name: 'only-a', body: 'x' });
    await upsertSavedPrompt(sql, { workspaceId: b, scope: { kind: 'workspace' }, name: 'only-b', body: 'y' });
    expect((await listSavedPrompts(sql, a, { kind: 'workspace' })).map((r) => r.name)).toEqual(['only-a']);
    expect((await listSavedPrompts(sql, b, { kind: 'workspace' })).map((r) => r.name)).toEqual(['only-b']);
  });

  it('removes a prompt and reports whether a row was deleted', async () => {
    const w = ws();
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'temp', body: 'z' });
    expect(await removeSavedPrompt(sql, w, { kind: 'workspace' }, 'temp')).toBe(true);
    expect(await listSavedPrompts(sql, w, { kind: 'workspace' })).toHaveLength(0);
    expect(await removeSavedPrompt(sql, w, { kind: 'workspace' }, 'temp')).toBe(false);
  });
});

describe('saved-prompts-materialize (store → files)', () => {
  it('materializes a workspace scope to Claude command files in the target dir', async () => {
    const w = ws();
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'ship', body: 'do it', description: 'd' });
    const dir = mkdtempSync(join(tmpdir(), 'sp-mat-'));
    const res = await materializeWorkspacePrompts(w, { sql, dir });
    expect(res.written).toBe(1);
    expect(readdirSync(dir)).toEqual(['ship.md']);
    expect(readFileSync(join(dir, 'ship.md'), 'utf8')).toContain('<!-- papercusp:managed -->');
  });

  it('writes workspace + harness prompts into a Codex home prompts/ dir, harness overlaying on name clash', async () => {
    const w = ws();
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'dup', body: 'WS-BODY' });
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'workspace' }, name: 'only-ws', body: 'x' });
    await upsertSavedPrompt(sql, { workspaceId: w, scope: { kind: 'harness', slug: 'papercup' }, name: 'dup', body: 'HARNESS-BODY' });
    const home = mkdtempSync(join(tmpdir(), 'sp-codex-'));
    await materializeCodexPrompts(home, w, 'papercup', { sql });
    const promptsDir = join(home, 'prompts');
    expect(existsSync(join(promptsDir, 'only-ws.md'))).toBe(true);
    expect(readFileSync(join(promptsDir, 'dup.md'), 'utf8')).toContain('HARNESS-BODY');
  });
});
