import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveFleetClaimSpec: vi.fn(),
  readIssueClaimability: vi.fn(),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: mocks.resolveFleetClaimSpec,
}));
vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: mocks.readIssueClaimability,
}));

import { claimableForFleet } from './unguarded-halt-rescue-action';

describe('unguarded-halt rescue claimability scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveFleetClaimSpec.mockResolvedValue({
      record: {
        harnessSlug: 'papercusp',
        spec: {
          view: { filter: { field: 'kind', op: '=', value: 'bug' } },
          states: ['open'],
        },
      },
    });
    mocks.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 4 },
    });
  });

  it('threads the resolved workspace into the claimability oracle', async () => {
    await expect(claimableForFleet('drain-fleet', 'resolved-workspace')).resolves.toBe(4);

    expect(mocks.resolveFleetClaimSpec).toHaveBeenCalledWith({
      spec: 'drain-fleet',
      workspaceId: 'resolved-workspace',
    });
    expect(mocks.readIssueClaimability).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({
        harness: 'papercusp',
        states: ['open'],
        workspaceId: 'resolved-workspace',
      }),
      { limit: 1, breakdownOnly: true },
    );
  });
});
