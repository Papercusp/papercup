/**
 * presence-pending-fleet-persist.test.ts — WI-1408 (fleet-registration-persists):
 * this is the mechanism that turns a member launched with `--fleet <slug>` into a
 * REAL, persisted fleet membership instead of the reported bug ("lands with
 * fleetSlug null, so the fleet roster is wrong").
 *
 * bootstrap-su/-role's `resolveFleet` resolves the requested slug and registers a
 * PENDING placement via `setPendingFleet(sid, fleetSlug, fleetRole)` (env vars set
 * on the LAUNCHED agent's own process are invisible to the OPERATOR process that
 * runs `writePresence` — see `deriveFleetMembership`'s env-fold, which alone can
 * never see a launched member's fleet). `writePresence` then applies that pending
 * placement on the member's FIRST presence write via `setPresenceFleet`, which
 * appends a durable membership fact (WI-1345's append-only
 * `fleet_membership_events`) — the fact the `harness_shared.fleet_assignment` view
 * (and `groupByAgent`, packages/operator-core/lib/fleet/assignments.ts) reads to
 * group the agent under its fleet.
 *
 * This test pins that bridge WITHOUT a real Postgres: the presence store write +
 * the membership-fact append are both mocked at their IO seam, so what's under
 * test is genuinely `writePresence`'s wiring — that a pending placement (i.e. a
 * `--fleet`-launched member's very first registration) results in a non-null
 * fleetSlug/fleetRole fact, exactly once, and that a plain (non-fleet) launch
 * appends nothing at all (byte-identical to today).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIdentity } from './identity';

const storeWriteMock = vi.fn(async () => {});
vi.mock('@papercusp/coordination/presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/coordination/presence')>();
  return {
    ...actual,
    PgPresenceStore: vi.fn().mockImplementation(() => ({
      write: storeWriteMock,
      touchHeartbeat: vi.fn(async () => {}),
      touchActivity: vi.fn(async () => {}),
      setCompactionLimit: vi.fn(async () => {}),
      setContextEstimate: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      sweepStale: vi.fn(async () => 0),
    })),
  };
});

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));

// No env-pinned fleet on the OPERATOR process in these tests — isolates the
// pending-placement bridge from the (separately-tested) env-fold path.
vi.mock('./identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./identity')>();
  return {
    ...actual,
    deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
  };
});

const appendFleetMembershipEventMock = vi.fn(async () => {});
const appendFleetMembershipIfAbsentMock = vi.fn(async () => {});
vi.mock('../../fleet-membership-store', () => ({
  appendFleetMembershipEvent: (...a: unknown[]) => appendFleetMembershipEventMock(...a),
  appendFleetMembershipIfAbsent: (...a: unknown[]) => appendFleetMembershipIfAbsentMock(...a),
}));

vi.mock('../../session-brief', () => ({ writeSessionBrief: vi.fn(async () => {}) }));

// writePresence's honesty-reactivation is a best-effort dynamic import wrapped in
// try/catch — mock it so it resolves cleanly instead of hitting real PG and
// swallowing into the catch (harmless either way, but this keeps the test quiet).
vi.mock('../../adv-sessions', () => ({ reactivateAdvSessionByOwner: vi.fn(async () => {}) }));

const identity = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `bee · ${ownerId}`,
  source: 'fleet-spawn',
  workspaceId: 'ws-1',
  userId: null,
});

describe('writePresence — pending fleet placement persists a non-null membership fact (WI-1408)', () => {
  beforeEach(() => {
    storeWriteMock.mockClear();
    appendFleetMembershipEventMock.mockClear();
    appendFleetMembershipIfAbsentMock.mockClear();
  });

  it('a member launched with --fleet (bootstrap-su/-role\'s setPendingFleet) registers a non-null fleetSlug/fleetRole fact on its first presence write', async () => {
    const { writePresence, setPendingFleet } = await import('./presence');
    setPendingFleet('su-member-1', 'atlas-fleet', 'member');

    await writePresence(identity('su-member-1'));

    expect(storeWriteMock).toHaveBeenCalledTimes(1); // the normal presence write still happens
    expect(appendFleetMembershipEventMock).toHaveBeenCalledTimes(1);
    expect(appendFleetMembershipEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerId: 'su-member-1',
        fleetSlug: 'atlas-fleet',
        fleetRole: 'member',
      }),
      undefined,
    );
    // The bug this fixes: fleetSlug landing null. Assert the actual call args are non-null.
    const call = appendFleetMembershipEventMock.mock.calls[0][0] as { fleetSlug: string | null };
    expect(call.fleetSlug).not.toBeNull();
  });

  it('a leader create (--fleet-name) registers its role too', async () => {
    const { writePresence, setPendingFleet } = await import('./presence');
    setPendingFleet('su-leader-1', 'nimbus-fleet', 'leader');

    await writePresence(identity('su-leader-1'));

    expect(appendFleetMembershipEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-leader-1', fleetSlug: 'nimbus-fleet', fleetRole: 'leader' }),
      undefined,
    );
  });

  it('a plain (non-fleet) launch appends NO membership fact at all — byte-identical to today', async () => {
    const { writePresence } = await import('./presence');

    await writePresence(identity('su-plain-1'));

    expect(appendFleetMembershipEventMock).not.toHaveBeenCalled();
    expect(appendFleetMembershipIfAbsentMock).not.toHaveBeenCalled();
  });

  it('one-shot: a second presence write for the same owner does not re-append (placement already consumed)', async () => {
    const { writePresence, setPendingFleet } = await import('./presence');
    setPendingFleet('su-member-2', 'atlas-fleet', 'member');

    await writePresence(identity('su-member-2'));
    expect(appendFleetMembershipEventMock).toHaveBeenCalledTimes(1);

    appendFleetMembershipEventMock.mockClear();
    await writePresence(identity('su-member-2'));
    expect(appendFleetMembershipEventMock).not.toHaveBeenCalled();
  });
});
