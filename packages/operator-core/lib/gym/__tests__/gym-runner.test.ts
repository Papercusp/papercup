import { describe, it, expect } from 'vitest';
import { runGymPipeline } from '../gym-runner';
import type { GymRunnerPorts, GymRunSpec } from '../gym-runner';

/**
 * The runner orchestrates one hermetic run: clone → register throwaway harness →
 * apply variant overlay → file feature → start pipeline → poll to terminal. All
 * effects are injected, so the SEQUENCING + teardown-on-setup-failure logic is
 * tested with fakes (no live operator, no real agents). Artifacts are NOT torn
 * down by the runner — the trace collector (P-002) reads the clone + schema after.
 */
function makeSpec(overrides: Partial<GymRunSpec> = {}): GymRunSpec {
  return {
    task: {
      id: 'task-1',
      source: '/repos/substrate',
      commit: '0123456789abcdef0123456789abcdef01234567',
      spec: 'Add a /health endpoint',
      intent: 'Operators need a liveness probe',
    },
    variant: { id: 'baseline', overlay: { promptOverrides: {} } },
    cycle: 0,
    harnessCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym/clones',
    timeoutMs: 1000,
    pollIntervalMs: 100,
    ...overrides,
  };
}

interface FakeOpts {
  poll: Array<{ workflowStatus: string; featureStatus: string | null }>;
  throwOn?: keyof GymRunnerPorts;
}

function makePorts(opts: FakeOpts) {
  const calls: string[] = [];
  const overrideOps: Array<{ role: string; promptMd: string }> = [];
  let clock = 0;
  let pollIdx = 0;
  const maybeThrow = (name: keyof GymRunnerPorts) => {
    calls.push(name);
    if (opts.throwOn === name) throw new Error(`boom:${name}`);
  };
  const ports: GymRunnerPorts = {
    async cloneSubstrate() { maybeThrow('cloneSubstrate'); },
    async registerThrowawayHarness() { maybeThrow('registerThrowawayHarness'); },
    async applyPromptOverride(i) { maybeThrow('applyPromptOverride'); overrideOps.push({ role: i.role, promptMd: i.promptMd }); },
    async fileFeature() { maybeThrow('fileFeature'); },
    async startPipeline() { maybeThrow('startPipeline'); return { workflowID: 'pipeline:gym-x:F-GYM-AA:e0' }; },
    async pollStatus() {
      maybeThrow('pollStatus');
      const snap = opts.poll[Math.min(pollIdx, opts.poll.length - 1)];
      pollIdx++;
      return snap;
    },
    async teardownHarness() { maybeThrow('teardownHarness'); },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { ports, calls, overrideOps };
}

describe('runGymPipeline', () => {
  it('runs the full setup sequence then polls to a terminal outcome', async () => {
    const { ports, calls } = makePorts({
      poll: [{ workflowStatus: 'PENDING', featureStatus: 'in_progress' }, { workflowStatus: 'SUCCESS', featureStatus: 'passed' }],
    });
    const result = await runGymPipeline(makeSpec(), ports);

    expect(result.outcome).toBe('passed');
    expect(result.terminal).toBe(true);
    expect(result.workflowID).toBe('pipeline:gym-x:F-GYM-AA:e0');
    expect(result.harnessSlug).toMatch(/^gym[a-z0-9]+$/); // hyphen-free (valid PG schema)
    expect(result.clonePath).toBe(`/scratch/gym/clones/${result.harnessSlug}`);
    // Setup happens before the first poll; the runner does NOT tear down.
    expect(calls.slice(0, 5)).toEqual([
      'cloneSubstrate', 'registerThrowawayHarness', 'fileFeature', 'startPipeline', 'pollStatus',
    ]);
    expect(calls).not.toContain('teardownHarness');
  });

  it('applies one prompt-override op per overridden role', async () => {
    const { ports, calls, overrideOps } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    await runGymPipeline(
      makeSpec({ variant: { id: 'cand', overlay: { promptOverrides: { worker: '# w2', validator: '# v2' } } } }),
      ports,
    );
    expect(overrideOps).toEqual([
      { role: 'validator', promptMd: '# v2' },
      { role: 'worker', promptMd: '# w2' },
    ]);
    expect(calls.filter((c) => c === 'applyPromptOverride')).toHaveLength(2);
  });

  it('applies NO overrides for the baseline (empty overlay)', async () => {
    const { ports, calls } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    await runGymPipeline(makeSpec(), ports);
    expect(calls).not.toContain('applyPromptOverride');
  });

  it('returns timeout when the pipeline never terminates within the deadline', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'PENDING', featureStatus: 'in_progress' }] });
    const result = await runGymPipeline(makeSpec({ timeoutMs: 300, pollIntervalMs: 100 }), ports);
    expect(result.outcome).toBe('timeout');
    expect(result.terminal).toBe(true);
  });

  it('measures the immutable oracle before and after the pipeline and emits regressions only when both are measured', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let oracleRun = 0;
    ports.runOracle = async () => {
      oracleRun += 1;
      return [{ name: 'oracle > preserves behaviour', passed: oracleRun === 1 }];
    };

    const result = await runGymPipeline(
      makeSpec({
        task: {
          ...makeSpec().task,
          oracle: {
            testPath: 'oracle.test.js',
            implPath: 'impl.js',
            pinCommit: 'fedcba9876543210fedcba9876543210fedcba98',
            sourceRef: 'WI-ORACLE',
          },
        },
      }),
      ports,
    );

    expect(oracleRun).toBe(2);
    expect(result.deterministicSignals).toEqual({ regressions: true });
  });

  it('tears down on a setup failure and never starts the pipeline', async () => {
    const { ports, calls } = makePorts({
      poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }],
      throwOn: 'registerThrowawayHarness',
    });
    await expect(runGymPipeline(makeSpec(), ports)).rejects.toThrow(/boom:registerThrowawayHarness/);
    expect(calls).toContain('teardownHarness');
    expect(calls).not.toContain('startPipeline');
  });
});
