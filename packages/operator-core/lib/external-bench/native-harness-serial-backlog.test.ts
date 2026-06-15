/**
 * Unit tests for the native-harness SERIAL-BACKLOG floor (P-024 / BRIEF 5). The per-task arm is
 * covered in native-harness-runner.test.ts; here we test the serial DRAIN + aggregation through a
 * fake per-task `runTask` that advances a shared clock (so backlogDrainMs is the genuine serial
 * elapsed), plus one end-to-end default-binding pass through fake spawn/clone ports.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../agent-chat-stream';
import { BASELINE_B_ARM, NATIVE_BLUEPRINT_ID } from './native-harness-config';
import type { NativeArmResult, NativeHarnessPorts } from './native-harness-runner';
import {
  runNativeSerialBacklog,
  runNativeSerialBacklogTerminalBench,
  serialToFleetRunSummary,
  terminalBenchSerialToFleetRunSummary,
  NATIVE_SERIAL_ARM,
  type RunNativeTask,
  type SerialBacklogItem,
} from './native-harness-serial-backlog';
import type { RunHarbor } from './native-harness-terminal-bench';
import type { ArmAttempt, BenchTask } from './types';

function task(instanceId: string): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId, problemStatement: `fix ${instanceId}`, repo: 'demo/demo', baseCommit: 'abc1234', graderMeta: {} };
}

function fakeResult(
  instanceId: string,
  over: Partial<ArmAttempt> = {},
  armMeta: Record<string, unknown> = {},
): NativeArmResult {
  const attempt: ArmAttempt = {
    arm: BASELINE_B_ARM,
    blueprintId: NATIVE_BLUEPRINT_ID,
    instanceId,
    seed: '0',
    diff: 'diff…',
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0.05,
    turns: 3,
    wallClockMs: 0,
    trajectoryRef: '',
    stopReason: 'done',
    ...over,
  };
  return { attempt, model: 'claude-opus-4-8', harnessVersion: 'claude-code/2.1.3', capped: false, armMeta };
}

describe('runNativeSerialBacklog', () => {
  it('drains the backlog in order and measures the TRUE serial wall-clock from the clock', async () => {
    let clock = 1000;
    const now = () => clock;
    const order: string[] = [];
    // Per-task durations advance the shared clock → backlogDrainMs = Σ durations (genuine serial).
    const durations: Record<string, number> = { a: 100, b: 250, c: 150 };
    const runTask: RunNativeTask = vi.fn(async (t: BenchTask, seed: string) => {
      order.push(t.instanceId);
      clock += durations[t.instanceId];
      return fakeResult(t.instanceId, { seed, wallClockMs: durations[t.instanceId], tokensIn: 100, tokensOut: 200, costUsd: 0.05 });
    });

    const backlog: SerialBacklogItem[] = [
      { task: task('a'), seed: '0' },
      { task: task('b'), seed: '0' },
      { task: task('c'), seed: '0' },
    ];
    const res = await runNativeSerialBacklog(backlog, { maxWallClockMs: 60_000 }, {} as NativeHarnessPorts, {}, { now, runTask });

    expect(order).toEqual(['a', 'b', 'c']); // strictly sequential, in backlog order
    expect(res.mode).toBe('serial-native');
    expect(res.modality).toBe('diff');
    expect(res.concurrency).toBe(1);
    expect(res.arm).toBe('baseline-b-native');
    expect(res.tasksAttempted).toBe(3);
    expect(res.attempts.map((r) => r.attempt.instanceId)).toEqual(['a', 'b', 'c']);

    // The serial drain time is the sum of the per-task durations (no overlap).
    expect(res.backlogDrainMs).toBe(500); // 100 + 250 + 150
    expect(res.sumTaskWallClockMs).toBe(500);
    expect(res.startedAtMs).toBe(1000);
    expect(res.endedAtMs).toBe(1500);

    // Aggregates summed across the backlog.
    expect(res.totalTokensIn).toBe(300);
    expect(res.totalTokensOut).toBe(600);
    expect(res.totalCostUsd).toBeCloseTo(0.15, 6);
    expect(runTask).toHaveBeenCalledTimes(3);
  });

  it('counts an infra-errored task (excluded from accuracy) toward the backlog + its real cost', async () => {
    const runTask: RunNativeTask = async (t) =>
      t.instanceId === 'b'
        ? fakeResult('b', { stopReason: 'error', generationError: 'rate limit exhausted', diff: '', tokensIn: 0, tokensOut: 0, costUsd: 0 })
        : fakeResult(t.instanceId, { costUsd: 0.05, tokensIn: 100, tokensOut: 200 });

    const res = await runNativeSerialBacklog(
      [{ task: task('a'), seed: '0' }, { task: task('b'), seed: '0' }, { task: task('c'), seed: '0' }],
      {},
      {} as NativeHarnessPorts,
      {},
      { now: () => 0, runTask },
    );
    expect(res.tasksAttempted).toBe(3); // the errored task is still an attempt on the backlog
    expect(res.attempts[1].attempt.stopReason).toBe('error');
    expect(res.totalCostUsd).toBeCloseTo(0.1, 6); // a + c only; the infra-failed task spent nothing here
  });

  it('handles an empty backlog (zero floor)', async () => {
    const res = await runNativeSerialBacklog([], {}, {} as NativeHarnessPorts, {}, { now: () => 42, runTask: async () => fakeResult('x') });
    expect(res.tasksAttempted).toBe(0);
    expect(res.attempts).toEqual([]);
    expect(res.backlogDrainMs).toBe(0);
    expect(res.totalCostUsd).toBe(0);
  });

  it('default runTask binds the per-task native arm end-to-end (fake spawn/clone ports)', async () => {
    const cleanup = vi.fn(async () => {});
    const ports: NativeHarnessPorts = {
      clone: vi.fn(async (t: BenchTask) => ({ dir: '/tmp/x', repo: t.repo ?? 'demo/demo', baseCommit: t.baseCommit ?? 'abc1234', cleanup })),
      extractDiff: vi.fn(async () => 'diff --git a/f b/f\n+fix\n'),
      spawnAgent: () => (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'tool_call', name: 'Edit', input: {} };
        yield { type: 'result', costUsd: 0.2, tokensIn: 500, tokensOut: 700, finalText: 'done', numTurns: 4 };
      })(),
      harnessVersion: async () => '2.1.3',
      now: () => 0,
    };
    const res = await runNativeSerialBacklog([{ task: task('only'), seed: '2' }], {}, ports);
    expect(res.tasksAttempted).toBe(1);
    expect(res.attempts[0].attempt.arm).toBe('baseline-b-native');
    expect(res.attempts[0].attempt.diff).toContain('+fix');
    expect(res.attempts[0].attempt.seed).toBe('2');
    expect(res.totalCostUsd).toBeCloseTo(0.2, 6);
    expect(res.totalTokensIn).toBe(500);
  });
});

describe('runNativeSerialBacklogTerminalBench — M2 (Harbor) serial floor', () => {
  it('drains a TB backlog serially, grades inline, and reports tasksResolved + serial timing', async () => {
    let clock = 0;
    const now = () => clock;
    const durations: Record<string, number> = { a: 100, b: 200, c: 50 };
    const resolvedMap: Record<string, boolean> = { a: true, b: false, c: true };
    const runHarbor: RunHarbor = vi.fn(async (spec) => {
      clock += durations[spec.taskId];
      return {
        resolved: resolvedMap[spec.taskId],
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.1,
        turns: 3,
        wallClockMs: durations[spec.taskId],
        harborVersion: 'terminal-bench@2.0',
        raw: { passed: resolvedMap[spec.taskId] },
      };
    });

    const res = await runNativeSerialBacklogTerminalBench(
      [{ task: task('a'), seed: '0' }, { task: task('b'), seed: '0' }, { task: task('c'), seed: '0' }],
      { maxWallClockMs: 60_000 },
      { runHarbor, now },
    );
    expect(res.mode).toBe('serial-native');
    expect(res.modality).toBe('in-container');
    expect(res.concurrency).toBe(1);
    expect(res.tasksAttempted).toBe(3);
    expect(res.tasksResolved).toBe(2); // a + c resolved, b failed
    expect(res.backlogDrainMs).toBe(350); // 100 + 200 + 50
    expect(res.sumTaskWallClockMs).toBe(350);
    expect(res.totalCostUsd).toBeCloseTo(0.3, 6);
    expect(res.results.map((r) => r.attempt.instanceId)).toEqual(['a', 'b', 'c']);
    expect(runHarbor).toHaveBeenCalledTimes(3);
  });

  it('excludes an in-sandbox infra failure (graderError) from tasksResolved', async () => {
    const runHarbor: RunHarbor = async (spec) => {
      if (spec.taskId === 'b') throw new Error('docker daemon down');
      return { resolved: true, tokensIn: 10, tokensOut: 20, costUsd: 0.01, harborVersion: 'tb@2.0', raw: {} };
    };
    const res = await runNativeSerialBacklogTerminalBench(
      [{ task: task('a'), seed: '0' }, { task: task('b'), seed: '0' }],
      {},
      { runHarbor, now: () => 0 },
    );
    expect(res.tasksAttempted).toBe(2);
    expect(res.tasksResolved).toBe(1); // 'a' resolved; 'b' is an infra error, not a genuine fail
    expect(res.results[1].grade.graderError).toContain('docker daemon down');
  });
});

describe('FleetRunSummary reconciliation (L2 serial floor → @papercusp/bench-metrics, arm native-serial)', () => {
  it('serialToFleetRunSummary projects the M1 floor; resolved supplied (post-hoc grade)', async () => {
    const res = await runNativeSerialBacklog(
      [{ task: task('a'), seed: '0' }, { task: task('b'), seed: '0' }, { task: task('c'), seed: '0' }],
      {},
      {} as NativeHarnessPorts,
      {},
      { now: () => 0, runTask: async (t, seed) => fakeResult(t.instanceId, { seed, tokensIn: 100, tokensOut: 200, costUsd: 0.05 }) },
    );
    const summary = serialToFleetRunSummary(res, { runId: 'run-1', suite: 'swe-bench-pro', resolved: 2 });
    expect(summary.arm).toBe(NATIVE_SERIAL_ARM);
    expect(summary.arm).toBe('native-serial');
    expect(summary.runId).toBe('run-1');
    expect(summary.suite).toBe('swe-bench-pro');
    expect(summary.tasks).toBe(3);
    expect(summary.resolved).toBe(2);
    expect(summary.wallClockMs).toBe(res.backlogDrainMs);
    expect(summary.tokensTotal).toBe(res.totalTokensIn + res.totalTokensOut);
    expect(summary.costUsd).toBeCloseTo(res.totalCostUsd, 6);
    expect(summary.tasksZeroHumanGate).toBe(3); // native arm = no human gate
    expect(summary.peakConcurrency).toBe(1);
  });

  it('terminalBenchSerialToFleetRunSummary uses Harbor-known resolved', async () => {
    const resolvedMap: Record<string, boolean> = { a: true, b: false, c: true };
    const res = await runNativeSerialBacklogTerminalBench(
      [{ task: task('a'), seed: '0' }, { task: task('b'), seed: '0' }, { task: task('c'), seed: '0' }],
      {},
      {
        now: () => 0,
        runHarbor: async (spec) => ({
          resolved: resolvedMap[spec.taskId],
          tokensIn: 100,
          tokensOut: 200,
          costUsd: 0.1,
          wallClockMs: 100,
          harborVersion: 'terminal-bench@2.0',
          raw: {},
        }),
      },
    );
    const summary = terminalBenchSerialToFleetRunSummary(res, { runId: 'run-1', suite: 'terminal-bench' });
    expect(summary.arm).toBe('native-serial');
    expect(summary.tasks).toBe(3);
    expect(summary.resolved).toBe(2); // a + c
    expect(summary.wallClockMs).toBe(res.backlogDrainMs);
    expect(summary.tokensTotal).toBe(res.totalTokensIn + res.totalTokensOut);
    expect(summary.peakConcurrency).toBe(1);
  });
});
