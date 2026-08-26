import { describe, expect, it, vi } from 'vitest';
import { makeWorkItemAdmissionDeltaSweepAction } from './work-item-admission-delta-sweep-action';

describe('work-item admission delta-sweep system action', () => {
  it('runs one durable tick, invalidates the ledger, and logs the umbrella yield', async () => {
    const run = vi.fn(async () => ({
      runId: 'delta-live-1',
      recentItems: 5,
      titleItems: 17,
      clusterShards: 2,
      sourceCensusRunId: 'census-live',
      modelCalled: true,
      tokensIn: 400,
      tokensOut: 80,
      umbrellaYield: 1,
      linksWritten: 5,
      umbrellas: [
        {
          id: 'EI-umbrella',
          created: true,
          title: 'Shared lock leak',
          memberIds: ['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5'],
          linksWritten: 5,
        },
      ],
    }));
    const invalidate = vi.fn(async () => undefined);
    const log = vi.fn();
    const action = makeWorkItemAdmissionDeltaSweepAction({ run, invalidate, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('umbrellas=1 links=5'));
  });
});
