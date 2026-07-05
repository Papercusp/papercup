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
 * global listing, get, and usage-scoped run history.
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
  mergeRecipes,
  sweepRecipes,
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
      title: 'Triage stale items',
      description: 'list then act per stale work-item',
      script: '// triage\nreturn await tools.work_items.list({});',
      authorRole: 'cup',
      toolsUsed: ['work_items:list'],
      embedding: fakeEmbedding(),
      tags: ['triage'],
      createdBy: 'owner-1',
    });
    expect(row.id).toBe('triage-stale-items');
    expect(row.title).toBe('Triage stale items');
    expect(row.toolsUsed).toEqual(['work_items:list']);
    expect(row.runCount).toBe(0);
    expect(row.successCount).toBe(0);
    expect(row.lastRunAt).toBeNull();
    expect(row.status).toBe('active');
    expect(row.hasEmbedding).toBe(true);
    expect(row.createdBy).toBe('owner-1');
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);

    const got = await getRecipe(db.adminSql, 'triage-stale-items');
    expect(got?.title).toBe('Triage stale items');
    const list = await listRecipes(db.adminSql, { includeTrivial: true });
    expect(list.some((r) => r.id === 'triage-stale-items')).toBe(true);
  });

  it('upsert updates title/description/script/tools in place by id (no duplicate)', async () => {
    const first = await upsertRecipe(db.adminSql, {
      id: 'note',
      title: 'Note',
      description: 'first',
      script: 'return 1;',
    });
    const second = await upsertRecipe(db.adminSql, {
      id: 'note',
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
    const list = await listRecipes(db.adminSql, { includeTrivial: true });
    expect(list.filter((r) => r.id === 'note')).toHaveLength(1);
  });

  it('upsert PRESERVES an existing embedding when re-run without one', async () => {
    await upsertRecipe(db.adminSql, {
      id: 'emb',
      title: 'Emb',
      description: 'has embedding',
      script: 'return 1;',
      embedding: fakeEmbedding(0.2),
    });
    // re-upsert with embedding omitted (embedder unavailable) — must not wipe it
    const after = await upsertRecipe(db.adminSql, {
      id: 'emb',
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
      title: 'Runner',
      description: 'd',
      script: 'return 1;',
    });

    await recordRecipeRun(db.adminSql, {
      recipeId: 'runner',
      workspaceId: ws,
      hiveSlug: 'alpha',
      agentOwner: 'agent-a',
      agentRole: 'cup',
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

    const row = await getRecipe(db.adminSql, 'runner');
    expect(row?.runCount).toBe(2);
    expect(row?.successCount).toBe(1); // only the success bumps it
    expect(row?.lastRunAt).not.toBeNull();

    const runRows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM harness_shared.code_recipe_runs
       WHERE recipe_id = 'runner' AND workspace_id = ${ws}`;
    expect(parseInt(runRows[0].count, 10)).toBe(2);
  });

  it('listRecipes returns the global recipe corpus', async () => {
    await upsertRecipe(db.adminSql, { id: 'h1', title: 'H1', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'h2', title: 'H2', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'g1', title: 'G1', description: 'd', script: 's' });

    const ids = new Set((await listRecipes(db.adminSql, { includeTrivial: true })).map((r) => r.id));
    expect(ids.has('h1')).toBe(true);
    expect(ids.has('h2')).toBe(true);
    expect(ids.has('g1')).toBe(true);
  });

  it('is global — recipes are visible by id regardless of run workspace', async () => {
    await upsertRecipe(db.adminSql, { id: 'p', title: 'A', description: 'd', script: 's' });
    await upsertRecipe(db.adminSql, { id: 'p2', title: 'B', description: 'd', script: 's' });
    expect((await getRecipe(db.adminSql, 'p'))?.title).toBe('A');
    expect((await getRecipe(db.adminSql, 'p2'))?.title).toBe('B');
  });

  it('listRecipes HIDES low-value recipes by default; includeTrivial returns them (P-004)', async () => {
    // multi-tool, authored title → reuse-worthy (shown by default)
    await upsertRecipe(db.adminSql, {
      id: 'multi-tool-worthy', title: 'Triage and block stale items', description: 'd', script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
    });
    // 1-tool wrapper → low-value (hidden by default)
    await upsertRecipe(db.adminSql, {
      id: 'one-tool-wrapper', title: 'Just list plans', description: 'd', script: 's',
      toolsUsed: ['plans:list'],
    });
    // auto-derived fallback title ("recipe: …") on a multi-tool script → low-value
    await upsertRecipe(db.adminSql, {
      id: 'auto-titled', title: 'recipe: plans:add-item + plans:set-status', description: 'd', script: 's',
      toolsUsed: ['plans:add-item', 'plans:set-status'],
    });

    const def = new Set((await listRecipes(db.adminSql)).map((r) => r.id));
    expect(def.has('multi-tool-worthy')).toBe(true);
    expect(def.has('one-tool-wrapper')).toBe(false); // hidden: ≤1 tool
    expect(def.has('auto-titled')).toBe(false); // hidden: auto-derived title

    const all = new Set((await listRecipes(db.adminSql, { includeTrivial: true })).map((r) => r.id));
    expect(all.has('multi-tool-worthy')).toBe(true);
    expect(all.has('one-tool-wrapper')).toBe(true);
    expect(all.has('auto-titled')).toBe(true);
  });

  // ── mergeRecipes (Phase 4, P-010 / D-015) ───────────────────────────────────
  describe('mergeRecipes', () => {
    it('folds duplicates into the survivor: status=merged, merged_into set, counts summed', async () => {
      const ws = 'ws-cr-merge';
      // Survivor with some usage.
      await upsertRecipe(db.adminSql, { id: 'survivor', title: 'Survivor', description: 'd', script: 's' });
      // Two near-duplicates with their own usage.
      await upsertRecipe(db.adminSql, { id: 'dup-1', title: 'Dup 1', description: 'd', script: 's' });
      await upsertRecipe(db.adminSql, { id: 'dup-2', title: 'Dup 2', description: 'd', script: 's' });
      // Survivor: 2 runs / 2 success; dup-1: 3 runs / 2 success; dup-2: 1 run / 0 success.
      for (let i = 0; i < 2; i++) await recordRecipeRun(db.adminSql, { recipeId: 'survivor', workspaceId: ws, hiveSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, hiveSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, hiveSlug: 'alpha', success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-1', workspaceId: ws, hiveSlug: 'alpha', success: false });
      await recordRecipeRun(db.adminSql, { recipeId: 'dup-2', workspaceId: ws, hiveSlug: 'alpha', success: false });

      const { survivor, mergedIds } = await mergeRecipes(db.adminSql, {
        survivorId: 'survivor',
        duplicateIds: ['dup-1', 'dup-2'],
      });

      // Survivor's counts = its own + both duplicates'. runs: 2+3+1=6, success: 2+2+0=4.
      expect(mergedIds.sort()).toEqual(['dup-1', 'dup-2']);
      expect(survivor.id).toBe('survivor');
      expect(survivor.status).toBe('active'); // survivor stays active
      expect(survivor.runCount).toBe(6);
      expect(survivor.successCount).toBe(4);

      // Duplicates are merged + point at the survivor.
      const d1 = await getRecipe(db.adminSql, 'dup-1');
      const d2 = await getRecipe(db.adminSql, 'dup-2');
      expect(d1?.status).toBe('merged');
      expect(d1?.mergedInto).toBe('survivor');
      expect(d2?.status).toBe('merged');
      expect(d2?.mergedInto).toBe('survivor');
    });

    it('never merges a recipe into itself + skips absent ids', async () => {
      const ws = 'ws-cr-merge-self';
      await upsertRecipe(db.adminSql, { id: 'keep', title: 'Keep', description: 'd', script: 's' });
      await upsertRecipe(db.adminSql, { id: 'real-dup', title: 'Dup', description: 'd', script: 's' });
      await recordRecipeRun(db.adminSql, { recipeId: 'keep', workspaceId: ws, hiveSlug: null, success: true });
      await recordRecipeRun(db.adminSql, { recipeId: 'real-dup', workspaceId: ws, hiveSlug: null, success: true });

      const { survivor, mergedIds } = await mergeRecipes(db.adminSql, {
        survivorId: 'keep',
        duplicateIds: ['keep', 'real-dup', 'missing'],
      });

      expect(mergedIds).toEqual(['real-dup']);
      // counts: keep 1 + real-dup 1 = 2 (the missing id + self contribute nothing)
      expect(survivor.runCount).toBe(2);
      // The survivor was NOT marked merged (self-merge guarded).
      expect(survivor.status).toBe('active');
      expect((await getRecipe(db.adminSql, 'keep'))?.mergedInto).toBeNull();
    });

    it('is idempotent — re-merging the same duplicate into the same survivor is a true no-op', async () => {
      const ws = 'ws-cr-merge-idem';
      await upsertRecipe(db.adminSql, { id: 's', title: 'S', description: 'd', script: 's' });
      await upsertRecipe(db.adminSql, { id: 'd', title: 'D', description: 'd', script: 's' });
      await recordRecipeRun(db.adminSql, { recipeId: 'd', workspaceId: ws, hiveSlug: null, success: true });

      const first = await mergeRecipes(db.adminSql, { survivorId: 's', duplicateIds: ['d'] });
      expect(first.mergedIds).toEqual(['d']);
      expect(first.survivor.runCount).toBe(1); // s(0) + d(1)

      // Replay: 'd' is already merged INTO 's', so it is skipped — counters are
      // NOT re-folded (no double-count) and it stays merged→s.
      const second = await mergeRecipes(db.adminSql, { survivorId: 's', duplicateIds: ['d'] });
      expect(second.mergedIds).toEqual([]); // nothing re-merged
      expect(second.survivor.runCount).toBe(1); // unchanged — the replay added nothing
      expect((await getRecipe(db.adminSql, 'd'))?.status).toBe('merged');
      expect((await getRecipe(db.adminSql, 'd'))?.mergedInto).toBe('s');
    });
  });

  // ── sweepRecipes (Phase 4, P-010) ───────────────────────────────────────────
  describe('sweepRecipes', () => {
    /** Make a recipe + force its last_run_at + run_count to simulate age/usage. */
    async function seedAged(
      ws: string,
      id: string,
      opts: { hiveSlug?: string | null; runCount: number; daysAgo: number | null; status?: string },
    ) {
      await upsertRecipe(db.adminSql, {
        id,
        title: id,
        description: 'd',
        script: 's',
      });
      const status = opts.status ?? 'active';
      if (opts.daysAgo == null) {
        await db.adminSql`
          UPDATE harness_shared.code_recipes
             SET run_count = ${opts.runCount}, last_run_at = NULL, status = ${status}
           WHERE id = ${id}`;
      } else {
        await db.adminSql`
          UPDATE harness_shared.code_recipes
             SET run_count   = ${opts.runCount},
                 last_run_at = now() - make_interval(days => ${opts.daysAgo}),
                 status      = ${status}
           WHERE id = ${id}`;
      }
    }

    it('retires a stale 0/1-run recipe but NOT a hot one or a recently-run one', async () => {
      const ws = 'ws-cr-sweep';
      await seedAged(ws, 'stale-oneoff', { runCount: 1, daysAgo: 45 }); // SWEEP: stale + one-off
      await seedAged(ws, 'stale-zero', { runCount: 0, daysAgo: 60 }); // SWEEP: stale, never-rerun (but ran once long ago)
      await seedAged(ws, 'hot', { runCount: 12, daysAgo: 90 }); // KEEP: hot (over the cap) even though old
      await seedAged(ws, 'recent', { runCount: 1, daysAgo: 2 }); // KEEP: recent

      const { swept, dryRun } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(dryRun).toBe(false);
      expect(swept.map((r) => r.id).sort()).toEqual(['stale-oneoff', 'stale-zero']);
      for (const r of swept) expect(r.status).toBe('retired');

      expect((await getRecipe(db.adminSql, 'stale-oneoff'))?.status).toBe('retired');
      expect((await getRecipe(db.adminSql, 'stale-zero'))?.status).toBe('retired');
      expect((await getRecipe(db.adminSql, 'hot'))?.status).toBe('active');
      expect((await getRecipe(db.adminSql, 'recent'))?.status).toBe('active');
    });

    it('NEVER touches a promoted or merged recipe even when stale + one-off', async () => {
      const ws = 'ws-cr-sweep-protected';
      await seedAged(ws, 'promoted', { runCount: 1, daysAgo: 99, status: 'promoted' });
      await seedAged(ws, 'already-merged', { runCount: 1, daysAgo: 99, status: 'merged' });
      await seedAged(ws, 'plain-stale', { runCount: 1, daysAgo: 99, status: 'active' });

      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept.map((r) => r.id)).toEqual(['plain-stale']); // only the active one
      expect((await getRecipe(db.adminSql, 'promoted'))?.status).toBe('promoted');
      expect((await getRecipe(db.adminSql, 'already-merged'))?.status).toBe('merged');
    });

    it('does NOT sweep a never-run recipe (NULL last_run_at has no staleness clock)', async () => {
      const ws = 'ws-cr-sweep-null';
      await seedAged(ws, 'never-run', { runCount: 0, daysAgo: null });
      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept).toHaveLength(0);
      expect((await getRecipe(db.adminSql, 'never-run'))?.status).toBe('active');
    });

    it('dryRun changes NOTHING — returns the candidates, leaves status active', async () => {
      const ws = 'ws-cr-sweep-dry';
      await seedAged(ws, 'cand', { runCount: 1, daysAgo: 50 });

      const preview = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1, dryRun: true });
      expect(preview.dryRun).toBe(true);
      expect(preview.swept.map((r) => r.id)).toEqual(['cand']);
      // The candidate row in the preview reflects its CURRENT (still active) status.
      expect(preview.swept[0].status).toBe('active');
      // Nothing was mutated.
      expect((await getRecipe(db.adminSql, 'cand'))?.status).toBe('active');

      // A real run then actually retires it.
      const real = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1, dryRun: false });
      expect(real.swept.map((r) => r.id)).toEqual(['cand']);
      expect((await getRecipe(db.adminSql, 'cand'))?.status).toBe('retired');
    });

    it('sweeps globally across hives', async () => {
      const ws = 'ws-cr-sweep-hive';
      await seedAged(ws, 'alpha-stale', { hiveSlug: 'alpha', runCount: 1, daysAgo: 50 });
      await seedAged(ws, 'beta-stale', { hiveSlug: 'beta', runCount: 1, daysAgo: 50 });

      const { swept } = await sweepRecipes(db.adminSql, { staleDays: 30, maxRunCount: 1 });
      expect(swept.map((r) => r.id).sort()).toEqual(['alpha-stale', 'beta-stale']);
    });
  });
});
