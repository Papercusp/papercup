import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items-admission-bulk-dedup', () => ({ runWorkItemAdmissionBulkDedup: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'active-ws' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));

import { runWorkItemAdmissionBulkDedup } from '../../work-items-admission-bulk-dedup';
import { notifySyncInvalidate } from '../../sync-sse';

const run = vi.mocked(runWorkItemAdmissionBulkDedup);
const invalidate = vi.mocked(notifySyncInvalidate);
const tool = (await import('./bulk_dedup')).default;

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({
    runId: 'bulk-1',
    scope: 'machine-emitter-targeted',
    converged: true,
    convergenceReason: 'scope-zero',
    initialCensus: 2,
    finalCensus: 1,
    finalScopedPairs: 0,
    stages: [],
  });
});

describe('work_items:bulk_dedup handler', () => {
  it('uses call-context workspace, threads bounded census controls, and invalidates the shared run query', async () => {
    const out = (await tool.handler(
      {
        harness: 'papercusp',
        confirm: true,
        runId: 'bulk-1',
        maxStages: 4,
        pairsPerCall: 25,
        targetTokens: 250_000,
        ceilingTokens: 900_000,
        chunkCount: 8,
        fullCorpusPairThreshold: 125,
      },
      { workspaceId: 'ctx-ws' } as never,
    )) as { data: Record<string, unknown> };

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ctx-ws',
        harnessSlug: 'papercusp',
        runId: 'bulk-1',
        maxStages: 4,
        pairsPerCall: 25,
        census: {
          targetTokens: 250_000,
          ceilingTokens: 900_000,
          chunkCount: 8,
          fullCorpusPairThreshold: 125,
        },
        llmCall: expect.any(Function),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('workItemAdmission.runs');
    expect(out.data).toMatchObject({ ok: true, runId: 'bulk-1', converged: true });
  });

  it('uses the explicit workspace override instead of context', async () => {
    await tool.handler({ harness: 'papercusp', workspace: 'override-ws', confirm: true }, {
      workspaceId: 'ctx-ws',
    } as never);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'override-ws' }));
  });
});
