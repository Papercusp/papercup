/**
 * τ²-bench (tau2-bench) capability-INJECTION backlog driver tests
 * (plan benchmark-capability-injection-redesign-2026-06-17; P-009).
 *
 * Focus: the driver implements the canonical HiveBacklogDriver contract — emits a HiveBacklogResult
 * (FleetTaskResult[] + ConcurrencyTimeline) with reward/score/resolved + per-side cost on armMeta; the
 * two capability-injection arms (vanilla vs +memory) — the SAME `papercup_mem` agent, the arm selecting
 * whether a sandbox (the memory hive) is opened + threaded into each conversation; never-throws on a failing
 * conversation (reward null, excluded); respects the concurrency cap; runs both arms via runTau2SuiteViaFleet;
 * and the fleet↔Tau2SuiteResult round-trip (avg_reward + pass^1). FULLY STUBBED runConversation + openSandbox —
 * no Python subprocess, no LLM, no real hive, no spend.
 */
import { describe, expect, it } from 'vitest';
import {
  makeTau2BacklogDriver,
  runTau2SuiteViaFleet,
  tau2ArmHasMemory,
  tau2TaskResultsFromFleet,
  TAU2_AGENT,
  type OpenTau2Sandbox,
  type RunTau2Conversation,
  type Tau2ConversationResult,
  type Tau2MemoryContext,
} from './tau2-backlog';
import type { RunSandbox } from './capabilities';
import type { BenchTask } from './types';

const task = (n: number, domain = 'telecom'): BenchTask => ({
  benchmark: 'tau2-bench',
  instanceId: `tau2-task-${n}`,
  problemStatement: `task ${n}`,
  graderMeta: { domain },
});

const BACKLOG = [0, 1, 2, 3].map((n) => task(n));

/** A fake conversation seam keyed by instanceId → reward (1 solved, 0 failed); throws/infra-fails on opt-ins.
 *  Records the arm each task ran under + the memory context it saw so tests can assert arm/memory threading.
 *  ZERO subprocess / LLM. */
