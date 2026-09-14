import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetAssignmentRow } from '../fleet/assignments';

const getFleetM = vi.hoisted(() => vi.fn());
const listFleetAssignmentsM = vi.hoisted(() => vi.fn());

vi.mock('../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFleet: getFleetM,
}));

vi.mock('../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listFleetAssignments: listFleetAssignmentsM,
}));

import { diagnoseFleetScopeLeaderLiveness } from './fleet-scope-admission';

const scope = {
  workspaceId: 'papercusp-workspace',
  fleetSlug: 'ios-fleet',
  ownerId: 'su-member',
  record: { spec: {} },
};

function presence(overrides: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow {
  return {
    source: 'presence',
    workspaceId: 'papercusp-workspace',
    agentId: 'su-leader',
    agentLabel: 'leader',
    agentName: null,
    harnessSlug: null,
    planSlug: null,
    itemId: null,
    workItemId: null,
    itemKind: null,
    detail: 'monitoring several fleets',
    status: null,
    claimAcquiredTs: null,
    claimExpiresTs: null,
    claimActive: null,
    livenessMode: null,
    lastActivityTs: null,
    holderPresent: true,
    holderAlive: true,
    holderHeartbeatAt: '2026-08-14T13:00:00.000Z',
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    stalled: null,
    lastProgressAt: null,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    // The same owner leads ios-fleet in the registry, but its ONE soft presence
    // label currently describes another fleet where it is only a member.
    fleetSlug: 'gpt-fleet',
    fleetRole: 'member',
    ...overrides,
  };
}

describe('diagnoseFleetScopeLeaderLiveness — registered multi-fleet leaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFleetM.mockResolvedValue({ leaderOwnerId: 'su-leader' });
    listFleetAssignmentsM.mockResolvedValue([presence()]);
  });

  it("uses the registry leader's liveness even when its soft presence label names another fleet", async () => {
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(true);

    expect(getFleetM).toHaveBeenCalledWith('papercusp-workspace', 'ios-fleet');
    expect(listFleetAssignmentsM).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      agent: 'su-leader',
    });
  });

  it('uses a supplied fleet_assignment snapshot without issuing another roster query', async () => {
    const snapshot = [presence()];

    await expect(
      diagnoseFleetScopeLeaderLiveness({ scope: scope as never, fleetAssignmentRows: snapshot }),
    ).resolves.toBe(true);

    expect(getFleetM).toHaveBeenCalledWith('papercusp-workspace', 'ios-fleet');
    expect(listFleetAssignmentsM).not.toHaveBeenCalled();
  });

  it('returns false when the registered leader is not live', async () => {
    listFleetAssignmentsM.mockResolvedValue([presence({ holderAlive: false })]);

    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(false);
  });

  it('returns false when the fleet has no registered leader', async () => {
    getFleetM.mockResolvedValue({ leaderOwnerId: null });

    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(false);
    expect(listFleetAssignmentsM).not.toHaveBeenCalled();
  });

  it('preserves unknown when the registry or roster read fails', async () => {
    getFleetM.mockRejectedValueOnce(new Error('registry unavailable'));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBeNull();

    getFleetM.mockResolvedValueOnce({ leaderOwnerId: 'su-leader' });
    listFleetAssignmentsM.mockRejectedValueOnce(new Error('roster unavailable'));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBeNull();
  });
});
