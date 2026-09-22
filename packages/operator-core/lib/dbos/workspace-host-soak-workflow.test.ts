import { describe, expect, it, vi } from 'vitest';

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerWorkflow: (fn: unknown) => fn, runStep: vi.fn(), sleep: vi.fn(), startWorkflow: vi.fn() },
  WorkflowQueue: class {
    constructor(readonly name: string) {}
  },
}));

import { resolveWorkspaceHostSoakPolicy, type WorkspaceHostSoakInstanceReading, type WorkspaceHostSoakSample } from '../workspace-host/soak';
import type { WorkspaceHostSoakReleaseBinding } from '../workspace-host/soak-receipt';
import {
  runWorkspaceHostSoak,
  workspaceHostSoakWorkflowKeys,
  type WorkspaceHostSoakRuntime,
  type WorkspaceHostSoakWorkflowInput,
} from './workspace-host-soak-workflow';

const IMAGE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918';
const RUNNING: WorkspaceHostSoakInstanceReading = {
  kind: 'observed',
  status: 'RUNNING',
  instanceId: '1100961087771032429',
  sourceImage: IMAGE,
};
/** 10 minutes sampled every minute: 11 expected samples. */
const POLICY = resolveWorkspaceHostSoakPolicy({ durationMs: 10 * 60_000, intervalMs: 60_000 });
const PROBE_COST_MS = 20_000;

const BINDING: WorkspaceHostSoakReleaseBinding = {
  taskId: 'task-1',
  operationId: 'op-1',
  bundleSha256: 'a'.repeat(64),
  sourceSha: 'b'.repeat(40),
  gitlinks: {},
  version: '0.0.20',
};

