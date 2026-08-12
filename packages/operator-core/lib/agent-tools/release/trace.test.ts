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
