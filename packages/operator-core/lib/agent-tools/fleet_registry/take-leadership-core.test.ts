/**
 * Unit tests for the SHARED leadership-transfer effect (EI-5705 / EI-5704). The store +
 * presence + coord seams are mocked, so this verifies the ORCHESTRATION — single-leader
 * install, prior-leader demotion (incl. the no-fleet-label case), the displaced-leader
 * notification, and the `notified` return — without PG. The pure `shouldDemotePriorLeader`
 * predicate runs real (it is cheap + tested separately in _shared.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';

const setFleetLeader = vi.fn();
const heartbeatPresence = vi.fn();
const setPresenceFleet = vi.fn();
const fetchPresenceFleet = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../agent-fleets-store', () => ({
  setFleetLeader: (...a: unknown[]) => setFleetLeader(...a),
}));
vi.mock('../coordination/presence', () => ({
  heartbeatPresence: (...a: unknown[]) => heartbeatPresence(...a),
  setPresenceFleet: (...a: unknown[]) => setPresenceFleet(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

import { takeFleetLeadership } from './take-leadership-core';

const WS = 'ws';
const SLUG = 'rocket';
const identity = { ownerId: 'su-bob', workspaceId: WS } as never;

function fleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: WS,
    fleetSlug: SLUG,
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    colorScheme: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchPresenceFleet.mockResolvedValue(new Map()); // default: prior leader carries no fleet label
  sendMessage.mockResolvedValue({ msg_id: 'm1' });
});

describe('takeFleetLeadership (D-002 single-leader + notify, EI-5705/EI-5704)', () => {
  it('installs the caller as leader + labels their presence; no prior leader → no demote/notify', async () => {
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: null }), identity, 'su-bob');
    expect(setFleetLeader).toHaveBeenCalledWith(WS, SLUG, 'su-bob');
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-bob', SLUG, 'leader');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(out).toMatchObject({ leader: 'su-bob', previousLeader: null, demotedPriorLeader: null, notified: false });
  });

  it('re-taking your OWN leadership does not demote or notify yourself', async () => {
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-bob' }), identity, 'su-bob');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(out.demotedPriorLeader).toBeNull();
    expect(out.notified).toBe(false);
  });

  it('demotes + notifies a distinct prior leader still labeled in THIS fleet', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: SLUG, fleetRole: 'leader' }]]));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['su-alice'] });
    expect(out).toMatchObject({ previousLeader: 'su-alice', demotedPriorLeader: 'su-alice', notified: true });
  });

  it('demotes + notifies a prior leader with NO fleet label (the leader-of-record case, EI-5705)', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map()); // su-alice carries no fleet label
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(out.demotedPriorLeader).toBe('su-alice');
    expect(out.notified).toBe(true);
  });

  it('does NOT demote a prior leader who moved to another fleet — but STILL notifies them', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: 'other', fleetRole: 'leader' }]]));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    // caller is set to leader, but su-alice is NOT demoted (would yank them out of 'other')
    expect(setPresenceFleet).not.toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(out.demotedPriorLeader).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(out.notified).toBe(true);
  });

  it('a notify failure leaves notified:false but the transfer still lands', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: SLUG, fleetRole: 'leader' }]]));
    sendMessage.mockRejectedValue(new Error('coord down'));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setFleetLeader).toHaveBeenCalledWith(WS, SLUG, 'su-bob');
    expect(out.demotedPriorLeader).toBe('su-alice'); // demote happened before the notify
    expect(out.notified).toBe(false);
  });
});
