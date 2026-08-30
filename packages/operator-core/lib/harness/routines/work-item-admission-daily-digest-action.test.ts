import { describe, expect, it, vi } from 'vitest';
import { makeWorkItemAdmissionDailyDigestAction } from './work-item-admission-daily-digest-action';

describe('work-item admission daily digest system action', () => {
  it('runs the guarded digest, invalidates the ledger, and logs corpus stats', async () => {
    const run = vi.fn(async () => ({
      runId: 'daily-live-1',
      status: 'complete' as const,
      sourceBulkStageRunId: 'bulk-1',
      sourceCensusRunId: 'census-1',
      corpusSize: 42,
      coverage: { live: 44, covered: 42, uncovered: 2, ratio: 42 / 44 },
      promptItems: { included: 42, omitted: 0 },
      modelCalled: true,
      tokensIn: 1200,
      tokensOut: 250,
      umbrellaYield: 2,
      linksWritten: 8,
      umbrellas: [],
    }));
    const invalidate = vi.fn(async () => undefined);
    const log = vi.fn();
    const action = makeWorkItemAdmissionDailyDigestAction({ run, invalidate, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('corpus=42'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('umbrellas=2 links=8'));
  });

  it('logs a blocked gate without presenting it as a model run', async () => {
    const run = vi.fn(async () => ({
      runId: 'daily-blocked-1',
      status: 'blocked' as const,
      blockedReason: 'awaiting-completed-bulk-stage' as const,
      sourceBulkStageRunId: null,
      sourceCensusRunId: null,
      corpusSize: 0,
      // blocked before a census resolved, so no coverage or prompt was measurable
      coverage: null,
      promptItems: null,
      modelCalled: false,
      tokensIn: 0,
      tokensOut: 0,
      umbrellaYield: 0,
      linksWritten: 0,
      umbrellas: [],
    }));
    const log = vi.fn();
    const action = makeWorkItemAdmissionDailyDigestAction({ run, invalidate: vi.fn(async () => undefined), log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('blocked=awaiting-completed-bulk-stage'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('modelCalled=false'));
  });
});
