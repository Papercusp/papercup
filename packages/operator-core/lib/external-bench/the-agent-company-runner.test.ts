/**
 * TheAgentCompany runner (plan benchmark-suite-theagentcompany-2026-06-17 Phase 2) — the generation
 * orchestration over INJECTED fake ops (NO docker, NO services, NO live arm). Proves: per-task lifecycle
 * (prepare → drive → teardown), the never-throw contract on every failure path, that ONLY a scored terminal
 * yields a gradable in-container submission (infra terminals are excluded), env is always torn down, and the
 * bounded pool drains the backlog within the fleet cap.
 */
import { describe, it, expect } from 'vitest';
import {
  runOneTacTask,
  TAC_BLUEPRINT_ID,
  type TacRunnerOps,
  type TacTaskEnv,
} from './the-agent-company-runner';
import type { BenchTask, GenerationStopReason, GenerationTelemetry } from './types';

function task(n: number): BenchTask {
  return {
    benchmark: 'the-agent-company',
    instanceId: `sde-task-${n}`,
    problemStatement: `task ${n}`,
    graderMeta: { image: `ghcr.io/theagentcompany/task-${n}:1.0.0`, category: 'sde', task_name: `sde-task-${n}` },
  };
}

function telemetry(stopReason: GenerationStopReason, over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return {
    tokensIn: 1000,
    tokensOut: 2000,
    costUsd: 9.5,
    turns: 12,
    wallClockMs: 60_000,
    trajectoryRef: 'tac://traj-x',
    stopReason,
    ...over,
  };
}

interface FakeOpts {
  cap?: number;
  throwOnPrepare?: Set<string>;
  throwOnDrive?: Set<string>;
  /** Per-task stopReason the drive reports (default 'done'). */
  stopReasons?: Record<string, GenerationStopReason>;
}

function fakeOps(record: string[], o: FakeOpts = {}): { ops: TacRunnerOps; maxLive: () => number } {
  const cap = o.cap ?? 3;
  let live = 0;
  let maxLive = 0;
  const ops: TacRunnerOps = {
    now: () => Date.now(),
    concurrencyCap: () => cap,
    async prepareTask({ task: t }) {
      record.push(`prepare:${t.instanceId}`);
      if (o.throwOnPrepare?.has(t.instanceId)) throw new Error(`pull boom ${t.instanceId}`);
      return { envRef: `ctr-${t.instanceId}`, image: String(t.graderMeta.image) };
    },
    async driveArm({ task: t }) {
      live += 1;
      if (live > maxLive) maxLive = live;
      record.push(`drive:${t.instanceId}`);
      await Promise.resolve();
      await Promise.resolve();
      try {
        if (o.throwOnDrive?.has(t.instanceId)) throw new Error(`drive boom ${t.instanceId}`);
        return { telemetry: telemetry(o.stopReasons?.[t.instanceId] ?? 'done') };
      } finally {
        live -= 1;
      }
    },
    async teardownTask({ env }) {
      record.push(`teardown:${env.envRef}`);
    },
  };
  return { ops, maxLive: () => maxLive };
}

describe('runOneTacTask', () => {
  it('clean drive (scored terminal) → attempt + in-container submission with the env ref', async () => {
    const record: string[] = [];
    const { ops } = fakeOps(record);
    const res = await runOneTacTask(ops, { task: task(1), arm: 'papercusp', budget: { maxUsd: 15 }, seed: 'seed-0', workspaceId: 'ws' });

    expect(res.attempt.stopReason).toBe('done');
    expect(res.attempt.blueprintId).toBe(TAC_BLUEPRINT_ID);
    expect(res.attempt.diff).toBe(''); // in-container suite: no diff
    expect(res.attempt.costUsd).toBe(9.5);
    expect((res.attempt.armMeta as { inContainer: boolean }).inContainer).toBe(true);
    expect(res.submission).not.toBeNull();
    expect(res.submission!.modality).toBe('in-container');
    expect(res.submission!.instanceId).toBe('sde-task-1');
    if (res.submission!.modality === 'in-container') expect(res.submission!.envRef).toBe('ctr-sde-task-1');
    // ordering: prepare → drive → teardown
    expect(record).toEqual(['prepare:sde-task-1', 'drive:sde-task-1', 'teardown:ctr-sde-task-1']);
  });

  it('a prepare (pull/init) failure → error attempt, NO submission, nothing to tear down', async () => {
    const record: string[] = [];
    const { ops } = fakeOps(record, { throwOnPrepare: new Set(['sde-task-2']) });
    const res = await runOneTacTask(ops, { task: task(2), arm: 'papercusp', budget: { maxUsd: 15 }, seed: 'seed-0', workspaceId: 'ws' });
    expect(res.attempt.stopReason).toBe('error');
    expect(res.attempt.generationError).toMatch(/pull boom/);
    expect(res.submission).toBeNull();
    expect(record).toEqual(['prepare:sde-task-2']); // no drive, no teardown (env never created)
  });

  it('a driveArm throw → infra-failed attempt, NO submission, env STILL torn down', async () => {
    const record: string[] = [];
    const { ops } = fakeOps(record, { throwOnDrive: new Set(['sde-task-3']) });
    const res = await runOneTacTask(ops, { task: task(3), arm: 'papercusp', budget: { maxUsd: 15 }, seed: 'seed-0', workspaceId: 'ws' });
    expect(res.attempt.stopReason).toBe('infra-failed');
    expect(res.attempt.generationError).toMatch(/drive boom/);
    expect(res.submission).toBeNull();
    expect(record).toContain('teardown:ctr-sde-task-3'); // finally always tears down
  });

  it('a NON-scored drive terminal (timeout/error) → attempt kept but NO submission (grader excludes it)', async () => {
    const record: string[] = [];
    const { ops } = fakeOps(record, { stopReasons: { 'sde-task-4': 'timeout' } });
    const res = await runOneTacTask(ops, { task: task(4), arm: 'papercusp', budget: { maxUsd: 15 }, seed: 'seed-0', workspaceId: 'ws' });
    expect(res.attempt.stopReason).toBe('timeout');
    expect(res.submission).toBeNull();
    expect(record).toContain('teardown:ctr-sde-task-4');
  });

  it('a scored-but-unresolved drive terminal (escalate/budget-exhausted) STILL yields a submission to grade', async () => {
    const record: string[] = [];
    const { ops } = fakeOps(record, { stopReasons: { 'sde-task-5': 'budget-exhausted' } });
    const res = await runOneTacTask(ops, { task: task(5), arm: 'papercusp', budget: { maxUsd: 15 }, seed: 'seed-0', workspaceId: 'ws' });
    expect(res.attempt.stopReason).toBe('budget-exhausted');
    expect(res.submission).not.toBeNull(); // the env is gradable even if the arm ran out of budget
  });
});

// The backlog/pool orchestration moved to `./tac-backlog-driver.ts` (built on the shared
// `makePoolBacklogDriver`); its pool-drain + never-throw + cap coverage lives in
// `./tac-backlog-driver.test.ts`. This file now covers only the per-task unit (`runOneTacTask`).
