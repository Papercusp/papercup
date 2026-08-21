/**
 * pot-scope.integration.test.ts — the P-006 GUARD (pot-scope-all-learnings-2026-07-26).
 *
 * [owner 2026-07-25 interactive] "THERE SHOULD BE NO WORKSPACE SCOPED
 * LEARNINGS. ALL LEARNINGS SHOULD BE SCOPED TO A POT." This suite is the tripwire
 * that keeps that true structurally:
 *
 *   (a) every table in POT_SCOPED_LEARNING_TABLES HAS a pot_slug column — a new
 *       learning table added to the manifest without the column (or a migration
 *       dropping one) fails here, and a new learning table NOT added to the
 *       manifest fails review against this file's existence;
 *   (b) every P-002 writer STAMPS a non-null pot_slug when the caller has a
 *       resolvable pot — so a writer regressing to pot-less inserts fails here,
 *       not in a dashboard weeks later.
 *
 * The org-fixture provisions the fully-migrated schema (incl. migration 659,
 * which added pot_slug to the 5 tables that had no pot column at all).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { POT_SCOPED_LEARNING_TABLES } from './pot-scope';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-pot-guard' }));

// recordScoutTick routes through getOrgPg().sql + activeWorkspaceId() (it is the
// PG edge, not an injected-Sql store) — mock them to the fixture, tick-ledger
// integration-test style. The other writers all take the sql handle directly.
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => Promise.resolve() }));

const { recordScoutTick } = await import('../scout/tick-ledger');
const { insertPrediction } = await import('../calibration/store');
const { insertAblationRun } = await import('../ablation/store');
const { upsertRecipe, recordRecipeRun } = await import('../code-recipes-store');
const { registerLearningLoop, recordLearningSpend } = await import('../learning-governor/store');
const { admitTransferLesson } = await import('../transfer/store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-pot-guard';
const POT = 'guard-pot';

describe('pot-scope guard (P-006) — no learning table regresses to workspace scope', () => {
  let db: OrgTestDb;
  const sql = () => db.adminSql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('(a) every manifest table HAS a pot_slug column', async () => {
    const names = POT_SCOPED_LEARNING_TABLES.map((t) => t.split('.')[1]!);
    const rows = await sql()<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND column_name = 'pot_slug'
         AND table_name = ANY(${names as string[]})`;
    const have = new Set(rows.map((r) => r.table_name));
    const missing = names.filter((n) => !have.has(n));
    expect(missing, `learning tables missing pot_slug: ${missing.join(', ')}`).toEqual([]);
  });

  it('(a′) every manifest table actually EXISTS (the manifest cannot drift from the schema)', async () => {
    const names = POT_SCOPED_LEARNING_TABLES.map((t) => t.split('.')[1]!);
    const rows = await sql()<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_name = ANY(${names as string[]})`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([...names].sort());
  });

  const potOf = async (table: string, where: string, params: unknown[]): Promise<string | null> => {
    const rows = await sql().unsafe(`SELECT pot_slug FROM ${table} WHERE ${where} LIMIT 1`, params as never[]);
    expect(rows.length, `${table}: guard row not found`).toBe(1);
    return (rows[0] as unknown as { pot_slug: string | null }).pot_slug;
  };

  it('(b) transfer_lessons: admitTransferLesson stamps the explicit pot', async () => {
    const res = await admitTransferLesson(sql(), {
      workspaceId: WS,
      signature: 'guard-sig-1',
      lessonText: 'guard lesson',
      potSlug: POT,
    });
    expect(res.admitted).toBe(true);
    expect(
      await potOf('harness_shared.transfer_lessons', 'workspace_id = $1 AND signature = $2', [WS, 'guard-sig-1']),
    ).toBe(POT);
  });

  it('(b) calibration_predictions: insertPrediction stamps the pot', async () => {
    const res = await insertPrediction(sql(), {
      workspaceId: WS,
      predictor: 'guard-su',
      domain: 'fix-survival',
      subjectKind: 'improvement',
      subjectId: 'EI-guard',
      claim: 'guard claim',
      probability: 0.5,
      stated: false,
      origin: 'organic',
      horizonTs: new Date().toISOString(),
      potSlug: POT,
    });
    expect(res.created).toBe(true);
    expect(
      await potOf('harness_shared.calibration_predictions', 'workspace_id = $1 AND subject_id = $2', [
        WS,
        'EI-guard',
      ]),
    ).toBe(POT);
  });

  it('(b) prompt_ablation_runs: insertAblationRun stamps the pot', async () => {
    const id = await insertAblationRun(sql(), {
      workspaceId: WS,
      startedAtMs: Date.now(),
      playbookPath: 'p',
      playbookHash: 'h',
      ruleKey: 'guard/rule',
      ruleHash: 'rh',
      ruleExcerpt: 'x',
      scenarioCount: 1,
      baselinePassRate: 1,
      ablatedPassRate: 1,
      passRateDelta: 0,
      verdict: 'no-delta',
      capped: false,
      costUsd: 0,
      ledgerContext: null,
      detail: { scenarios: [] },
      potSlug: POT,
    });
    expect(await potOf('harness_shared.prompt_ablation_runs', 'id = $1', [id])).toBe(POT);
  });

  it('(b) code_recipes + code_recipe_runs: upsert stamps, update PRESERVES first-write pot, run stamps usage', async () => {
    await upsertRecipe(sql(), {
      id: 'guard-recipe',
      title: 'Guard',
      description: 'd',
      script: 's',
      potSlug: POT,
    });
    expect(await potOf('harness_shared.code_recipes', 'id = $1', ['guard-recipe'])).toBe(POT);

    // First-write attribution: a later update from another pot must not steal it.
    await upsertRecipe(sql(), {
      id: 'guard-recipe',
      title: 'Guard v2',
      description: 'd2',
      script: 's2',
      potSlug: 'other-pot',
    });
    expect(await potOf('harness_shared.code_recipes', 'id = $1', ['guard-recipe'])).toBe(POT);

    await recordRecipeRun(sql(), {
      recipeId: 'guard-recipe',
      workspaceId: WS,
      potSlug: POT,
    });
    expect(await potOf('harness_shared.code_recipe_runs', 'workspace_id = $1 AND recipe_id = $2', [WS, 'guard-recipe'])).toBe(POT);
  });

  it('(b) scout_ticks: recordScoutTick stamps the explicit pot', async () => {
    await recordScoutTick({ status: 'gated', gate: 'min-interval', workspaceId: WS, installSlug: 'guard-install', potSlug: POT });
    expect(
      await potOf('harness_shared.scout_ticks', 'workspace_id = $1 AND install_slug = $2', [WS, 'guard-install']),
    ).toBe(POT);
  });

  it('(b) learning_governor_loops + learning_spend_events: register keys/stamps the pot, spend carries it, re-register without potSlug PRESERVES it', async () => {
    const reg = await registerLearningLoop(sql(), {
      workspaceId: WS,
      loopId: `blender:${POT}`,
      potSlug: POT,
      budgetKind: 'per-cycle',
      budgetUsd: 1,
      enforcement: 'native',
    });
    expect(reg.potSlug).toBe(POT);
    expect(await potOf('harness_shared.learning_governor_loops', 'workspace_id = $1 AND loop_id = $2', [WS, `blender:${POT}`])).toBe(POT);

    // P-004 upsert semantics: an omitted potSlug preserves the stored pot.
    const again = await registerLearningLoop(sql(), {
      workspaceId: WS,
      loopId: `blender:${POT}`,
      budgetUsd: 2,
    });
    expect(again.potSlug).toBe(POT);

    const ev = await recordLearningSpend(sql(), {
      workspaceId: WS,
      loopId: `blender:${POT}`,
      potSlug: POT,
      costUsd: 0.1,
    });
    expect(ev.potSlug).toBe(POT);
    expect(await potOf('harness_shared.learning_spend_events', 'workspace_id = $1 AND loop_id = $2', [WS, `blender:${POT}`])).toBe(POT);
  });
});
