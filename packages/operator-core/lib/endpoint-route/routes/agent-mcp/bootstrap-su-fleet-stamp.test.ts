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
vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  reactivateAdvSession: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
}));

// EI-18278623507151337: `resolveFleet`'s join branch reads the fleet record for the
// durable leader. Mock the whole store seam (resolveFleet destructures five exports
// through ONE dynamic import — see the WI-1408 note in bootstrap-su.ts — so all five
// must exist here or that single import edge throws into its fail-soft catch).
const getFleetMock = vi.fn(async (_ws: string, _slug: string) => null as unknown);
vi.mock('../../../agent-fleets-store', () => ({
  getFleet: (ws: string, slug: string) => getFleetMock(ws, slug),
  getFleetScheme: vi.fn(async () => null),
  fleetSlugFromName: (n: string) => n,
  createFleetIfAbsent: vi.fn(async () => ({ record: {}, created: false })),
  resolveFleetScheme: vi.fn(() => ({ bg: '#000000', fg: '#ffffff', cursor: '#ffffff' })),
}));

import { resolveFleet, resolveFleetJoinRole, stampFleetMembershipAtBoot } from './bootstrap-su';

beforeEach(() => {
  appendIfAbsentMock.mockClear();
  appendIfAbsentMock.mockResolvedValue(undefined);
  getFleetMock.mockReset();
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

/**
 * EI-18278623507151337 — the COMPOSER-SIDE ROLE CHECK.
 *
 * The filed incident: an established fleet LEADER received a fleet-MEMBER kickoff
 * brief (naming a stale leader and an already-done plan item). The role a member is
 * briefed with is stamped right here, from the boot arg alone — and `--fleet=<slug>`
 * hard-sets `member` unconditionally (psu-launcher.mjs:416/:578; there is no
 * `--fleet-role=` flag), while `psuLaunchArgvRecord` re-emits only `--fleet=<slug>`,
 * so a launch rebuilt from a recorded argv cannot carry leadership at all. The durable
 * authority (`agent_fleets.leader_owner_id`) was fetched two lines earlier and never
 * consulted. These pin that it now is.
 *
 * The pure helper carries the rule; the `resolveFleet` cases prove the guard reaches
 * the env the launch actually composes from (PAPERCUSP_FLEET_ROLE), not merely the
 * helper's return value.
 */
describe('resolveFleetJoinRole (EI-18278623507151337 composer-side role check)', () => {
  it("refuses to demote the fleet's recorded leader to member", () => {
    expect(
      resolveFleetJoinRole({ requestedRole: 'member', ownerId: 'su-bce40c51', leaderOwnerId: 'su-bce40c51' }),
    ).toEqual({ role: 'leader', demotionRefused: true });
  });

  it('an ABSENT role is the same demotion — that is the shape `--fleet=<slug>` produces', () => {
    expect(resolveFleetJoinRole({ ownerId: 'su-bce40c51', leaderOwnerId: 'su-bce40c51' })).toEqual({
      role: 'leader',
      demotionRefused: true,
    });
  });

  it('an ordinary member of a fleet someone else leads stays a member', () => {
    expect(
      resolveFleetJoinRole({ requestedRole: 'member', ownerId: 'su-worker', leaderOwnerId: 'su-bce40c51' }),
    ).toEqual({ role: 'member', demotionRefused: false });
  });

  it('a leaderless fleet, or an unidentified launch, cannot trigger the correction', () => {
    expect(resolveFleetJoinRole({ ownerId: 'su-worker', leaderOwnerId: null })).toEqual({
      role: 'member',
      demotionRefused: false,
    });
    expect(resolveFleetJoinRole({ ownerId: null, leaderOwnerId: 'su-bce40c51' })).toEqual({
      role: 'member',
      demotionRefused: false,
    });
    // Blank/whitespace identities must never compare equal to each other.
    expect(resolveFleetJoinRole({ ownerId: '   ', leaderOwnerId: '   ' })).toEqual({
      role: 'member',
      demotionRefused: false,
    });
  });

  it('always honors an explicit leader request (a leadership handover is not refused here)', () => {
    expect(resolveFleetJoinRole({ requestedRole: 'leader', ownerId: 'su-new', leaderOwnerId: 'su-old' })).toEqual({
      role: 'leader',
      demotionRefused: false,
    });
  });
});

describe('resolveFleet join branch stamps the corrected role into the launch env', () => {
  it('the recorded leader gets PAPERCUSP_FLEET_ROLE=leader even though the launch asked for member', async () => {
    getFleetMock.mockResolvedValueOnce({ fleetSlug: 'p2p-release-verify', leaderOwnerId: 'su-bce40c51' });
    const res = await resolveFleet('papercusp-workspace', {
      fleet: 'p2p-release-verify',
      fleetRole: 'member',
      ownerId: 'su-bce40c51',
    });
    expect(res.fleetRole).toBe('leader');
    expect(res.env.PAPERCUSP_FLEET_ROLE).toBe('leader');
    // The correction is REPORTED — the launcher prints this notice. A silent
    // disagreement with the caller is what let the original incident pass unseen.
    expect(res.notice).toContain('leader_owner_id');
  });

  it('a real member is untouched (unchanged from the pre-guard behavior)', async () => {
    getFleetMock.mockResolvedValueOnce({ fleetSlug: 'p2p-release-verify', leaderOwnerId: 'su-bce40c51' });
    const res = await resolveFleet('papercusp-workspace', {
      fleet: 'p2p-release-verify',
      ownerId: 'su-worker-2',
    });
    expect(res.fleetRole).toBe('member');
    expect(res.env.PAPERCUSP_FLEET_ROLE).toBe('member');
    expect(res.notice).toBe('joined fleet p2p-release-verify as member.');
  });
});
