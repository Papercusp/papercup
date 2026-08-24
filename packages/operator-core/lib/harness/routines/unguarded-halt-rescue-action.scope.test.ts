import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClaimSpecRecord: vi.fn(),
  readIssueClaimability: vi.fn(),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: mocks.getClaimSpecRecord,
}));
vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: mocks.readIssueClaimability,
}));

import { claimableForCandidate } from './unguarded-halt-rescue-action';

describe('unguarded-halt rescue claimability scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      fleetSlug: 'drain-fleet',
      harnessSlug: 'papercusp',
      spec: {
        view: { filter: { field: 'kind', op: '=', value: 'bug' } },
        states: ['open'],
      },
    });
    mocks.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 4 },
    });
  });

  it('resolves the candidate effective spec and threads caller-relative scope', async () => {
    await expect(
      claimableForCandidate(
        { agentId: 'member-7', fleetSlug: 'drain-fleet' },
        'resolved-workspace',
      ),
    ).resolves.toBe(4);

    expect(mocks.getClaimSpecRecord).toHaveBeenCalledWith({
      cupId: 'member-7',
      workspaceId: 'resolved-workspace',
    });
    expect(mocks.readIssueClaimability).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({
        harness: 'papercusp',
        states: ['open'],
        workspaceId: 'resolved-workspace',
        assignee: 'member-7',
        claimantFleetSlug: 'drain-fleet',
        claimSpecReferencesFleet: false,
      }),
      { limit: 1, breakdownOnly: true },
    );
  });

  it('uses each member override instead of reusing the fleet sentinel spec', async () => {
    const memberSpec = {
      view: { filter: { field: 'title', op: 'word', value: 'database' } },
      states: ['open'],
    };
    mocks.getClaimSpecRecord.mockResolvedValue({
      source: 'cup',
      harnessSlug: 'papercusp',
      spec: memberSpec,
    });
    mocks.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 1 },
    });

    await expect(
      claimableForCandidate(
        { agentId: 'narrow-member', fleetSlug: 'drain-fleet' },
        'resolved-workspace',
      ),
    ).resolves.toBe(1);

    expect(mocks.getClaimSpecRecord).toHaveBeenCalledWith({
      cupId: 'narrow-member',
      workspaceId: 'resolved-workspace',
    });
    expect(mocks.readIssueClaimability).toHaveBeenCalledWith(
      memberSpec.view.filter,
      expect.objectContaining({
        harness: 'papercusp',
        states: ['open'],
        spec: memberSpec,
        workspaceId: 'resolved-workspace',
        assignee: 'narrow-member',
        // A per-bee override does not inherit fleet authorization unless the
        // override explicitly references the fleet field.
        claimSpecReferencesFleet: false,
      }),
      { limit: 1, breakdownOnly: true },
    );
    expect(mocks.readIssueClaimability.mock.calls[0]?.[1]).not.toHaveProperty('claimantFleetSlug');
  });

  it('fails closed while a member is between fleet membership and sentinel resolution', async () => {
    mocks.getClaimSpecRecord.mockResolvedValue({
      source: 'default',
      fleetSlug: 'drain-fleet',
      harnessSlug: 'papercusp',
      spec: {
        view: { filter: { field: 'kind', op: '=', value: 'bug' } },
        states: ['open'],
      },
    });

    await expect(
      claimableForCandidate(
        { agentId: 'transitioning-member', fleetSlug: 'drain-fleet' },
        'resolved-workspace',
      ),
    ).resolves.toBe(0);
    expect(mocks.readIssueClaimability).not.toHaveBeenCalled();
  });
});
