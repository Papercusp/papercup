import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FilterNode } from '../scheduler/claim-spec';

const mocks = vi.hoisted(() => ({
  resolveFleetClaimSpec: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(() => 'ws-x'),
  aggregateIssueClaimExclusions: vi.fn(),
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(),
}));

vi.mock('../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: mocks.resolveFleetClaimSpec,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../scheduler/get-next', () => ({
  aggregateIssueClaimExclusions: mocks.aggregateIssueClaimExclusions,
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  diagnoseFleetScopeFeatureFamilyExclusions: mocks.diagnoseFleetScopeFeatureFamilyExclusions,
}));

import { readFleetLaneHealth } from './lane-health';

const planFilter: FilterNode = { field: 'plan', op: '=', value: 'p' };

type LaneHealthTestSpec = {
  specId: string;
  revision: number;
  states: string[];
  view: { filter: FilterNode };
};

const spec: LaneHealthTestSpec = {
  specId: 'feature-plan',
  revision: 7,
  states: ['open'],
  view: { filter: planFilter },
};

const resolved = (nextSpec: LaneHealthTestSpec = spec) => ({
  fleetSlug: 'fleet-x',
  matchedBy: 'fleet-slug',
  record: {
    source: 'fleet',
    spec: nextSpec,
    revision: 7,
    updatedBy: null,
    updatedAt: null,
    harnessSlug: 'papercusp',
    fleetSlug: 'fleet-x',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveFleetClaimSpec.mockResolvedValue(resolved());
  mocks.aggregateIssueClaimExclusions.mockResolvedValue({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
  });
  mocks.diagnoseFleetScopeFeatureFamilyExclusions.mockResolvedValue({
    claimable: 4,
    matchedByFilter: 6,
    excluded: { claimFloors: 2, reservedPlanLane: 2 },
  });
});

const read = () =>
  readFleetLaneHealth({
    fleet: 'fleet-x',
    harness: 'papercusp',
    workspaceId: 'ws-x',
    assignee: 'su-member',
  });

const readPopulation = () =>
  readFleetLaneHealth({
    fleet: 'fleet-x',
    harness: 'papercusp',
    workspaceId: 'ws-x',
  });

describe('readFleetLaneHealth — feature-family-aware effective verdict (EI-211885)', () => {
  it('uses only the feature oracle for an explicitly feature-only exact-plan lane', async () => {
    mocks.resolveFleetClaimSpec.mockResolvedValueOnce(
      resolved({
        ...spec,
        view: { filter: { all: [planFilter, { field: 'kind', op: 'in', value: ['feature', 'chunk'] }] } },
      }),
    );
    const health = await read();

    expect(health).toMatchObject({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      issueFamily: { claimable: 0, matchedByFilter: 0, excluded: {} },
      featureFamily: {
        claimable: 4,
        matchedByFilter: 6,
        excluded: { claimFloors: 2, reservedPlanLane: 2 },
      },
      effective: {
        claimable: 4,
        matchedByFilter: 6,
        excluded: { claimFloors: 2, reservedPlanLane: 2 },
        basis: 'feature-family',
      },
      familyReachability: { issue: false, feature: true },
    });
    expect(mocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledWith(
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
    mocks.diagnoseFleetScopeFeatureFamilyExclusions.mockResolvedValue(null);

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
    mocks.resolveFleetClaimSpec.mockResolvedValueOnce(
      resolved({
        ...spec,
        view: { filter: { all: [planFilter, { field: 'kind', op: 'in', value: ['bug', 'task'] }] } },
      }),
    );

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).not.toHaveBeenCalled();
    expect(health?.featureFamily).toBeNull();
    expect(health?.effective).toEqual({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      basis: 'issue-family',
    });
    expect(health?.familyReachability).toEqual({ issue: true, feature: false });
  });

  it('still probes features when the reachable issue family already matches rows', async () => {
    mocks.aggregateIssueClaimExclusions.mockResolvedValue({
      claimable: 2,
      matchedByFilter: 5,
      excluded: { taken: 3, claimFloors: 1 },
    });

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledTimes(1);
    expect(health?.effective).toEqual({
      claimable: 6,
      matchedByFilter: 11,
      excluded: { taken: 3, claimFloors: 3, reservedPlanLane: 2 },
      basis: 'issue+feature-family',
    });
  });

  it('omits caller-relative floors for a fleet population read', async () => {
    mocks.aggregateIssueClaimExclusions.mockResolvedValue({
      claimable: 2,
      matchedByFilter: 2,
      excluded: {},
    });

    const health = await readPopulation();

    expect(mocks.aggregateIssueClaimExclusions).toHaveBeenCalledWith(
      planFilter,
      expect.objectContaining({ assignee: undefined }),
    );
    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledWith(
      expect.objectContaining({
        cooldownAssignee: null,
        scope: expect.objectContaining({ ownerId: '' }),
      }),
    );
    expect(health?.effective.claimable).toBe(6);
    expect(health?.spec.assigneeScoped).toBeNull();
  });
});