function fakeConversation(opts: {
  rewardByTask?: Record<string, number>;
  defaultReward?: number;
  infraFail?: Set<string>;
  throwOn?: Set<string>;
  delayMs?: number;
  onLive?: (live: number) => void;
} = {}): { run: RunTau2Conversation; sawArm: Map<string, string>; sawMemory: Map<string, Tau2MemoryContext | null> } {
  const sawArm = new Map<string, string>();
  const sawMemory = new Map<string, Tau2MemoryContext | null>();
  let live = 0;
  const run: RunTau2Conversation = async ({ task: t, arm, memory }) => {
    sawArm.set(t.instanceId, String(arm));
    sawMemory.set(t.instanceId, memory);
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
  return { run, sawArm, sawMemory };
}

/** A fake sandbox-open seam: for the +memory arm returns a stub RunSandbox (records dispose); null otherwise.
 *  No real hive boot, no MCP call. */
function fakeSandbox(): { open: OpenTau2Sandbox; opened: string[]; disposed: string[] } {
  const opened: string[] = [];
  const disposed: string[] = [];
  const open: OpenTau2Sandbox = async ({ arm, runId }) => {
    if (!tau2ArmHasMemory(arm)) return null;
    const hiveSlug = `xbench-cap-tau2-mem-${runId}`;
    opened.push(hiveSlug);
    const sandbox: RunSandbox = {
      id: { suite: 'tau2-bench', arm: String(arm), runId },
      hiveSlug,
      memberSlug: `${hiveSlug}-m`,
      workspaceId: 'papercusp-workspace',
      runTool: async () => ({ ok: true, payload: {} }),
      dispose: async () => {
        disposed.push(hiveSlug);
      },
    };
    return sandbox;
  };
  return { open, opened, disposed };
}

describe('tau2ArmHasMemory', () => {
  it('only the +memory arm has memory; vanilla + unknown arms do not', () => {
    expect(tau2ArmHasMemory('+memory')).toBe(true);
    expect(tau2ArmHasMemory('vanilla')).toBe(false);
    expect(tau2ArmHasMemory('something-else')).toBe(false);
  });
});

describe('makeTau2BacklogDriver', () => {
  it('emits the canonical HiveBacklogResult with timeline + reward/score/resolved/cost + agent/memory on armMeta', async () => {
    const { run } = fakeConversation({ rewardByTask: { 'tau2-task-0': 1, 'tau2-task-3': 0 } });
    const { open } = fakeSandbox();
    const driver = makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, openSandbox: open, sampleIntervalMs: 1 });
    const res = await driver.run({ arm: '+memory', suite: 'tau2-bench', runId: 'r1', seed: 0, backlog: BACKLOG, budget: {} });

    expect(res.arm).toBe('+memory');
    expect(res.suite).toBe('tau2-bench');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults).toHaveLength(4);
    expect(res.concurrencyTimeline).toBeDefined();
    expect(res.peakConcurrentBees).toBeGreaterThanOrEqual(1);

    const t0 = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-0')!;
    expect(t0.attempt.armMeta!.suite).toBe('tau2-bench');
    expect(t0.attempt.armMeta!.agent).toBe(TAU2_AGENT); // single vendored agent for both arms
    expect(t0.attempt.armMeta!.memory).toBe(true); // +memory arm → capability attribution
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

  it('the +memory arm opens ONE sandbox for the run, threads its hive into every conversation, and disposes it after', async () => {
    const { run, sawMemory } = fakeConversation();
    const { open, opened, disposed } = fakeSandbox();
    await makeTau2BacklogDriver({ concurrencyCap: () => 2, runConversation: run, openSandbox: open, sampleIntervalMs: 1 }).run({
      arm: '+memory', suite: 'tau2-bench', runId: 'rm', seed: 0, backlog: BACKLOG, budget: {},
    });
    // exactly one sandbox opened for the whole run, then disposed (memory accumulates across tasks → wiped at end)
    expect(opened).toHaveLength(1);
    expect(disposed).toEqual(opened);
    // every task saw the SAME hive context (the shared, accumulating namespace)
    const hives = new Set([...sawMemory.values()].map((m) => m?.hiveSlug));
    expect(hives.size).toBe(1);
    expect([...hives][0]).toBe(opened[0]);
    for (const id of BACKLOG.map((t) => t.instanceId)) {
      expect(sawMemory.get(id)?.hiveSlug).toBe(opened[0]);
    }
  });

  it('the vanilla arm opens NO sandbox and threads null memory into every conversation (degrades to stock)', async () => {
    const { run, sawArm, sawMemory } = fakeConversation();
    const { open, opened } = fakeSandbox();
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 2, runConversation: run, openSandbox: open, sampleIntervalMs: 1 }).run({
      arm: 'vanilla', suite: 'tau2-bench', runId: 'rv', seed: 0, backlog: BACKLOG, budget: {},
    });
    expect(opened).toHaveLength(0); // vanilla → no sandbox
    for (const id of BACKLOG.map((t) => t.instanceId)) {
      expect(sawArm.get(id)).toBe('vanilla');
      expect(sawMemory.get(id)).toBeNull();
    }
    // the row records the single agent + memory=false (attribution)
    expect(res.taskResults.every((t) => t.attempt.armMeta!.agent === TAU2_AGENT)).toBe(true);
    expect(res.taskResults.every((t) => t.attempt.armMeta!.memory === false)).toBe(true);
  });

  it('the +memory arm degrades (no memory) when the sandbox open fails — does NOT abort the run', async () => {
    const { run, sawMemory } = fakeConversation();
    const failingOpen: OpenTau2Sandbox = async () => {
      throw new Error('hive boot boom');
    };
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, openSandbox: failingOpen, sampleIntervalMs: 1 }).run({
      arm: '+memory', suite: 'tau2-bench', runId: 'rfail', seed: 0, backlog: BACKLOG, budget: {},
    });
    expect(res.taskResults).toHaveLength(4); // run still completed
    for (const id of BACKLOG.map((t) => t.instanceId)) expect(sawMemory.get(id)).toBeNull(); // ran without memory
  });

  it('never throws when a conversation throws — lands a non-scored (reward null) infra-failed row', async () => {
    const { run } = fakeConversation({ throwOn: new Set(['tau2-task-1']) });
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'vanilla', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
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
    const { open } = fakeSandbox();
    const res = await makeTau2BacklogDriver({ concurrencyCap: () => 3, runConversation: run, openSandbox: open, sampleIntervalMs: 1 }).run({
      arm: '+memory', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const failed = res.taskResults.find((t) => t.attempt.instanceId === 'tau2-task-2')!;
    expect(failed.attempt.stopReason).toBe('infra-failed');
    expect(failed.attempt.armMeta!.reward).toBeNull();
  });

  it('respects the concurrency cap from deps', async () => {
    let maxLive = 0;
    const { run } = fakeConversation({ delayMs: 4, onLive: (l) => { maxLive = Math.max(maxLive, l); } });
    await makeTau2BacklogDriver({ concurrencyCap: () => 2, runConversation: run, sampleIntervalMs: 1 }).run({
      arm: 'vanilla', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
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
      arm: 'vanilla', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const suite = tau2TaskResultsFromFleet(res);
    expect(suite.arm).toBe('vanilla');
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
      arm: 'vanilla', suite: 'tau2-bench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    const suite = tau2TaskResultsFromFleet(res);
    expect(suite.scoredCount).toBe(0);
    expect(suite.avgReward).toBe(0);
    expect(suite.passHat1).toBe(0);
  });
});

describe('runTau2SuiteViaFleet', () => {
  it('runs both arms through the shared fleet contract → one canonical record per arm, +memory lifts over vanilla', async () => {
    const banked: string[] = [];
    // +memory resolves more than vanilla (which only solves task-0) → asymmetric rewards by arm (the lift).
    const out = await runTau2SuiteViaFleet({
      tasks: BACKLOG,
      concurrencyCap: () => 3,
      sampleIntervalMs: 1,
      runConversationFor: (arm) =>
        fakeConversation(tau2ArmHasMemory(arm) ? { defaultReward: 1 } : { rewardByTask: { 'tau2-task-0': 1 }, defaultReward: 0 }).run,
      openSandboxFor: () => fakeSandbox().open,
      onTaskCollected: (arm) => { banked.push(arm); },
    });

    expect(out.fleet.map((f) => f.fleetArm).sort()).toEqual(['+memory', 'vanilla']);
    for (const f of out.fleet) {
      expect(f.result.suite).toBe('tau2-bench');
      expect(f.result.taskResults).toHaveLength(4);
      expect(f.result.peakConcurrentBees).toBeGreaterThanOrEqual(1);
    }
    expect(banked.length).toBe(8); // 4 tasks × 2 arms

    // The +memory arm resolves MORE than vanilla (the headline read off the same fleet output).
    const mem = tau2TaskResultsFromFleet(out.fleet.find((f) => f.fleetArm === '+memory')!.result);
    const vanilla = tau2TaskResultsFromFleet(out.fleet.find((f) => f.fleetArm === 'vanilla')!.result);
    expect(mem.passHat1).toBeGreaterThan(vanilla.passHat1);
    // both arms run the SAME single vendored agent; only the memory-attribution flag differs.
    const memRes = out.fleet.find((f) => f.fleetArm === '+memory')!.result;
    const vanRes = out.fleet.find((f) => f.fleetArm === 'vanilla')!.result;
    expect(memRes.taskResults.every((t) => t.attempt.armMeta!.agent === TAU2_AGENT)).toBe(true);
    expect(vanRes.taskResults.every((t) => t.attempt.armMeta!.agent === TAU2_AGENT)).toBe(true);
    expect(memRes.taskResults.every((t) => t.attempt.armMeta!.memory === true)).toBe(true);
    expect(vanRes.taskResults.every((t) => t.attempt.armMeta!.memory === false)).toBe(true);
  });

  it('honors an explicit single-arm list', async () => {
    const out = await runTau2SuiteViaFleet({
      tasks: BACKLOG,
      arms: ['vanilla'],
      concurrencyCap: () => 2,
      sampleIntervalMs: 1,
      runConversationFor: () => fakeConversation().run,
    });
    expect(out.fleet).toHaveLength(1);
    expect(out.fleet[0].fleetArm).toBe('vanilla');
  });
});
