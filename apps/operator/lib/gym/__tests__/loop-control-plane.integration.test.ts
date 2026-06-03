/**
 * Live-PG integration of the autonomous loop → control-plane bridge (D-020 runner service).
 *
 * Proves the human-gated runner wiring end-to-end against a real gym DB (no operator, no LLM):
 * runOptimizationLoop (loop.ts) over buildLoopDeps (loop-deps.ts) with injected fake per-run
 * engine + fake judge + fake proposer, recording each candidate via makeLoopProposalRecorder
 * (control-plane.ts) →
 *   - harness_gym.gym_cycles gets the cycle audit row(s);
 *   - harness_shared.gym_proposals gets the candidate's CHANGED-role prompt as a pending
 *     proposal (what the gym UI's diff-review shows);
 *   - harness_shared.gym_autoloop_config.last_cycle advances;
 *   - decideProposal(accept) promotes the proposed prompt into harness_prompt_overrides.
 *
 * This is the integration the real entrypoint (gym-loop-run.ts) performs with real adapters;
 * here the adapters are faked so the WIRING is validated cheaply + deterministically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym-db-init';
import { buildLoopDeps, type LoopTask } from '../loop-deps';
import { runOptimizationLoop } from '../loop';
import { makeLoopProposalRecorder, listProposals, decideProposal, getAutoloop, getPrompts } from '../control-plane';
import { createGymStore } from '../ab-runner-real';
import { readPoolAggregates } from '../read-api';
import { rubricHash, GYM_JUDGE_RUBRIC_V1 } from '../judge-scoring';
import type { AbDeps } from '../ab-runner';
import type { JudgeLlmCall } from '../judge';
import type { GymLlmCall } from '../task-generator';

let containerUri: string;
let databaseUri: string;
let sql: postgres.Sql;
const dbName = `gymloop_${randomBytes(5).toString('hex')}`;
const WS = 'gym-loop-ws';
const SLUG = 'gymloopharness';

beforeAll(async () => {
  containerUri = await getTestPg();
  ({ databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName }));
  sql = postgres(databaseUri, { max: 4, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

function fakeAbDeps(): AbDeps {
  return {
    // Real gym-PG store (cheap PG writes): variants/tasks/runs/scores persist so the
    // gym_cycles FK to gym_variants is satisfied — faithful to the real runner. Only the
    // EXPENSIVE effects (the pipeline run + the judge/proposer LLM) are faked below.
    store: createGymStore(sql),
    runPipeline: async (input) => ({
      harnessSlug: `h${input.task.taskId.replace(/[^a-z0-9]/g, '')}`,
      clonePath: `/tmp/${input.task.taskId}`,
      workflowID: `wf-${input.task.taskId}-${input.variant.variantId}`,
      outcome: 'completed',
      pipelineUsd: 0.4,
    }),
    collectAndDistill: async ({ task }) => ({
      distilledTrace: `trace for ${task.taskId}`,
      traceRef: `ref-${task.taskId}`,
      rawSignals: task.pool === 'probe' ? { planted_bug_caught: true } : {},
    }),
    llmCall: (async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as JudgeLlmCall,
    newRunId: (v, t, r) => `${v}::${t}::${r}`,
    now: () => 0,
  };
}

// The candidate (overlay carries a worker override) scores higher than the baseline, so the
// loop ACCEPTS it — exercising the accept + record path. The judge reads the variant marker
// the fake engine embeds via the worker override presence: we encode the score in the intent
// but bump it for any run whose overlay changed the worker (the proposer's edit "worked").
function fakeJudge(): JudgeLlmCall {
  return async (opts) => {
    const content = opts.messages.map((m) => m.content).join('\n');
    const base = Number(/score:(\d+)/.exec(content)?.[1] ?? 5);
    return { text: JSON.stringify({ d1: base, d2: base, d3: base, rationale: `r-${base}` }), costUsd: 0.05, inputTokens: 1, outputTokens: 1 };
  };
}

const fakeProposer: GymLlmCall = async () => ({
  text: JSON.stringify({ promptOverrides: { worker: '# Worker\nRe-read the acceptance criteria before finishing.' }, rationale: 'targets the worst train task' }),
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const TASKS: LoopTask[] = [
  { taskId: 't-train', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:5', projectContext: 'p' },
  { taskId: 't-dev', pool: 'dev-anchor', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:6', projectContext: 'p' },
  { taskId: 't-probe', pool: 'probe', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:5', projectContext: 'p' },
  { taskId: 't-anchor', pool: 'real-anchor', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:7', projectContext: 'p' },
];

describe('autonomous loop → control plane (D-020)', () => {
  it('records each candidate as a reviewable gym_proposal + a gym_cycles row, and advances autoloop last_cycle', async () => {
    const deps = buildLoopDeps({
      gymSql: sql,
      ports: {} as never,
      judgeCall: fakeJudge(),
      proposerCall: fakeProposer,
      proposerModel: 'claude-sonnet-4-6',
      tasks: TASKS,
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit: 'deadbeef',
      workspaceId: WS,
      scratchRoot: '/tmp/scratch-loop',
      timeoutMs: 1000,
      pollIntervalMs: 10,
      maxDistillChars: 8000,
      abDeps: fakeAbDeps(),
      recordProposal: makeLoopProposalRecorder(sql, { workspaceId: WS, harnessSlug: SLUG }),
    });

    const result = await runOptimizationLoop(
      {
        thresholds: { epsilon: 0, delta: 1, costCeiling: 10 },
        baselineMeanCost: 1,
        baselineOfRecord: 0,
        dropThreshold: 1000,
        maxCycles: 1,
        budgetUsd: null,
        proposerModel: 'claude-sonnet-4-6',
        autoPromote: false,
      },
      deps,
    );

    expect(result.cycles).toBe(1);
    expect(result.breakerTripped).toBe(false);

    // The candidate's changed role (worker) is surfaced as a pending proposal.
    const proposals = await listProposals(sql, { workspaceId: WS, harnessSlug: SLUG, status: 'pending' });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const workerProp = proposals.find((p) => p.role === 'worker');
    expect(workerProp).toBeTruthy();
    expect(workerProp!.proposedMd).toContain('Re-read the acceptance');
    expect(workerProp!.originalMd).toBeNull(); // baseline had no worker override
    expect(workerProp!.probeStatus).toBe('pass');

    // The cycle audit row landed in the gym DB.
    const cycles = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_gym.gym_cycles`;
    expect(cycles[0].n).toBeGreaterThanOrEqual(1);

    // Autoloop config advanced its last_cycle.
    const cfg = await getAutoloop(sql, { workspaceId: WS, harnessSlug: SLUG });
    expect(cfg?.lastCycle).toBe(1);

    // D-014/P-028: the real-anchor pool is SCORED for every variant (surfaceable for the
    // falsifiability check) but never optimized — readPoolAggregates returns it distinctly
    // from the train pool.
    const rh = rubricHash(GYM_JUDGE_RUBRIC_V1);
    const anchor = await readPoolAggregates(sql, 'real-anchor', rh);
    expect(anchor.length).toBeGreaterThanOrEqual(1);
    expect(anchor.every((a) => a.meanComposite > 0 && a.n >= 1)).toBe(true);
    const trainAgg = await readPoolAggregates(sql, 'train', rh);
    expect(trainAgg.length).toBeGreaterThanOrEqual(1);
  });

  it('accepting a recorded proposal promotes the proposed prompt into harness_prompt_overrides', async () => {
    const pending = await listProposals(sql, { workspaceId: WS, harnessSlug: SLUG, status: 'pending' });
    const prop = pending.find((p) => p.role === 'worker')!;
    const res = await decideProposal(sql, { id: prop.id, workspaceId: WS, harnessSlug: SLUG, decision: 'accepted' });
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);

    const prompts = await getPrompts(sql, { workspaceId: WS, harnessSlug: SLUG });
    expect(prompts.roles.worker).toContain('Re-read the acceptance');
  });
});
