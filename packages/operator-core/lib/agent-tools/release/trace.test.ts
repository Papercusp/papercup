import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  gitPipelineSnapshot: vi.fn(),
  gitPipelinePosition: vi.fn(),
  computeDeployStatus: vi.fn(),
  buildReleaseTrace: vi.fn(),
  inspectEventKey: vi.fn(),
  resolveAgentIdentity: vi.fn(),
}));

vi.mock('../../git-pipeline-stats', () => ({ gitPipelineSnapshot: mocks.gitPipelineSnapshot }));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition: mocks.gitPipelinePosition }));
vi.mock('../../release-deploy-launch', () => ({ computeDeployStatus: mocks.computeDeployStatus }));
vi.mock('../../release-trace', () => ({ buildReleaseTrace: mocks.buildReleaseTrace }));
vi.mock('../../events/await/store', () => ({ inspectEventKey: mocks.inspectEventKey }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.resolveAgentIdentity }));

import tool, {
  RELEASE_TRACE_AWAIT_TIMEOUT_MS,
  RELEASE_TRACE_POSITION_TIMEOUT_MS,
  RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
} from './trace';
import '../cell-registrations-wiring';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('release:trace tool contract', () => {
  it('is the read-only release composition surface for every execution/release role', () => {
    expect(tool.name).toBe('release:trace');
    expect(tool.capability).toBe('intel:read');
    const roles = new Set(tool.agentRoles ?? []);
    for (const role of ['operator', 'worker', 'validator', 'reviewer', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles.has(role), role).toBe(true);
    }
  });

  it('does not hold an ambient workspace transaction during reconciliation (EI-20246294559310854)', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('requires path or sha in the published schema even when work_item is supplied (EI-20232784385629302)', () => {
    const missingTarget = tool.args.safeParse({ work_item: 'WI-38026' });
    expect(missingTarget.success).toBe(false);
    if (!missingTarget.success) {
      expect(missingTarget.error.issues[0]).toMatchObject({ code: 'invalid_union' });
    }

    expect(tool.args.safeParse({ path: 'packages/operator-core/lib/agent-tools/release/trace.ts' }).success).toBe(true);
    expect(tool.args.safeParse({ sha: 'abcd', work_item: 'WI-38026' }).success).toBe(true);

    const published = z.toJSONSchema(tool.args as never) as {
      anyOf?: Array<{ required?: string[] }>;
    };
    expect(published.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['path']) }),
        expect.objectContaining({ required: expect.arrayContaining(['sha']) }),
      ]),
    );
  });

  it('uses the sidecar-free snapshot path for diagnostic reads (EI-20264406467393669)', async () => {
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    await tool.handler({ path: 'packages/operator-core/lib/agent-tools/release/trace.ts' } as never, {} as never);

    expect(mocks.gitPipelineSnapshot).toHaveBeenCalledWith(undefined, { useSpawnerSidecar: false });
  });

  it('stamps the exact target SHA with a candidate-cell re-read handle', async () => {
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234', input: { path: 'apps/x.ts', sha: null } });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true, target: { sha: 'abcd1234' } });

    const out = (await tool.handler(
      { path: 'apps/x.ts' } as never,
      { role: 'cup', harnessSlug: 'papercusp' } as never,
    )) as { data: { plane?: { cells: Array<Record<string, unknown>> } } };

    expect(out.data.plane?.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'target.sha',
          cell: 'gate.greenCheckpoint.candidate',
          reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.candidate', as: 'apps/x.ts' } },
        }),
      ]),
    );
  });

  it('preserves the active checkpoint candidate separately from the terminal observed candidate', async () => {
    const activeRun = {
      active: true,
      candidate: 'active-candidate',
      activeSource: 'run-lock' as const,
      startedAtMs: 123,
      elapsedSec: 42,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        observedCandidate: 'terminal-candidate',
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({
      targetSha: 'abcd1234',
      gate: {
        observedCandidate: 'terminal-candidate',
        checkpointRunInFlight: activeRun,
      },
    });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    await tool.handler({ sha: 'abcd1234' } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          observedCandidate: 'terminal-candidate',
          checkpointRunInFlight: activeRun,
        }),
      }),
    );
  });

  it('preserves the cancelled no-verdict authority for the pure release:trace guard', async () => {
    const cancelled = {
      status: 'cancelled',
      candidate: 'abcd1234',
      detail: 'externally SIGTERMed before a result marker was published',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        inconclusive: cancelled,
      },
    };
    const cancelledRun = {
      active: false,
      activeSource: 'run-lock' as const,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({
      targetSha: 'abcd1234',
      gate: { checkpointRunInFlight: cancelledRun },
    });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    await tool.handler({ sha: 'abcd1234' } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({ inconclusive: cancelled }),
      }),
    );
  });

  it('suppresses prior failing tests when the requested candidate is infra-inconclusive', async () => {
    const targetSha = 'a'.repeat(40);
    const inconclusive = {
      status: 'infra-inconclusive',
      candidate: targetSha.slice(0, 8),
      detail: 'green-checkpoint rendered no code verdict',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 5,
        failingTests: ['historical-red.test.ts'],
        fireStale: false,
        observedCandidate: 'older-candidate',
        inconclusive,
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'gate-red' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: false });

    await tool.handler({ sha: targetSha } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          authoritative: false,
          consecutiveReds: 5,
          failingTests: [],
          inconclusive,
        }),
      }),
    );
  });

  it('labels prior failing tests as inherited repair-queue context for an exact repair hold', async () => {
    const targetSha = 'b'.repeat(40);
    const inconclusive = {
      status: 'repair-in-progress',
      candidate: targetSha.slice(0, 8),
      detail: 'frozen repair fixer dispatched; no suite run',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 5,
        failingTests: ['historical-red.test.ts'],
        fireStale: false,
        observedCandidate: 'older-candidate',
        recordedVerdict: 'not-green',
        inconclusive,
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'gate-red' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: false });

    await tool.handler({ sha: targetSha } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          failingTests: [],
          inheritedRepairQueueFailingTests: ['historical-red.test.ts'],
          inheritedRepairQueueFailingTestsSource: 'prior-gate-verdict',
          recordedVerdict: 'not-green',
          inconclusive,
        }),
      }),
    );
  });

  it('returns an unknown, retryable result when the pipeline snapshot exceeds its budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    mocks.gitPipelineSnapshot.mockImplementation(() => new Promise(() => {}));

    const pending = tool.handler({ sha: 'abcd1234' } as never, {} as never);
    await vi.advanceTimersByTimeAsync(RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      data: {
        ok: false,
        trace: { status: 'unknown', complete: false },
        nextVerb: null,
        error: {
          code: 'trace_timeout',
          stage: 'pipeline_snapshot',
          retryable: true,
          timeoutMs: RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
        },
      },
    });
    expect(mocks.gitPipelinePosition).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS}ms`));
  });

  it('returns unknown instead of an all-clear when await-history reconciliation stalls', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockImplementation(() => new Promise(() => {}));
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });

    const pending = tool.handler({ sha: 'abcd1234' } as never, {} as never);
    await vi.advanceTimersByTimeAsync(RELEASE_TRACE_POSITION_TIMEOUT_MS + RELEASE_TRACE_AWAIT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      data: {
        ok: false,
        trace: { status: 'unknown', complete: false },
        nextVerb: null,
        error: {
          code: 'trace_timeout',
          stage: 'await_history',
          retryable: true,
          timeoutMs: RELEASE_TRACE_AWAIT_TIMEOUT_MS,
        },
      },
    });
    expect(mocks.inspectEventKey).toHaveBeenCalledTimes(4);
    expect(mocks.buildReleaseTrace).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${RELEASE_TRACE_AWAIT_TIMEOUT_MS}ms`));
  });

  it('does not convert a real pipeline read error into a timeout or an all-clear', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('pipeline snapshot unavailable');
    mocks.gitPipelineSnapshot.mockRejectedValueOnce(failure);

    await expect(tool.handler({ sha: 'abcd1234' } as never, {} as never)).rejects.toThrow(failure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pipeline snapshot unavailable'));
  });
});
