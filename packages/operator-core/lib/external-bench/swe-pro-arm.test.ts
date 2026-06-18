import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordinationSpec, TopologyBlueprintView } from './coordination-topology';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { BenchTask, CloneTaskRepo, ExtractDiff, TaskCheckout } from './types';
import { runSweProArm, sweProRowMeta, resolveSweProFrameworkSpec } from './swe-pro-arm';

const SPEC: CoordinationSpec = {
  arm: 'dist-broadcast',
  claimModel: 'self-claim-priority',
  broadcast: 'topic',
  review: 'none',
  sharedState: 'both',
  team: 'per-backlog',
  disciplineForbid: [],
  central: false,
  aggregate: 'none',
  coordinator: 'none',
};

const ROW_META = { version: 'pro@test', modelId: 'claude-opus-4-8', harnessVersion: 'h1', preregHash: 'p1', rolloutId: 'r1' };

/** A 2-task SWE-Pro pilot corpus injected via the loader's env override (hermetic — no disk dataset). */
const CORPUS = [
  { instance_id: 'acme__widget-1', problem_statement: 'fix the widget', base_commit: 'a'.repeat(40), language: 'python', tier: 'medium' },
  { instance_id: 'acme__gadget-2', problem_statement: 'fix the gadget', base_commit: 'b'.repeat(40), language: 'go', tier: 'hard' },
];

/** Fake clone: a throwaway worktree handle per task (the agent "edits" it in place; the seam reads the diff). */
const fakeClone: CloneTaskRepo = async (task: BenchTask): Promise<TaskCheckout> => ({
  dir: `/tmp/wt-${task.instanceId}`,
  repo: task.repo ?? 'org/repo',
  baseCommit: task.baseCommit ?? '',
  cleanup: async () => {},
});
/** Fake diff-extract: a non-empty diff so the seam runs the (fake) grader rather than short-circuiting empty. */
const fakeExtract: ExtractDiff = async (): Promise<string> => 'diff --git a/x b/x\n+fix';

/** Fake agent: completes with a small fixed usage + coordCalls (the C4 evidence the driver sums). */
const fakeRunAgent = async (input: RunAgentInput<TaskCheckout>): Promise<AgentRunOutput> => ({
  submission: 'done',
  status: 'completed',
  modelCalls: 1,
  tokensIn: 10,
  tokensOut: 10,
  costUsd: 0.01,
  turns: 3,
  coordCalls: 5,
  handle: input.handle,
} as AgentRunOutput);

function clock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

let dir: string;
const prev = process.env.PAPERCUSP_BENCH_PILOT_JSONL;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swe-pro-arm-'));
  writeFileSync(join(dir, 'tasks.jsonl'), CORPUS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.PAPERCUSP_BENCH_PILOT_JSONL = join(dir, 'tasks.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.PAPERCUSP_BENCH_PILOT_JSONL;
  else process.env.PAPERCUSP_BENCH_PILOT_JSONL = prev;
});

describe('runSweProArm', () => {
  it('runs the arm over the pilot → one swe-bench-pro diff-row per task with the seam grade + coordCalls (C4)', async () => {
    const res = await runSweProArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      gradeDiff: async () => true, // the fake official grader resolves both
      cloneTaskRepo: fakeClone,
      extractDiff: fakeExtract,
      budget: { maxModelCalls: 1000 },
      seed: 0,
      runId: 'run1',
      rowMeta: ROW_META,
      now: clock(),
    });
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => r.suite === 'swe-bench-pro')).toBe(true);
    expect(res.rows.every((r) => r.modality === 'diff')).toBe(true);
    expect(res.rows.every((r) => r.arm === 'dist-broadcast')).toBe(true);
    expect(res.rows.every((r) => r.resolved === true && r.graderStatus === 'passed')).toBe(true);
    // The driver sums the agent's coordCalls onto armMeta — the C4 evidence the fairness audit reads.
    expect(res.rows.every((r) => (r.armMeta as { coordCalls?: number } | undefined)?.coordCalls === 5)).toBe(true);
    expect(res.skippedTaskIds).toEqual([]);
  });

  it('an empty diff → a SCORED capability-fail row (resolved:false, graderStatus "failed" — NOT infra); grader skipped', async () => {
    let graderCalls = 0;
    const res = await runSweProArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      gradeDiff: async () => { graderCalls++; return true; },
      cloneTaskRepo: fakeClone,
      extractDiff: async () => '   ', // whitespace-only ⇒ empty diff
      budget: { maxModelCalls: 1000 },
      seed: 0,
      runId: 'run-empty',
      rowMeta: ROW_META,
      now: clock(),
    });
    expect(graderCalls).toBe(0); // empty diff short-circuits the (expensive) grader
    // 'failed' (canonical, scored) — NOT 'error'. An empty-diff fail must stay in the exclude-infra
    // denominator (a real capability-fail), never get dropped as infra (the C1 flatter-the-arm trap).
    expect(res.rows.every((r) => r.resolved === false && r.graderStatus === 'failed')).toBe(true);
  });

  it('honours the iso-budget — exhausting maxModelCalls skips later tasks (same denominator: every task accounted for)', async () => {
    const res = await runSweProArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      gradeDiff: async () => false,
      cloneTaskRepo: fakeClone,
      extractDiff: fakeExtract,
      budget: { maxModelCalls: 1 }, // one task spends 1 call → the next is skipped
      seed: 0,
      runId: 'run2',
      rowMeta: ROW_META,
      now: clock(),
      cap: 1,
    });
    expect(res.rows.length + res.skippedTaskIds.length).toBe(2);
    expect(res.budgetExhausted).toBe(true);
  });
});

describe('sweProRowMeta', () => {
  it('stamps the swe-bench-pro suite + grader family + a default price-table version', () => {
    const m = sweProRowMeta(ROW_META);
    expect(m).toMatchObject({ suite: 'swe-bench-pro', graderFamily: 'swe-bench-pro', graderVersion: 'pro@test', priceTableVersion: 'price-table-v1' });
  });
});

describe('resolveSweProFrameworkSpec (P-012 framework selection, P-013 2-axis)', () => {
  const BLUEPRINTS: Record<string, TopologyBlueprintView> = {
    'su-independent': { id: 'su-independent', kind: 'harness', spine: { claimModel: 'self-claim-fifo' }, coordination: { broadcast: 'none' } },
    hive: { id: 'hive', kind: 'hive', spine: { claimModel: 'decider-dispatch' } },
  };
  const lookup = (id: string): TopologyBlueprintView => BLUEPRINTS[id];

  it('resolves BOTH axes: topology spec + per-task solver; vanilla & su share topology, differ ONLY in solver', () => {
    const vanilla = resolveSweProFrameworkSpec('vanilla', lookup);
    expect(vanilla.spec).toMatchObject({ arm: 'su-independent', broadcast: 'none', central: false });
    expect(vanilla.solverBlueprint).toBe('coding-solo'); // the bare floor

    const su = resolveSweProFrameworkSpec('su', lookup);
    expect(su.spec).toMatchObject({ arm: 'su-independent', broadcast: 'none', central: false }); // SAME topology as vanilla
    expect(su.solverBlueprint).toBe('external-bench'); // su spine — the ONLY delta vs vanilla ⇒ isolates the su capability

    const hive = resolveSweProFrameworkSpec('hive', lookup);
    expect(hive.spec).toMatchObject({ arm: 'hive', central: true }); // kind:'hive' ⇒ central orchestrator
    expect(hive.solverBlueprint).toBe('external-bench'); // SAME solver as su — the ONLY delta vs su is topology ⇒ isolates coordination
  });
});