function input(overrides: Partial<WorkspaceHostSoakWorkflowInput> = {}): WorkspaceHostSoakWorkflowInput {
  return {
    workspaceId: 'ws-1',
    hostId: 'host-1',
    soakId: 'soak-1',
    policy: POLICY,
    releaseBinding: null,
    requestedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  runtime: WorkspaceHostSoakRuntime;
  stored: WorkspaceHostSoakSample[];
  sleeps: number[];
  steps: string[];
}

/**
 * A fake runtime with a real clock model: each reading costs PROBE_COST_MS, each sleep advances
 * the clock by exactly what was asked, and `readings(n)` scripts what sample n observes.
 */
function harness(options: {
  readings?: (sampleIndex: number) => WorkspaceHostSoakInstanceReading;
  seamsFail?: (sampleIndex: number) => boolean;
  persisted?: (stored: WorkspaceHostSoakSample[]) => WorkspaceHostSoakSample[];
} = {}): Harness {
  let clock = Date.parse('2026-09-23T00:00:00.000Z');
  let resolveCount = 0;
  const stored: WorkspaceHostSoakSample[] = [];
  const sleeps: number[] = [];
  const steps: string[] = [];
  const runtime: WorkspaceHostSoakRuntime = {
    step: async (name, fn) => {
      steps.push(name);
      return fn();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    resolveSeams: async () => {
      // The pin step resolves once before sampling; sample n is resolve call n+1.
      const sampleIndex = resolveCount - 1;
      resolveCount += 1;
      if (sampleIndex >= 0 && options.seamsFail?.(sampleIndex)) throw new Error('controller profile unreadable');
      const reading = sampleIndex >= 0 ? (options.readings?.(sampleIndex) ?? RUNNING) : RUNNING;
      return {
        readInstance: async () => reading,
        probeFor: () => ({
          now: () => new Date(clock),
          readInstance: async () => {
            clock += PROBE_COST_MS;
            return reading;
          },
          probeReach: async () => ({ kind: 'reached' }),
        }),
      };
    },
    recordSample: async ({ sample }) => {
      stored.push(sample);
    },
    readSoak: async (_workspaceId, _hostId, soakId) => ({
      soakId,
      envelope: null,
      samples: options.persisted ? options.persisted(stored) : [...stored],
      malformedRows: 0,
    }),
    beginReceipt: vi.fn(async () => ({ requestIdentity: 'req-1', adopted: false })),
    settleReceipt: vi.fn(async () => undefined),
  };
  return { runtime, stored, sleeps, steps };
}

describe('runWorkspaceHostSoak', () => {
  it('POSITIVE CONTROL: samples a clean host until the window is covered, then passes', async () => {
    const h = harness();
    const result = await runWorkspaceHostSoak(input(), h.runtime);
    expect(result.evaluation.verdict).toBe('pass');
    expect(h.stored).toHaveLength(11);
    expect(result.subject).toEqual({
      workspaceId: 'ws-1',
      hostId: 'host-1',
      soakId: 'soak-1',
      instanceId: RUNNING.kind === 'observed' ? RUNNING.instanceId : '',
      image: IMAGE,
    });
    expect(result.receipt).toBe('none');
  });

  it('schedules each wake against the FIRST sample, so probe cost does not drift the cadence', async () => {
    const h = harness();
    await runWorkspaceHostSoak(input(), h.runtime);
    // Every sleep is interval minus the probe's own 20s, never a flat interval.
    expect(h.sleeps).toEqual(Array.from({ length: 10 }, () => POLICY.intervalMs - PROBE_COST_MS));
    const starts = h.stored.map((sample) => Date.parse(sample.observedAt) - Date.parse(h.stored[0]!.observedAt));
    expect(starts).toEqual(Array.from({ length: 11 }, (_, index) => index * POLICY.intervalMs));
  });

  it('stops sampling at the first strict failure instead of waiting out the window', async () => {
    const h = harness({
      readings: (index) => (index === 3 ? { ...RUNNING, instanceId: '4099111017888268059' } : RUNNING),
    });
    const result = await runWorkspaceHostSoak(input(), h.runtime);
    expect(h.stored).toHaveLength(4);
    expect(result.evaluation.verdict).toBe('fail');
    expect(result.evaluation.reasons[0]).toMatch(/^incarnation-stable failed 1x, first sample 3/);
  });

  it('records a controller-side failure to build the probe as a sample, and keeps soaking', async () => {
    const h = harness({ seamsFail: (index) => index === 2 });
    const result = await runWorkspaceHostSoak(input(), h.runtime);
    const broken = h.stored[2]!;
    expect(broken.checks.map((check) => check.ok)).toEqual([null, null, null, false]);
    expect(broken.checks.at(-1)?.detail).toMatch(/controller profile unreadable/);
    // One isolated reach failure of 11 samples is 9% — above the 2% rate, so this short soak fails
    // at the end, but it was NOT cut short: the sampler kept watching.
    expect(h.stored).toHaveLength(11);
    expect(result.evaluation.verdict).toBe('fail');
  });

  it('judges the PERSISTED rows, not the in-memory samples', async () => {
    const h = harness({ persisted: (stored) => stored.filter((sample) => sample.sequence < 4 || sample.sequence > 7) });
    const result = await runWorkspaceHostSoak(input(), h.runtime);
    expect(h.stored).toHaveLength(11);
    expect(result.evaluation.verdict).toBe('fail');
    expect(result.evaluation.reasons.join('\n')).toMatch(/largest gap between samples/);
  });

  it('begins the release receipt once and settles it committed on a pass', async () => {
    const h = harness();
    const result = await runWorkspaceHostSoak(input({ releaseBinding: BINDING }), h.runtime);
    expect(h.runtime.beginReceipt).toHaveBeenCalledTimes(1);
    expect(h.runtime.settleReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ requestIdentity: 'req-1', evaluation: expect.objectContaining({ verdict: 'pass' }) }),
    );
    expect(result.receipt).toBe('committed');
    expect(h.steps.filter((name) => name.startsWith('soak-receipt'))).toEqual(['soak-receipt-begin', 'soak-receipt-settle']);
  });

  it('settles the receipt refused when the soak fails', async () => {
    const h = harness({ readings: (index) => (index === 1 ? { kind: 'absent' } : RUNNING) });
    const result = await runWorkspaceHostSoak(input({ releaseBinding: BINDING }), h.runtime);
    expect(result.receipt).toBe('refused');
    expect(h.runtime.settleReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ evaluation: expect.objectContaining({ verdict: 'fail' }) }),
    );
  });

  it('refuses to start on a host that is not RUNNING, before any sample or receipt', async () => {
    const h = harness();
    h.runtime.resolveSeams = async () => ({
      readInstance: async () => ({ kind: 'observed', status: 'TERMINATED', instanceId: '1', sourceImage: IMAGE }),
      probeFor: () => {
        throw new Error('unreachable');
      },
    });
    await expect(runWorkspaceHostSoak(input({ releaseBinding: BINDING }), h.runtime)).rejects.toThrow(/not RUNNING/);
    expect(h.stored).toHaveLength(0);
    expect(h.runtime.beginReceipt).not.toHaveBeenCalled();
  });
});

describe('workspaceHostSoakWorkflowKeys', () => {
  it('dedups one soak per host, on a key disjoint from the provisioning queue', () => {
    const a = workspaceHostSoakWorkflowKeys({ workspaceId: 'ws', hostId: 'h', soakId: 's1' });
    const b = workspaceHostSoakWorkflowKeys({ workspaceId: 'ws', hostId: 'h', soakId: 's2' });
    expect(a.deduplicationId).toBe(b.deduplicationId);
    expect(a.workflowId).not.toBe(b.workflowId);
    expect(a.deduplicationId).toBe('soak:ws:h');
  });
});
