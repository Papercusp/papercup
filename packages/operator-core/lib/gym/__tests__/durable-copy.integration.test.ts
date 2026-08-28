/**
 * Live-PG test for the durable run-analytics copy (plan
 * gym-repoint-live-coding-and-visible-runs-2026-07-20 P-011/P-013).
 *
 * Applies migration 650 (the live-DB harness_gym read-cache) to a `dst` DB and the ephemeral
 * gym schema to a `src` DB, writes a cycle's analytics into `src`, copies them across with
 * copyRunAnalyticsToDurable, and reads them back through the durable, (workspace,harness)-
 * scoped readers. Also proves the composite keys let two gym harnesses share the tables
 * without id collisions (both use variant_id 'baseline', task_id 'gym-train', cycle_id 'c0').
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { applyGymSchema } from '../schema';
import {
  insertVariant,
  insertTask,
  insertRun,
  finishRun,
  insertScore,
  insertCycle,
  copyRunAnalyticsToDurable,
  compareDurableVariants,
} from '../store';
import { readDurableCycleHistory, readDurableVariants, durableFrontierView } from '../read-api';
import type { GymScore } from '../judge';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_650 = join(__dirname, '../../../../../libs/papercusp/libs/db/sql/650-harness-gym-durable-run-analytics.sql');
const MIGRATION_1012 = join(__dirname, '../../../../../libs/papercusp/libs/db/sql/1012-gym-durable-active-task-generation.sql.DRAFT');

let src: postgres.Sql;
let dst: postgres.Sql;
let containerUri: string;
const srcDb = `gymsrc_${randomBytes(5).toString('hex')}`;
const dstDb = `gymdst_${randomBytes(5).toString('hex')}`;

const RH = 'rh-durable';
const score = (composite: number): GymScore => ({
  d1: composite, d2: composite, d3: composite, composite, rationale: 'r',
  judgeModel: 'claude-opus-4-8', rubricHash: RH, judgeTemp: 0, weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  costUsd: 0.5, inputTokens: 100, outputTokens: 50,
});

/** Seed one cycle's analytics (baseline + one candidate over a train task) into `src`. */
async function seedCycle(sql: postgres.Sql): Promise<void> {
  await insertVariant(sql, { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } });
  await insertVariant(sql, { variantId: 'cand-c0', parentId: 'baseline', label: 'cand-c0', overlay: { promptOverrides: { worker: '# Worker\nRe-read the spec.' } }, proposerRationale: 'targets the gap' });
  await insertTask(sql, { taskId: 'gym-train', pool: 'train', repoUrl: '/r', repoCommit: 'abc1234', spec: 's', intent: 'i' });
  for (const [variantId, composite] of [['baseline', 5], ['cand-c0', 8]] as const) {
    const runId = `${variantId}::gym-train::c0::r0`;
    await insertRun(sql, { runId, variantId, taskId: 'gym-train', cycle: 0, harnessSlug: 'throwaway' });
    await finishRun(sql, runId, { terminalState: 'passed', deterministicSignals: { regressions: false }, elapsedMs: 100 });
    await insertScore(sql, runId, score(composite));
  }
  await insertCycle(sql, { cycleId: 'c0', cycle: 0, parentId: 'baseline', candidateId: 'cand-c0', decision: 'accept', gateResults: { passed: true } });
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`CREATE DATABASE "${srcDb}"`);
    await maint.unsafe(`CREATE DATABASE "${dstDb}"`);
  } finally { await maint.end({ timeout: 5 }); }

  const srcUrl = new URL(containerUri); srcUrl.pathname = `/${srcDb}`;
  const dstUrl = new URL(containerUri); dstUrl.pathname = `/${dstDb}`;
  src = postgres(srcUrl.toString(), { max: 2, onnotice: () => {}, prepare: false });
  dst = postgres(dstUrl.toString(), { max: 2, onnotice: () => {}, prepare: false });

  // A multi-statement migration via applyGymSchema / .unsafe() trips postgres-js's
  // UNSAFE_TRANSACTION guard on a pooled (max>1) connection, so apply BOTH schemas on
  // dedicated max:1 connections; the max:2 src/dst pools then serve the parallel copy + reads.
  const srcMig = postgres(srcUrl.toString(), { max: 1, onnotice: () => {}, prepare: false });
  try { await applyGymSchema(srcMig); } finally { await srcMig.end({ timeout: 5 }); }

  // The migration GRANTs to harness_app / harness_zero — create them so the real migration
  // applies verbatim (the test role owns the tables and bypasses the RLS it enables).
  const mig = postgres(dstUrl.toString(), { max: 1, onnotice: () => {}, prepare: false });
  try {
    await mig.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await mig.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    // .simple(): the migration is a multi-statement DDL batch — the simple query protocol runs
    // them as one batch (the extended protocol postgres-js defaults to allows only one).
    await mig.unsafe(readFileSync(MIGRATION_650, 'utf8')).simple();
    // Migration 684 added harness_gym_durable.gym_tasks.corpus, which
    // copyRunAnalyticsToDurable now writes unconditionally — but 684's OTHER
    // statement (harness_shared.gym_proposals.task_corpus) targets a table this
    // test's minimal dst schema never creates (only 650 is applied here, not the
    // full migration chain). Apply just the gym_tasks half directly rather than
    // replaying 684 verbatim, so this test's schema matches what store.ts writes
    // without pulling in the unrelated harness_shared dependency.
    await mig.unsafe(`
      ALTER TABLE harness_gym_durable.gym_tasks
        ADD COLUMN IF NOT EXISTS corpus text NOT NULL DEFAULT 'synthetic';
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'gym_tasks_corpus_check'
             AND conrelid = 'harness_gym_durable.gym_tasks'::regclass
        ) THEN
          ALTER TABLE harness_gym_durable.gym_tasks
            ADD CONSTRAINT gym_tasks_corpus_check CHECK (corpus IN ('synthetic', 'real'));
        END IF;
      END $$;
    `);
    await mig.unsafe(readFileSync(MIGRATION_1012, 'utf8')).simple();
  } finally { await mig.end({ timeout: 5 }); }
});

