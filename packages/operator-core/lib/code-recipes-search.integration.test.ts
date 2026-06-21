/**
 * code-recipes-search.integration.test.ts — the hybrid dedup/search over
 * `harness_shared.code_recipes` (code-recipes-2026-06-21 Phase 2, P-004 / P-011)
 * against real Postgres.
 *
 * Mirrors code-recipes-store.integration.test.ts: the module is transport-agnostic
 * (takes the `sql` handle), so we pass the org-fixture's admin (RLS-bypass) client.
 * Validates: a same-use-case query ranks the right recipe top, the structural
 * tool-set-overlap (Jaccard) signal boosts a same-tool recipe, excludeId is honored,
 * and hive-scope filtering. No live embedder — the BM25 lexical leg + the
 * pre-computed-embedding cosine leg + the structural leg carry the ranking.
 *
 * Part of code-recipes-2026-06-21 Phase 2 (P-004, integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertRecipe } from './code-recipes-store';
import { searchSimilarRecipes } from './code-recipes-search';

const { createOrgTestDb } = await import('../test/_org-test-db');

/**
 * A deterministic 384-dim unit-ish embedding seeded by a scalar so two recipes
 * sharing a seed are cosine-close and a different seed is far. (The cosine leg
 * orders by `embedding <=> qVec`; identical vectors ⇒ distance 0.)
 */
const seededEmbedding = (seed: number): number[] => Array.from({ length: 384 }, (_, i) => Math.sin(seed + i * 0.01));

describe('code_recipes hybrid search (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('ranks the same-use-case recipe top (lexical + structural)', async () => {
    const ws = 'ws-crs-rank';
    const hive = 'alpha';
    // The target: triage stale work-items, calls work_items:list + set_state.
    await upsertRecipe(db.adminSql, {
      id: 'triage-stale-work-items',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Triage stale work-items',
      description: 'list open work-items then mark stale ones blocked',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      embedding: seededEmbedding(1),
    });
    // A decoy on a totally different topic + tool-set.
    await upsertRecipe(db.adminSql, {
      id: 'announce-deploy',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Announce a deploy to the hive',
      description: 'post a coord message when a release ships',
      script: 's',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(50),
    });
    // A weak lexical neighbor (shares "work-items" but a different action + tools).
    await upsertRecipe(db.adminSql, {
      id: 'count-work-items',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Count open work-items',
      description: 'tally how many work-items are open',
      script: 's',
      toolsUsed: ['work_items:list'],
      embedding: seededEmbedding(40),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Triage stale work-items',
      description: 'find stale work-items and block them',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      embedding: seededEmbedding(1),
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('triage-stale-work-items');
    expect(results[0].similarity).toBeGreaterThan(0);
    // the off-topic decoy should not outrank the work-items recipes
    const decoyRank = results.findIndex((r) => r.id === 'announce-deploy');
    const targetRank = results.findIndex((r) => r.id === 'triage-stale-work-items');
    if (decoyRank !== -1) expect(targetRank).toBeLessThan(decoyRank);
  });

  it('the structural tool-set overlap boosts a same-tool recipe over a lexical-only match', async () => {
    const ws = 'ws-crs-struct';
    const hive = 'alpha';
    // Same exact tool-set as the query, but no lexical/embedding head-start.
    await upsertRecipe(db.adminSql, {
      id: 'same-tools',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Sweep items',
      description: 'sweep things',
      script: 's',
      toolsUsed: ['plans:set-status', 'plans:add-item'],
      embedding: seededEmbedding(5),
    });
    // Lexically matches the query words but a disjoint tool-set.
    await upsertRecipe(db.adminSql, {
      id: 'lexical-only',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Manage a plan and its items',
      description: 'manage plan items',
      script: 's',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(60),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Manage a plan and its items',
      description: 'manage plan items',
      toolsUsed: ['plans:set-status', 'plans:add-item'],
      embedding: seededEmbedding(5),
      limit: 5,
    });

    const sameRank = results.findIndex((r) => r.id === 'same-tools');
    const lexRank = results.findIndex((r) => r.id === 'lexical-only');
    expect(sameRank).not.toBe(-1);
    // the structural twin (full Jaccard=1) outranks the disjoint-tool lexical match
    if (lexRank !== -1) expect(sameRank).toBeLessThan(lexRank);
  });

  it('honors excludeId (a re-run never matches itself)', async () => {
    const ws = 'ws-crs-exclude';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      id: 'self',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Self recipe',
      description: 'a recipe',
      script: 's',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(7),
    });
    await upsertRecipe(db.adminSql, {
      id: 'other',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Self recipe',
      description: 'a recipe',
      script: 's',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(7),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Self recipe',
      description: 'a recipe',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(7),
      excludeId: 'self',
      limit: 5,
    });
    expect(results.find((r) => r.id === 'self')).toBeUndefined();
    expect(results.find((r) => r.id === 'other')).toBeDefined();
  });

  it('is hive-scoped — a recipe in another hive is not returned', async () => {
    const ws = 'ws-crs-hive';
    await upsertRecipe(db.adminSql, {
      id: 'in-alpha',
      workspaceId: ws,
      hiveSlug: 'alpha',
      title: 'Deploy the service',
      description: 'deploy it',
      script: 's',
      toolsUsed: ['deploy:harness'],
      embedding: seededEmbedding(9),
    });
    await upsertRecipe(db.adminSql, {
      id: 'in-beta',
      workspaceId: ws,
      hiveSlug: 'beta',
      title: 'Deploy the service',
      description: 'deploy it',
      script: 's',
      toolsUsed: ['deploy:harness'],
      embedding: seededEmbedding(9),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      workspaceId: ws,
      hiveSlug: 'alpha',
      title: 'Deploy the service',
      description: 'deploy it',
      toolsUsed: ['deploy:harness'],
      embedding: seededEmbedding(9),
      limit: 5,
    });
    expect(results.find((r) => r.id === 'in-alpha')).toBeDefined();
    expect(results.find((r) => r.id === 'in-beta')).toBeUndefined();
  });

  it('returns the blended fields (title/description/runCount/similarity)', async () => {
    const ws = 'ws-crs-fields';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      id: 'fielded',
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Fielded recipe title',
      description: 'a thorough description here',
      script: 's',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(11),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      workspaceId: ws,
      hiveSlug: hive,
      title: 'Fielded recipe title',
      description: 'a thorough description here',
      toolsUsed: ['coord:send'],
      embedding: seededEmbedding(11),
      limit: 5,
    });
    const hit = results.find((r) => r.id === 'fielded');
    expect(hit).toBeDefined();
    expect(hit?.title).toBe('Fielded recipe title');
    expect(hit?.description).toBe('a thorough description here');
    expect(hit?.runCount).toBe(0);
    expect(hit?.similarity).toBeGreaterThan(0);
    expect(hit?.similarity).toBeLessThanOrEqual(1);
  });
});
