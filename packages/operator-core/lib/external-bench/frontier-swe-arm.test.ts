import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordinationSpec } from './coordination-topology';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { ProcExec } from './grader/swe-bench-pro';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { runFrontierSweArm, runFrontierSweResilient } from './frontier-swe-arm';
import { readRunResults } from './frontier-swe-resume';

const SPEC: CoordinationSpec = {
  arm: 'su-independent',
  claimModel: 'self-claim-fifo',
  broadcast: 'none',
  review: 'none',
  sharedState: 'both',
  team: 'per-backlog',
  disciplineForbid: [],
  central: false,
  aggregate: 'none',
  coordinator: 'none',
};

const ROW_META = { version: 'fs@test', modelId: 'claude-opus-4-8', harnessVersion: 'h1', preregHash: 'p1', rolloutId: 'r1' };

const CORPUS = [
  { instanceId: 'cranelift-codegen-opt', tier: 'performance', prompt: 'opt cranelift', dockerImage: 'img/cranelift:v6', gpus: 0, verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json' },
  { instanceId: 'git-to-zig', tier: 'implementation', prompt: 'port git', dockerImage: 'img/git:v4', gpus: 0, verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json' },
];

/** Fake docker for the seam: run→cid, exec-cat reward.txt→`reward`, verifier exec→0, rm→ok. */
function fakeSeamExec(reward = '0.5'): ProcExec {
  let n = 0;
  return async (_cmd, args) => {
    if (args[0] === 'run') return { stdout: `cid-${n++}\n`, stderr: '', code: 0 };
    if (args[0] === 'rm') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'exec' && args.includes('cat')) {
      const path = args[args.length - 1];
      return path.endsWith('reward.txt') ? { stdout: reward, stderr: '', code: 0 } : { stdout: '', stderr: 'no', code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 }; // the verifier exec
  };
}

/** Fake agent: always completes with a small fixed usage; submission = the container handle. */
const fakeRunAgent = async (input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => ({
  submission: input.handle,
  status: 'completed',
  modelCalls: 1,
  tokensIn: 10,
  tokensOut: 10,
  costUsd: 0.01,
  turns: 1,
});

let dir: string;
const prev = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-arm-'));
  writeFileSync(join(dir, 'tasks.jsonl'), CORPUS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = join(dir, 'tasks.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = prev;
});

function clock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

describe('runFrontierSweArm', () => {
  it('runs the arm over the cpu task-set → one frontier-swe row per task with the seam-read score', async () => {
    const res = await runFrontierSweArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 },
      seed: 0,
      runId: 'run1',
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec('0.5'),
    });
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => r.suite === 'frontier-swe')).toBe(true);
    expect(res.rows.every((r) => r.arm === 'su-independent')).toBe(true);
    expect(res.rows.every((r) => r.score === 0.5 && r.resolved === false)).toBe(true);
    expect(res.rows.every((r) => r.modality === 'in-container')).toBe(true);
    expect(res.skippedTaskIds).toEqual([]);
  });

  it('honours the iso-budget — exhausting maxModelCalls skips later tasks (counted false at report time)', async () => {
    const res = await runFrontierSweArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1 }, // one task spends 1 call → the next is skipped
      seed: 0,
      runId: 'run2',
      rowMeta: ROW_META,
      now: clock(),
      cap: 1,
      seamExec: fakeSeamExec('0.7'),
    });
    expect(res.rows.length + res.skippedTaskIds.length).toBe(2); // same denominator: every task accounted for
    expect(res.budgetExhausted).toBe(true);
  });
});

describe('runFrontierSweResilient — self-healing resume (P-010)', () => {
  it('runs only the missing (task, seed) trials and durably appends them', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    // Pre-seed: cranelift seed 0 already scored → must NOT be re-run.
    writeFileSync(
      resultsPath,
      JSON.stringify({ instanceId: 'cranelift-codegen-opt', seed: 0, arm: 'su-independent', score: 0.5, resolved: false, graderStatus: 'failed' }) + '\n',
    );

    const { perSeed, rows, alreadyComplete } = await runFrontierSweResilient({
      spec: SPEC,
      k: 2,
      resultsPath,
      runIdBase: 'resume1',
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 },
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec('0.6'),
    });

    expect(alreadyComplete).toBe(false);
    // Missing trials: cranelift seed1; git-to-zig seed0 + seed1 = 3 new rows (cranelift seed0 was skipped).
    expect(rows).toHaveLength(3);
    const ran = rows.map((r) => `${r.taskId}@${r.seed}`).sort();
    expect(ran).toEqual(['cranelift-codegen-opt@1', 'git-to-zig@0', 'git-to-zig@1']);
    expect(rows.every((r) => r.score === 0.6)).toBe(true);

    // Durable file now has the pre-seed + 3 appended = 4 records.
    const persisted = readRunResults(resultsPath);
    expect(persisted).toHaveLength(4);
    expect(perSeed.length).toBe(2); // seed 0 (git only) + seed 1 (both)
  });

  it('a fully-complete results file is a no-op resume (alreadyComplete)', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    const full = [];
    for (const id of ['cranelift-codegen-opt', 'git-to-zig']) {
      for (const seed of [0, 1]) {
        full.push(JSON.stringify({ instanceId: id, seed, arm: 'su-independent', score: 0.5, resolved: false, graderStatus: 'failed' }));
      }
    }
    writeFileSync(resultsPath, full.join('\n') + '\n');

    const { rows, alreadyComplete } = await runFrontierSweResilient({
      spec: SPEC,
      k: 2,
      resultsPath,
      runIdBase: 'resume2',
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000 },
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec(),
    });
    expect(alreadyComplete).toBe(true);
    expect(rows).toHaveLength(0);
  });
});
