/**
 * τ²-bench (tau2-bench) fleet-arm backlog driver tests
 * (plan benchmark-arms-su-vs-queen-expansion-2026-06-16; the dual-arm unification).
 *
 * Focus: the driver implements the canonical HiveBacklogDriver contract — emits a HiveBacklogResult
 * (FleetTaskResult[] + ConcurrencyTimeline) with reward/score/resolved + per-side cost on armMeta; the
 * arm→tau2 `--agent` mapping (incl. the degenerate 'su' → llm_agent); never-throws on a failing conversation
 * (reward null, excluded); respects the concurrency cap; runs on all three arms via runTau2SuiteViaFleet; and
 * the fleet↔Tau2SuiteResult round-trip (avg_reward + pass^1). FULLY STUBBED runConversation — no Python
 * subprocess, no LLM, no spend.
 */
import { describe, expect, it } from 'vitest';
import {
  makeTau2BacklogDriver,
  runTau2SuiteViaFleet,
  tau2AgentForArm,
  tau2TaskResultsFromFleet,
  type RunTau2Conversation,
  type Tau2ConversationResult,
} from './tau2-backlog';
import type { BenchTask } from './types';

const task = (n: number, domain = 'telecom'): BenchTask => ({
  benchmark: 'tau2-bench',
  instanceId: `tau2-task-${n}`,
  problemStatement: `task ${n}`,
  graderMeta: { domain },
});

const BACKLOG = [0, 1, 2, 3].map((n) => task(n));

/** A fake conversation seam keyed by instanceId → reward (1 solved, 0 failed); throws/infra-fails on opt-ins.
 *  Records the arm each task ran under so tests can assert arm switching. ZERO subprocess / LLM. */
function fakeConversation(opts: {
  rewardByTask?: Record<string, number>;
  defaultReward?: number;
  infraFail?: Set<string>;
  throwOn?: Set<string>;
  delayMs?: number;
  onLive?: (live: number) => void;
} = {}): { run: RunTau2Conversation; sawArm: Map<string, string> } {
  const sawArm = new Map<string, string>();
  let live = 0;
  const run: RunTau2Conversation = async ({ task: t, arm }) => {
    sawArm.set(t.instanceId, String(arm));
    live += 1;
    opts.onLive?.(live);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throwOn?.has(t.instanceId)) throw new Error(`drive boom ${t.instanceId}`);
      if (opts.infraFail?.has(t.instanceId)) {
        return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: 'sim infra fail' } satisfies Tau2ConversationResult;
      }
      const reward = opts.rewardByTask?.[t.instanceId] ?? opts.defaultReward ?? 1;
      return { reward, agentCostUsd: 0.5, userCostUsd: 0.25, stopReason: 'done', trajectoryRef: `traj-${t.instanceId}` } satisfies Tau2ConversationResult;
    } finally {
      live -= 1;
    }
  };
  return { run, sawArm };
}

describe('tau2AgentForArm', () => {
  it('maps baseline-opus → llm_agent, hive → papercup_hive, su → llm_agent (degenerate single-SUT)', () => {
    expect(tau2AgentForArm('baseline-opus')).toBe('llm_agent');
    expect(tau2AgentForArm('hive')).toBe('papercup_hive');
    expect(tau2AgentForArm('su')).toBe('llm_agent');
    // unknown arm defaults to the stock opus SUT
    expect(tau2AgentForArm('something-else')).toBe('llm_agent');
  });
});

describe('makeTau2BacklogDriver', () => {
  it('emits the canonical HiveBacklogResult with timeline + reward/score/resolved/cost + agent on armMeta', async () => {
    const { run } = fakeConversation({ rewardByTask: { 'tau2-task-0': 1, 'tau2-task-3': 0 } });
    const driver = makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'hive', suite: 'tau2-bench', runId: 'r1', seed: 0, backlog: BACKLOG, budget: {} });

    expect(res.arm).toBe('hive');
    expect(res.suite).toBe('tau2-bench');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults).toHaveLength(4);
    expect(res.concurrencyTimeline).toBeDefined();
    expect(res.peakConcurrentBees).toBeGreaterThanOrEqual(1);

    const t0 = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-0')!;
    expect(t0.attempt.armMeta!.suite).toBe('tau2-bench');
    expect(t0.attempt.armMeta!.agent).toBe('papercup_hive'); // hive arm → route-B agent
    expect(t0.attempt.armMeta!.reward).toBe(1);
    expect(t0.attempt.armMeta!.score).toBe(1);
    expect(t0.attempt.armMeta!.resolved).toBe(true);
    expect(t0.attempt.armMeta!.agentCostUsd).toBe(0.5);
    expect(t0.attempt.armMeta!.userCostUsd).toBe(0.25);
    expect(t0.attempt.costUsd).toBeCloseTo(0.75); // agent + user cost folded into the attempt
    expect(t0.attempt.stopReason).toBe('done');
    expect(t0.disposition).toBe('spawn');
    expect(t0.beeId).toBe('traj-tau2-task-0'); // trajectoryRef → beeId

    const t3 = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-3')!;
    expect(t3.attempt.armMeta!.reward).toBe(0); // unsolved
    expect(t3.attempt.armMeta!.resolved).toBe(false);
  });

  it('switches the tau2 --agent on the run arm (baseline-opus → llm_agent)', async () => {
    const { run, sawArm } = fakeConversation();
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 2, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'baseline-opus', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    // every task saw the run's arm, and the row carries the resolved --agent
    for (const id of BACKLOG.map((t) => t.instanceId)) expect(sawArm.get(id)).toBe('baseline-opus');
    expect(res.taskResults.every((t) => t.attempt.armMeta!.agent === 'llm_agent')).toBe(true);
  });

  it('never throws when a conversation throws — lands a non-scored (reward null) infra-failed row', async () => {
    const { run } = fakeConversation({ throwOn: new Set(['tau2-task-1']) });
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'su', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    expect(res.taskResults).toHaveLength(4);
    const failed = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-1')!;
    expect(failed.attempt.stopReason).toBe('infra-failed'); // excluded from scoring
    expect(failed.attempt.armMeta!.reward).toBeNull();
    expect(failed.attempt.armMeta!.resolved).toBeNull();
    expect(failed.attempt.generationError).toContain('drive boom');
    // the other three settled normally
    expect(res.taskResults.filter((t) => t.attempt.armMeta!.reward === 1)).toHaveLength(3);
  });

  it('honors an infra-failed conversation result (reward null) as a non-scored row', async () => {
    const { run } = fakeConversation({ infraFail: new Set(['tau2-task-2']) });
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'hive', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const failed = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-2')!;
    expect(failed.attempt.stopReason).toBe('infra-failed');
    expect(failed.attempt.armMeta!.reward).toBeNull();
  });

  it('respects the concurrency cap from deps', async () => {
    let maxLive = 0;
    const { run } = fakeConversation({ delayMs: 4, onLive: (l) => { maxLive = Math.max(maxLive, l); } });
    await makeTau2BacklogDriver({ concurrencyCap: () => 2, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'hive', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    expect(maxLive).toBeLessThanOrEqual(2);
    expect(maxLive).toBeGreaterThanOrEqual(2); // saturates the cap
  });
});

