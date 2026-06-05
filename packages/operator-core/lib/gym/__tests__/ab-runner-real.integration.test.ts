/**
 * Live-PG fake-validation of the P-014 A/B harness (`runAbEvaluation`) over the REAL gym
 * store (`createGymStore`): run 2 variants × 1 task × 2 repeats with a FAKE pipeline +
 * FAKE collect + FAKE judge, but write/read a real gym PG. Proves the harness + store
 * adapter + real `compareVariants` compose end-to-end — no operator, no real agents, no
 * LLM (the slow real pipeline + real Opus judge are exercised on capacity, per the run plan).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { applyGymSchema } from '../schema';
import { createGymStore } from '../ab-runner-real';
import { runAbEvaluation, type AbConfig, type AbDeps } from '../ab-runner';
import { GYM_JUDGE_RUBRIC_V1 } from '../judge-scoring';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gymab_${randomBytes(5).toString('hex')}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`CREATE DATABASE "${dbName}"`); } finally { await maint.end({ timeout: 5 }); }
  const u = new URL(containerUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {}, prepare: false });
  await applyGymSchema(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

function cfg(): AbConfig {
  return {
    variants: [
      { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand-1', label: 'candidate', overlay: { promptOverrides: { worker: '# w2' } } },
    ],
    tasks: [{ taskId: 'task-a', pool: 'train', repoUrl: '/repos/sub', repoCommit: COMMIT, spec: 'Add /health', intent: 'liveness', projectContext: 'a Hono API' }],
    repeats: 2,
    rubric: GYM_JUDGE_RUBRIC_V1,
    harnessCommit: COMMIT,
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym',
    deriveOpts: { sigmaMultiple: 2, targetStandardError: 0.25 },
    maxDistillChars: 60_000,
  };
}

/** Deps with the REAL gym store but fake pipeline/collect/judge — composites scripted per call. */
function deps(composites: number[]): AbDeps {
  let i = 0;
  return {
    store: createGymStore(sql),
    async runPipeline(input) {
      const slug = `gym${input.variant.variantId}${input.task.taskId}r${input.repeat}`.replace(/[^a-z0-9]/g, '');
      return { harnessSlug: slug, clonePath: `/c/${slug}`, workflowID: `wf:${slug}`, outcome: 'passed', pipelineUsd: 0.4 };
    },
    async collectAndDistill() {
      return { distilledTrace: '## Diff\n+health()', traceRef: '/t/x.json', rawSignals: { ok: true } };
    },
    llmCall: async () => {
      const c = composites[Math.min(i++, composites.length - 1)];
      return { text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake' }), costUsd: 2.5, inputTokens: 10, outputTokens: 20 };
    },
    newRunId: (v, t, r) => `${v}::${t}::r${r}`,
    now: () => 0,
  };
}

describe('runAbEvaluation over the real gym store (live PG)', () => {
  it('writes variants/tasks/runs/scores and reads back the A-vs-B comparison + variance', async () => {
    // baseline repeats → 6,8 (mean 7, sd 1); cand-1 repeats → 9,9 (mean 9, sd 0).
    const res = await runAbEvaluation(cfg(), deps([6, 8, 9, 9]));

    // 2 variants × 1 task × 2 repeats = 4 runs/scores persisted in the real gym PG.
    expect(res.outcomes).toHaveLength(4);
    const runCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_runs`;
    expect(runCount[0].n).toBe(4);
    const scoreCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_scores`;
    expect(scoreCount[0].n).toBe(4);
    const variantCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_variants`;
    expect(variantCount[0].n).toBe(2);

    // Comparison comes from the REAL compareVariants over the real PG (max composite per variant×task).
    expect(res.comparison).toEqual([{ taskId: 'task-a', aComposite: 8, bComposite: 9, delta: 1 }]);

    // Variance derived from the persisted composites.
    const base = res.perTaskVariance.find((v) => v.variantId === 'baseline')!;
    expect(base.mean).toBeCloseTo(7);
    expect(base.sd).toBeCloseTo(1);
    expect(base.minRepeats).toBe(16); // ceil((1/0.25)^2)
    const cand = res.perTaskVariance.find((v) => v.variantId === 'cand-1')!;
    expect(cand.sd).toBeCloseTo(0);

    // Cost: 4 × (0.4 pipeline + 2.5 judge) = 11.6.
    expect(res.cost.totalUsd).toBeCloseTo(11.6);
  });
});
