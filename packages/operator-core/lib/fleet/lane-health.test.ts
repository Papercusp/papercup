import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveFleetClaimSpec: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(() => 'ws-x'),
  aggregateIssueClaimExclusions: vi.fn(),
  specIsIssueFamilyOnly: vi.fn(),
  diagnoseFleetScopeFeatureFamilyMatch: vi.fn(),
}));

vi.mock('../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: mocks.resolveFleetClaimSpec,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../scheduler/get-next', () => ({
  aggregateIssueClaimExclusions: mocks.aggregateIssueClaimExclusions,
}));
vi.mock('../agent-tools/scheduler/get_next', () => ({
  specIsIssueFamilyOnly: mocks.specIsIssueFamilyOnly,
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  diagnoseFleetScopeFeatureFamilyMatch: mocks.diagnoseFleetScopeFeatureFamilyMatch,
}));

import { readFleetLaneHealth } from './lane-health';

const spec = {
  specId: 'feature-plan',
  revision: 7,
  states: ['open'],
  view: { filter: { field: 'plan', op: 'eq', value: 'p' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveFleetClaimSpec.mockResolvedValue({
    fleetSlug: 'fleet-x',
    matchedBy: 'fleet-slug',
    record: {
      source: 'fleet',
      spec,
      revision: 7,
      updatedBy: null,
      updatedAt: null,
      harnessSlug: 'papercusp',
      fleetSlug: 'fleet-x',
    },
  });
  mocks.aggregateIssueClaimExclusions.mockResolvedValue({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
  });
  mocks.specIsIssueFamilyOnly.mockReturnValue(false);
  mocks.diagnoseFleetScopeFeatureFamilyMatch.mockResolvedValue(4);
});

const read = () =>
  readFleetLaneHealth({
    fleet: 'fleet-x',
    harness: 'papercusp',
    workspaceId: 'ws-x',
    assignee: 'su-member',
  });

describe('readFleetLaneHealth — feature-family-aware effective verdict (EI-211885)', () => {
  it('preserves issue-family aliases while a feature-only exact-plan lane stays nonempty', async () => {
    const health = await read();

    expect(health).toMatchObject({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      issueFamily: { claimable: 0, matchedByFilter: 0, excluded: {} },
      featureFamily: { claimable: 4, matchedByFilter: null, excluded: null },
      effective: {
        claimable: 4,
        matchedByFilter: null,
        excluded: null,
        basis: 'issue+feature-family',
      },
    });
    expect(mocks.diagnoseFleetScopeFeatureFamilyMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'papercusp',
        workspaceId: 'ws-x',
        scope: expect.objectContaining({
          ownerId: 'su-member',
          fleetSlug: 'fleet-x',
          fleetRole: 'member',
        }),
      }),
    );
  });

  it('fails closed to UNKNOWN when the required feature-family read fails', async () => {
    mocks.diagnoseFleetScopeFeatureFamilyMatch.mockResolvedValue(null);

    const health = await read();

    expect(health?.featureFamily?.claimable).toBeNull();
    expect(health?.effective).toEqual({
      claimable: null,
      matchedByFilter: null,
      excluded: null,
      basis: 'issue+feature-family',
    });
  });

  it('does not probe features for an explicitly issue-family-only spec', async () => {
    mocks.specIsIssueFamilyOnly.mockReturnValue(true);

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyMatch).not.toHaveBeenCalled();
    expect(health?.featureFamily).toBeNull();
    expect(health?.effective).toEqual({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      basis: 'issue-family',
    });
  });

  it('keeps the issue verdict when that family already matches rows', async () => {
    mocks.aggregateIssueClaimExclusions.mockResolvedValue({
      claimable: 2,
      matchedByFilter: 5,
      excluded: { taken: 3 },
    });

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyMatch).not.toHaveBeenCalled();
    expect(health?.effective).toEqual({
      claimable: 2,
      matchedByFilter: 5,
      excluded: { taken: 3 },
      basis: 'issue-family',
    });
  });
});
