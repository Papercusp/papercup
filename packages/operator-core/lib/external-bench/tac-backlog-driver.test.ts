/**
 * TheAgentCompany fleet-arm backlog driver tests (benchmark-suite-theagentcompany-2026-06-17, the dual-arm
 * unification). Focus: the driver implements the canonical HiveBacklogDriver contract — emits a
 * HiveBacklogResult (FleetTaskResult[] + ConcurrencyTimeline) with the in-container provenance (suite /
 * submitted / envRef) on armMeta; never-throws on a failing task (submitted=false, excluded from grading);
 * respects the concurrency cap; and runs on BOTH arms via runTheAgentCompanySuiteViaFleet. Fake ops — no
 * docker, no services, no live arm, no spend.
 */
import { describe, expect, it } from 'vitest';
import { theAgentCompanyBacklogDriver, runTheAgentCompanySuiteViaFleet } from './tac-backlog-driver';
import type { TacRunnerOps } from './the-agent-company-runner';
import type { BenchTask, GenerationStopReason, GenerationTelemetry } from './types';

const task = (n: number): BenchTask => ({
  benchmark: 'the-agent-company',
  instanceId: `sde-task-${n}`,
  problemStatement: `task ${n}`,
  graderMeta: { image: `ghcr.io/theagentcompany/task-${n}:1.0.0`, category: 'sde', task_name: `sde-task-${n}` },
});

function telemetry(stopReason: GenerationStopReason, over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return { tokensIn: 1000, tokensOut: 2000, costUsd: 9.5, turns: 12, wallClockMs: 60_000, trajectoryRef: '', stopReason, ...over };
}

interface FakeOpts {
  cap?: number;
  driveDelayMs?: number;
  throwOnDrive?: Set<string>;
  stopReasons?: Record<string, GenerationStopReason>;
}

/** Fake TacRunnerOps — mirrors the-agent-company-runner.test's fakeOps; no docker/services/arm. */
function fakeOps(o: FakeOpts = {}): { ops: TacRunnerOps; maxLive: () => number } {
  const cap = o.cap ?? 3;
  let live = 0;
  let maxLive = 0;
  const ops: TacRunnerOps = {
    now: () => Date.now(),
    concurrencyCap: () => cap,
    async prepareTask({ task: t }) {
      return { envRef: `ctr-${t.instanceId}`, image: String(t.graderMeta!.image) };
    },
    async driveArm({ task: t }) {
      live += 1;
      if (live > maxLive) maxLive = live;
      try {
        if (o.driveDelayMs) await new Promise((r) => setTimeout(r, o.driveDelayMs));
        if (o.throwOnDrive?.has(t.instanceId)) throw new Error(`drive boom ${t.instanceId}`);
        return { telemetry: telemetry(o.stopReasons?.[t.instanceId] ?? 'done') };
      } finally {
        live -= 1;
      }
    },
    async teardownTask() {},
  };
  return { ops, maxLive: () => maxLive };
}

const BACKLOG = [0, 1, 2, 3].map(task);

describe('theAgentCompanyBacklogDriver', () => {
  it('emits the canonical HiveBacklogResult with timeline + suite/submitted/envRef on armMeta', async () => {
    const { ops } = fakeOps();
    const driver = theAgentCompanyBacklogDriver(ops, { sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'the-agent-company', runId: 'r1', seed: 0, backlog: BACKLOG, budget: {} });

    expect(res.arm).toBe('su-independent');
    expect(res.suite).toBe('the-agent-company');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults).toHaveLength(4);
    expect(res.concurrencyTimeline).toBeDefined();
    expect(res.peakConcurrentBees).toBeGreaterThanOrEqual(1);

    const t0 = res.taskResults.find((t) => t.attempt.instanceId === 'sde-task-0')!;
    expect(t0.attempt.armMeta!.suite).toBe('the-agent-company');
    expect(t0.attempt.armMeta!.submitted).toBe(true); // a scored 'done' drive yields a gradable submission
    expect(t0.attempt.armMeta!.envRef).toBe('ctr-sde-task-0');
    expect(t0.attempt.armMeta!.inContainer).toBe(true); // preserved from the runner's stamp
    expect(t0.disposition).toBe('spawn');
    expect(t0.cupId).toBe('tac-sde-task-0-0'); // trajectoryRef empty → synthesized id
  });

  it('never throws when a drive op fails — lands a submitted=false (excluded) row', async () => {
    const { ops } = fakeOps({ throwOnDrive: new Set(['sde-task-1']) });
    const driver = theAgentCompanyBacklogDriver(ops, { sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'the-agent-company', runId: 'r', seed: 0, backlog: BACKLOG, budget: {} });

    expect(res.taskResults).toHaveLength(4);
    const failed = res.taskResults.find((t) => t.attempt.instanceId === 'sde-task-1')!;
    expect(failed.attempt.stopReason).toBe('infra-failed');
    expect(failed.attempt.armMeta!.submitted).toBe(false); // no gradable submission → grader excludes it
    expect(failed.attempt.armMeta!.envRef).toBeUndefined();
    // the other three still produced gradable submissions
    expect(res.taskResults.filter((t) => t.attempt.armMeta!.submitted === true)).toHaveLength(3);
  });

  it('respects the concurrency cap from ops', async () => {
    const { ops, maxLive } = fakeOps({ cap: 2, driveDelayMs: 4 });
    await theAgentCompanyBacklogDriver(ops, { sampleIntervalMs: 1 }).run({
      arm: 'su-independent', suite: 'the-agent-company', runId: 'r', seed: 0, backlog: BACKLOG, budget: {},
    });
    expect(maxLive()).toBeLessThanOrEqual(2);
    expect(maxLive()).toBeGreaterThanOrEqual(2); // saturates the cap
  });
});

describe('runTheAgentCompanySuiteViaFleet', () => {
  it('runs BOTH arms through the shared fleet contract → one canonical record per arm', async () => {
    const banked: string[] = [];
    const out = await runTheAgentCompanySuiteViaFleet({
      tasks: BACKLOG,
      opsFor: () => fakeOps().ops,
      sampleIntervalMs: 1,
      onTaskCollected: (arm) => { banked.push(arm); },
    });

    expect(out.fleet.map((f) => f.fleetArm).sort()).toEqual(['hive-realqueen', 'su-independent']);
    for (const f of out.fleet) {
      expect(f.result.suite).toBe('the-agent-company');
      expect(f.result.taskResults).toHaveLength(4);
      expect(f.result.peakConcurrentBees).toBeGreaterThanOrEqual(1);
    }
    expect(banked.length).toBe(8); // 4 tasks × 2 arms
  });

  it('honors an explicit single-arm list', async () => {
    const out = await runTheAgentCompanySuiteViaFleet({
      tasks: BACKLOG,
      arms: ['hive-realqueen'],
      opsFor: () => fakeOps().ops,
      sampleIntervalMs: 1,
    });
    expect(out.fleet).toHaveLength(1);
    expect(out.fleet[0].fleetArm).toBe('hive-realqueen');
  });
});
