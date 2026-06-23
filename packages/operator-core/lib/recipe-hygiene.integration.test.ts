/**
 * recipe-hygiene.integration.test.ts — the weekly code-recipes hygiene pass
 * (recipes-reuse-activation-2026-06-22 P-003) against real Postgres. Asserts the sweep
 * retires a stale never-reused one-off while leaving a hot recipe active, and that the
 * pass surfaces the graduation worklist counts (so the scheduled routine has something
 * to log).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertRecipe, recordRecipeRun, getRecipe } from './code-recipes-store';
import { runRecipeHygieneOnce } from './recipe-hygiene';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('runRecipeHygieneOnce (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('retires a stale never-reused one-off, leaves a hot recipe active, surfaces the worklist', async () => {
    const ws = 'ws-hygiene';

    // STALE one-off: run once, then backdate last_run_at past the 30d window so the
    // conservative default sweep (run_count<=1 AND last_run older than 30d) retires it.
    await upsertRecipe(db.adminSql, {
      id: 'stale-oneoff-recipe',
      title: 'Stale one-off',
      description: 'run once, never reused',
      script: 's',
      toolsUsed: ['plans:list'],
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'stale-oneoff-recipe', workspaceId: ws, hiveSlug: 'alpha', agentOwner: 'a', success: true,
    });
    await db.adminSql`UPDATE harness_shared.code_recipes SET last_run_at = now() - interval '40 days' WHERE id = 'stale-oneoff-recipe'`;

    // HOT recipe: several recent runs across distinct agents — must NOT be swept.
    await upsertRecipe(db.adminSql, {
      id: 'hot-recipe',
      title: 'Hot recipe',
      description: 'reused a lot',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
    });
    for (const agent of ['a', 'b', 'c']) {
      await recordRecipeRun(db.adminSql, {
        recipeId: 'hot-recipe', workspaceId: ws, hiveSlug: 'alpha', agentOwner: agent, success: true,
      });
    }

    const r = await runRecipeHygieneOnce(db.adminSql);

    // the stale one-off was retired (reversible status flip) …
    expect(r.sweptIds).toContain('stale-oneoff-recipe');
    expect((await getRecipe(db.adminSql, 'stale-oneoff-recipe'))?.status).toBe('retired');

    // … the hot recipe was left ACTIVE (never sweep a reused recipe) …
    expect(r.sweptIds).not.toContain('hot-recipe');
    expect((await getRecipe(db.adminSql, 'hot-recipe'))?.status).toBe('active');

    // … and the graduation worklist counts are surfaced for the scheduled log.
    expect(typeof r.promoteCandidates).toBe('number');
    expect(r.promoteCandidates).toBeGreaterThanOrEqual(0);
    expect(typeof r.mergeClusters).toBe('number');
    expect(r.mergeClusters).toBeGreaterThanOrEqual(0);
  });
});
