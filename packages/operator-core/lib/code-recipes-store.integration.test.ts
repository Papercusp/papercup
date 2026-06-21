/**
 * code-recipes-store.integration.test.ts — the agent-authored reusable code:run
 * recipe CRUD (`harness_shared.code_recipes` + `harness_shared.code_recipe_runs`,
 * migration 349) against real Postgres.
 *
 * Mirrors saved-prompts-store.integration.test.ts: the module is transport-
 * agnostic (every fn TAKES the `sql` handle), so we pass the org-fixture's admin
 * (RLS-bypass) client directly — no db-org mock. Validates: upsert insert→update-
 * in-place by id, run_count/success_count/last_run_at increment via recordRecipeRun
 * (incl. the side-table row), embedding write (has_embedding) + COALESCE-preserve,
 * hive-scoped list filtering, get, and workspace isolation.
 *
 * Part of code-recipes-2026-06-21 Phase 1 (P-002, integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertRecipe,
  recordRecipeRun,
  getRecipe,
  listRecipes,
} from './code-recipes-store';

const { createOrgTestDb } = await import('../test/_org-test-db');

/** A throwaway 384-dim embedding (the store only round-trips presence, not value). */
const fakeEmbedding = (seed = 0.1): number[] => Array.from({ length: 384 }, () => seed);

describe('code_recipes store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('upserts a recipe and reads it back (getRecipe + listRecipes)', async () => {
    const ws = 'ws-cr-basic';
    const row = await upsertRecipe(db.adminSql, {
      id: 'triage-stale-items',
      workspaceId: ws,
      hiveSlug: 'alpha',
      title: 'Triage stale items',
      description: 'list then act per stale work-item',
      script: '// triage\nreturn await tools.work_items.list({});',
      authorRole: 'bee',
      toolsUsed: ['work_items:list'],
      embedding: fakeEmbedding(),
      tags: ['triage'],
      createdBy: 'owner-1',
    });
    expect(row.id).toBe('triage-stale-items');
    expect(row.workspaceId).toBe(ws);
    expect(row.hiveSlug).toBe('alpha');
    expect(row.title).toBe('Triage stale items');
    expect(row.toolsUsed).toEqual(['work_items:list']);
    expect(row.runCount).toBe(0);
    expect(row.successCount).toBe(0);
    expect(row.lastRunAt).toBeNull();
    expect(row.status).toBe('active');
    expect(row.hasEmbedding).toBe(true);
    expect(row.createdBy).toBe('owner-1');
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);

    const got = await getRecipe(db.adminSql, ws, 'triage-stale-items');
    expect(got?.title).toBe('Triage stale items');
    const list = await listRecipes(db.adminSql, ws, { hiveSlug: 'alpha' });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('triage-stale-items');
  });

  it('upsert updates title/description/script/tools in place by id (no duplicate)', async () => {
    const ws = 'ws-cr-upsert';
    const first = await upsertRecipe(db.adminSql, {
      id: 'note',
      workspaceId: ws,
      hiveSlug: null,
      title: 'Note',
      description: 'first',
      script: 'return 1;',
    });
    const second = await upsertRecipe(db.adminSql, {
      id: 'note',
      workspaceId: ws,
      hiveSlug: null,
      title: 'Note v2',
      description: 'second',
      script: 'return 2;',
      toolsUsed: ['coord:send'],
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Note v2');
    expect(second.description).toBe('second');
    expect(second.script).toBe('return 2;');
    expect(second.toolsUsed).toEqual(['coord:send']);
    const list = await listRecipes(db.adminSql, ws);
    expect(list).toHaveLength(1);
  });

  it('upsert PRESERVES an existing embedding when re-run without one', async () => {
    const ws = 'ws-cr-embed';
    await upsertRecipe(db.adminSql, {
      id: 'emb',
      workspaceId: ws,
      hiveSlug: null,
      title: 'Emb',
      description: 'has embedding',
      script: 'return 1;',
      embedding: fakeEmbedding(0.2),
    });
    // re-upsert with embedding omitted (embedder unavailable) — must not wipe it
    const after = await upsertRecipe(db.adminSql, {
      id: 'emb',
      workspaceId: ws,
      hiveSlug: null,
      title: 'Emb',
      description: 'still has embedding',
      script: 'return 2;',
      embedding: null,
    });
    expect(after.hasEmbedding).toBe(true);
  });

  it('recordRecipeRun increments run_count/success_count/last_run_at + writes a run row', async () => {
    const ws = 'ws-cr-runs';
    await upsertRecipe(db.adminSql, {
      id: 'runner',
      workspaceId: ws,
      hiveSlug: 'alpha',
      title: 'Runner',
      description: 'd',
      script: 'return 1;',
    });

    await recordRecipeRun(db.adminSql, {
      recipeId: 'runner',
      workspaceId: ws,
      hiveSlug: 'alpha',
      agentOwner: 'agent-a',
      agentRole: 'bee',
      success: true,
      reused: false,
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'runner',
      workspaceId: ws,
      hiveSlug: 'alpha',
      agentOwner: 'agent-b',
      agentRole: 'su',
      success: false,
    });

    const row = await getRecipe(db.adminSql, ws, 'runner');
    expect(row?.runCount).toBe(2);
    expect(row?.successCount).toBe(1); // only the success bumps it
    expect(row?.lastRunAt).not.toBeNull();

    const runRows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM harness_shared.code_recipe_runs
       WHERE recipe_id = 'runner' AND workspace_id = ${ws}`;
    expect(parseInt(runRows[0].count, 10)).toBe(2);
  });

  it('listRecipes filters by hive (incl. the workspace-global NULL bucket)', async () => {
    const ws = 'ws-cr-hive';
    await upsertRecipe(db.adminSql, { id: 'h1', workspaceId: ws, hiveSlug: 'alpha', title: 'H1', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'h2', workspaceId: ws, hiveSlug: 'beta', title: 'H2', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'g1', workspaceId: ws, hiveSlug: null, title: 'G1', description: 'd', script: 's' });

    expect(await listRecipes(db.adminSql, ws, { hiveSlug: 'alpha' })).toHaveLength(1);
    expect((await listRecipes(db.adminSql, ws, { hiveSlug: 'alpha' }))[0].id).toBe('h1');
    expect(await listRecipes(db.adminSql, ws, { hiveSlug: null })).toHaveLength(1);
    expect((await listRecipes(db.adminSql, ws, { hiveSlug: null }))[0].id).toBe('g1');
    expect(await listRecipes(db.adminSql, ws)).toHaveLength(3); // whole workspace
  });

  it('is workspace-scoped — another workspace\'s recipes are not returned', async () => {
    await upsertRecipe(db.adminSql, { id: 'p', workspaceId: 'ws-cr-iso-a', hiveSlug: null, title: 'A', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'p2', workspaceId: 'ws-cr-iso-b', hiveSlug: null, title: 'B', description: 'd', script: 's' });
    expect(await listRecipes(db.adminSql, 'ws-cr-iso-a')).toHaveLength(1);
    expect((await listRecipes(db.adminSql, 'ws-cr-iso-a'))[0].title).toBe('A');
    // getRecipe is workspace-scoped: the other ws's id is invisible
    expect(await getRecipe(db.adminSql, 'ws-cr-iso-a', 'p2')).toBeNull();
  });
});
