/**
 * WI-1893 (cluster-safe fleet stamp): unit tests for `stampFleetMembershipAtBoot`.
 *
 * A psu `--fleet=<slug>` launch used to register an IN-MEMORY pending placement
 * (setPendingFleet, WI-1343) in whichever :3070 cluster worker served bootstrap;
 * the member's first presence write usually landed on a DIFFERENT worker, the
 * placement was lost, and the member registered presence with fleet_slug=null —
 * invisible to fleet:assignments/@fleet: (the 2026-07-03 backlog-clearance batch
 * lost all 10 members this way). The fix appends the DURABLE membership fact
 * (fleet_membership_events, WI-1345) at boot instead — worker-agnostic; the
 * mig-430 materialize trigger applies it when the presence row later appears.
 *
 * These tests pin the helper's wiring at the store seam (mocked — no PG):
 * populate-once via appendFleetMembershipIfAbsent, member-role default, and the
 * null-on-success / message-on-failure contract the routes' loud 409 keys off.
 * DB-touching sibling modules are mocked so importing the route stays pure
 * (mirrors bootstrap-su-launch-argv.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const appendIfAbsentMock = vi.fn(async (_input: unknown) => {});
vi.mock('../../../fleet-membership-store', () => ({
  appendFleetMembershipIfAbsent: (input: unknown) => appendIfAbsentMock(input),
  appendFleetMembershipEvent: vi.fn(async () => {}),
}));
vi.mock('../../../adv-sessions', () => ({
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  reactivateAdvSession: vi.fn(async () => false),
}));

import { stampFleetMembershipAtBoot } from './bootstrap-su';

beforeEach(() => {
  appendIfAbsentMock.mockClear();
  appendIfAbsentMock.mockResolvedValue(undefined);
});

describe('stampFleetMembershipAtBoot (WI-1893)', () => {
  it('appends a populate-once membership fact with the resolved fleet + role', async () => {
    const err = await stampFleetMembershipAtBoot({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      ownerLabel: 'member 3',
      fleetSlug: 'backlog-clearance',
      fleetRole: 'leader',
    });
    expect(err).toBeNull();
    expect(appendIfAbsentMock).toHaveBeenCalledTimes(1);
    expect(appendIfAbsentMock).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      ownerLabel: 'member 3',
      fleetSlug: 'backlog-clearance',
      fleetRole: 'leader',
    });
  });

  it("defaults the role to 'member' and the label to null", async () => {
    const err = await stampFleetMembershipAtBoot({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      fleetSlug: 'ops-team',
    });
    expect(err).toBeNull();
    expect(appendIfAbsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ fleetRole: 'member', ownerLabel: null }),
    );
  });

  it('returns the error message on a store failure (the routes 409 on it — no silent ghost member)', async () => {
    appendIfAbsentMock.mockRejectedValueOnce(new Error('pg down'));
    const err = await stampFleetMembershipAtBoot({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      fleetSlug: 'ops-team',
    });
    expect(err).toBe('pg down');
    // The contract: a non-null return is the LOUD path — callers refuse the launch.
  });
});