afterAll(async () => {
  if (src) await src.end({ timeout: 5 });
  if (dst) await dst.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${srcDb}" WITH (FORCE)`);
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dstDb}" WITH (FORCE)`);
  } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('durable run-analytics copy (migration 650)', () => {
  it('copies a cycle from the ephemeral gym PG into the durable read-cache and reads it back scoped', async () => {
    await seedCycle(src);
    const copied = await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h1' });
    expect(copied).toEqual({ tasks: 1, variants: 2, runs: 2, scores: 2, cycles: 1 });

    const scope = { workspaceId: 'ws1', harnessSlug: 'h1' };
    const cycles = await readDurableCycleHistory(dst, scope);
    expect(cycles).toEqual([{ cycle: 0, parentId: 'baseline', candidateId: 'cand-c0', decision: 'accept' }]);

    const variants = await readDurableVariants(dst, scope);
    expect(variants.map((v) => v.variantId).sort()).toEqual(['baseline', 'cand-c0']);
    const cand = variants.find((v) => v.variantId === 'cand-c0')!;
    expect(cand.parentId).toBe('baseline');
    expect(cand.rationale).toBe('targets the gap');

    // jsonb round-trips (not double-encoded): the candidate's worker overlay is a real object.
    const [ov] = await dst<{ worker: string | null }[]>`
      SELECT prompt_overrides->>'worker' AS worker
        FROM harness_gym_durable.gym_variants
       WHERE workspace_id = 'ws1' AND harness_slug = 'h1' AND variant_id = 'cand-c0'`;
    expect(ov.worker).toContain('Re-read the spec.');

    // Frontier over the train vectors: cand-c0 (8) dominates baseline (5) on the single task.
    const frontier = await durableFrontierView(dst, scope, RH);
    expect(frontier).toContain('cand-c0');

    // Compare A-vs-B: the signed per-task delta (B − A).
    const cmp = await compareDurableVariants(dst, scope, 'baseline', 'cand-c0', RH);
    expect(cmp).toEqual([{ taskId: 'gym-train', aComposite: 5, bComposite: 8, delta: 3 }]);
  });

  it('is idempotent and (workspace,harness)-scoped — two harnesses share ids without collision', async () => {
    // Same src ids copied under a DIFFERENT harness must not collide (composite PKs) and must
    // stay isolated from h1's rows.
    const copied2 = await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h2' });
    expect(copied2.cycles).toBe(1);

    // Re-copy h1 (idempotent upsert) — still exactly one cycle, not duplicated.
    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h1' });

    const h1 = await readDurableCycleHistory(dst, { workspaceId: 'ws1', harnessSlug: 'h1' });
    const h2 = await readDurableCycleHistory(dst, { workspaceId: 'ws1', harnessSlug: 'h2' });
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);

    // A different workspace sees nothing.
    const other = await readDurableCycleHistory(dst, { workspaceId: 'ws-other', harnessSlug: 'h1' });
    expect(other).toHaveLength(0);

    // The frontier for h1 is unaffected by h2's identical rows.
    const frontier = await durableFrontierView(dst, { workspaceId: 'ws1', harnessSlug: 'h1' }, RH);
    expect(frontier).toContain('cand-c0');
  });

  it('keeps old task history but activates only the newest copied corpus', async () => {
    await dst`
      INSERT INTO harness_gym_durable.gym_tasks
        (workspace_id, harness_slug, task_id, pool, corpus, active)
      VALUES ('ws1', 'h3', 'legacy-synthetic', 'train', 'synthetic', true)`;

    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h3' });

    const rows = await dst<{ task_id: string; corpus: string; active: boolean }[]>`
      SELECT task_id, corpus, active
        FROM harness_gym_durable.gym_tasks
       WHERE workspace_id = 'ws1' AND harness_slug = 'h3'
       ORDER BY task_id`;
    expect(rows).toEqual([
      { task_id: 'gym-train', corpus: 'synthetic', active: true },
      { task_id: 'legacy-synthetic', corpus: 'synthetic', active: false },
    ]);
  });
});