describe('tau2TaskResultsFromFleet (round-trip)', () => {
  it('reconstructs per-task results + avg_reward + pass^1 over scored rows from the fleet output', async () => {
    // 0,1 solved (reward 1); 3 unsolved (reward 0); 2 infra-failed (reward null, excluded).
    const { run } = fakeConversation({ rewardByTask: { 'tau2-task-0': 1, 'tau2-task-1': 1, 'tau2-task-3': 0 }, infraFail: new Set(['tau2-task-2']) });
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'hive', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const suite = tau2TaskResultsFromFleet(res);
    expect(suite.arm).toBe('hive');
    expect(suite.tasks).toHaveLength(4);
    expect(suite.scoredCount).toBe(3); // task-2 (infra) excluded
    expect(suite.avgReward).toBeCloseTo((1 + 1 + 0) / 3); // mean reward over scored rows
    expect(suite.passHat1).toBeCloseTo(2 / 3); // 2 of 3 scored rows resolved
    const t2 = suite.tasks.find((t) => t.instanceId === 'tau2-task-2')!;
    expect(t2.reward).toBeNull();
    expect(t2.resolved).toBeNull();
  });

  it('avg_reward / pass^1 are 0 when no rows scored', async () => {
    const { run } = fakeConversation({ infraFail: new Set(BACKLOG.map((t) => t.instanceId)) });
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'su', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const suite = tau2TaskResultsFromFleet(res);
    expect(suite.scoredCount).toBe(0);
    expect(suite.avgReward).toBe(0);
    expect(suite.passHat1).toBe(0);
  });
});

describe('runTau2SuiteViaFleet', () => {
  it('runs all three arms through the shared fleet contract → one canonical record per arm, with arm-specific agents', async () => {
    const banked: string[] = [];
    // hive resolves more than baseline/su (which only solve task-0) → asymmetric rewards by arm.
    const out = await runTau2SuiteViaFleet({
      tasks: BACKLOG,
      concurrencyCap: () => 3,
      sampleIntervalMs: 1,
      runConversationFor: (arm) =>
        fakeConversation(arm === 'hive' ? { defaultReward: 1 } : { rewardByTask: { 'tau2-task-0': 1 }, defaultReward: 0 }).run,
      onTaskCollected: (arm) => { banked.push(arm); },
    });

    expect(out.fleet.map((f) => f.fleetArm).sort()).toEqual(['baseline-opus', 'hive', 'su']);
    for (const f of out.fleet) {
      expect(f.result.suite).toBe('tau2-bench');
      expect(f.result.taskResults).toHaveLength(4);
      expect(f.result.peakConcurrentBees).toBeGreaterThanOrEqual(1);
    }
    expect(banked.length).toBe(12); // 4 tasks × 3 arms

    // The hive arm resolves MORE than baseline/su (the headline read off the same fleet output).
    const hive = tau2TaskResultsFromFleet(out.fleet.find((f) => f.fleetArm === 'hive')!.result);
    const baseline = tau2TaskResultsFromFleet(out.fleet.find((f) => f.fleetArm === 'baseline-opus')!.result);
    expect(hive.passHat1).toBeGreaterThan(baseline.passHat1);
    // su is the degenerate stock-opus arm → identical agent to baseline-opus.
    const su = out.fleet.find((f) => f.fleetArm === 'su')!.result;
    expect(su.taskResults.every((t) => t.attempt.armMeta!.agent === 'llm_agent')).toBe(true);
    const hiveRes = out.fleet.find((f) => f.fleetArm === 'hive')!.result;
    expect(hiveRes.taskResults.every((t) => t.attempt.armMeta!.agent === 'papercup_hive')).toBe(true);
  });

  it('honors an explicit single-arm list', async () => {
    const out = await runTau2SuiteViaFleet({
      tasks: BACKLOG,
      arms: ['baseline-opus'],
      concurrencyCap: () => 2,
      sampleIntervalMs: 1,
      runConversationFor: () => fakeConversation().run,
    });
    expect(out.fleet).toHaveLength(1);
    expect(out.fleet[0].fleetArm).toBe('baseline-opus');
  });
});
