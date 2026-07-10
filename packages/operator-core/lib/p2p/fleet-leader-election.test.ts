/**
 * fleet-leader-election.test.ts — P-302 (p2p-work-distribution-2026-07-02).
 * Proves the PURE cross-machine fleet leader election composed from the P-021 HRW
 * selector + lease stickiness + C4 roster epochs, BEFORE any live wiring:
 *   (1) HRW winner among the fleet's live member DEVICES; self-leadership detect,
 *   (2) MEMBERSHIP GATE — a non-member device never leads, even when present,
 *   (3) vacated fleet (no live member device) ⇒ no leader,
 *   (4) LEASE STICKINESS damps failover flap; expiry + dead-incumbent yield,
 *   (5) ROSTER-EPOCH alignment — an epoch advance breaks stale stickiness so a
 *       revoked leader loses the fleet immediately,
 *   (6) FENCING — a stale (behind) roster read defers to the higher-epoch lease;
 *       a lower-epoch announce is rejected,
 *   (7) DETERMINISM — every peer computes the identical leader (agreement-free),
 *   (8) announce-on-change reasons + lease bookkeeping.
 */
import { describe, expect, it } from 'vitest';
import {
  electFleetLeader,
  leadershipAnnouncement,
  acceptLeadershipAnnouncement,
  foldHighestSeenEpoch,
  nextLeaseFromDecision,
  type FleetMemberDevice,
  type FleetLeaderLease,
  type ElectFleetLeaderInput,
} from './fleet-leader-election';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import type { SelfSwarmIdentity } from '../authority/lock-authority';

const NOW = 1_800_000_000_000;
const STALE = 90_000;
const LEASE = 30_000;
const OWNER = 42;
const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' };
const SCOPE_KEY = `fleet:${OWNER}/alpha`;

const dev = (pub: string, over?: Partial<FleetMemberDevice>): FleetMemberDevice => ({
  device_pubkey: pub,
  github_user_id: OWNER,
  machine_label: pub,
  last_seen_ms: NOW - 1_000,
  ...over,
});

const self = (pub: string, uid = OWNER): SelfSwarmIdentity => ({ githubUserId: uid, devicePubkey: pub });

// Build a full input with sensible defaults; override per test.
const input = (over: Partial<ElectFleetLeaderInput>): ElectFleetLeaderInput => ({
  scope: SCOPE,
  rosterMemberUids: new Set([OWNER]),
  rosterEpoch: 1,
  presence: [],
  self: null,
  incumbent: null,
  nowMs: NOW,
  staleMs: STALE,
  leaseMs: LEASE,
  ...over,
});

// Generate N deterministic device pubkeys.
const devs = (n: number) => Array.from({ length: n }, (_, i) => `dev-${String(i).padStart(3, '0')}-pub`);

describe('electFleetLeader — HRW election among live member devices', () => {
  it('elects a single deterministic leader among member devices', () => {
    const presence = devs(5).map((p) => dev(p));
    const d = electFleetLeader(input({ presence }));
    expect(d.scopeKey).toBe(SCOPE_KEY);
    expect(d.leaderDevicePubkey).not.toBeNull();
    expect(presence.map((r) => r.device_pubkey)).toContain(d.leaderDevicePubkey);
    expect(d.liveMemberDevices).toBe(5);
    expect(d.rosterEpoch).toBe(1);
    expect(d.changed).toBe(true); // no incumbent → first election is a change
    expect(d.fenced).toBe(false);
  });

  it('reports isSelf when this peer wins the fleet', () => {
    const ps = devs(6);
    // Whichever device is elected, that peer sees isSelf:true from the same rows.
    const base = ps.map((p) => dev(p));
    const leader = electFleetLeader(input({ presence: base })).leaderDevicePubkey!;
    const asLeader = electFleetLeader(input({ presence: base, self: self(leader) }));
    expect(asLeader.isSelf).toBe(true);
    expect(asLeader.leaderDevicePubkey).toBe(leader);
    const other = ps.find((p) => p !== leader)!;
    const asOther = electFleetLeader(input({ presence: base, self: self(other) }));
    expect(asOther.isSelf).toBe(false);
    expect(asOther.leaderDevicePubkey).toBe(leader);
  });

  it('a single member device (alone) leads its fleet', () => {
    const d = electFleetLeader(input({ presence: [dev('solo-pub')], self: self('solo-pub') }));
    expect(d.leaderDevicePubkey).toBe('solo-pub');
    expect(d.isSelf).toBe(true);
  });
});

describe('membership gate — only roster-member devices can lead', () => {
  it('never elects a non-member device even when it is present', () => {
    // Owner has NO live device; a non-member (uid 99) is present. Fleet is vacated.
    const presence = [dev('intruder-pub', { github_user_id: 99 })];
    const d = electFleetLeader(input({ presence, rosterMemberUids: new Set([OWNER]) }));
    expect(d.leaderDevicePubkey).toBeNull();
    expect(d.liveMemberDevices).toBe(0);
  });

  it('picks the member device and ignores the non-member in the same swarm', () => {
    const presence = [dev('member-pub'), dev('intruder-pub', { github_user_id: 99 })];
    const d = electFleetLeader(input({ presence }));
    expect(d.leaderDevicePubkey).toBe('member-pub');
    expect(d.liveMemberDevices).toBe(1);
  });

  it('self cannot lead a fleet it is not a member of', () => {
    const d = electFleetLeader(input({ presence: [], self: self('outsider-pub', 99) }));
    expect(d.leaderDevicePubkey).toBeNull();
    expect(d.isSelf).toBe(false);
  });

  it('widens to a tier-2 publisher-set member (multi-owner roster)', () => {
    const presence = [dev('pub-a', { github_user_id: 100 })];
    const d = electFleetLeader(input({ presence, rosterMemberUids: new Set([OWNER, 100]) }));
    expect(d.leaderDevicePubkey).toBe('pub-a');
    expect(d.leaderGithubUserId).toBe(100);
  });
});

describe('vacated fleet — no live member device', () => {
  it('yields no leader and marks a change when an incumbent existed', () => {
    const incumbent: FleetLeaderLease = { devicePubkey: 'gone-pub', githubUserId: OWNER, sinceMs: NOW - 5_000, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: [], incumbent }));
    expect(d.leaderDevicePubkey).toBeNull();
    expect(d.changed).toBe(true);
    const ann = leadershipAnnouncement(d, incumbent);
    expect(ann?.reason).toBe('vacated');
    expect(ann?.leaderDevicePubkey).toBeNull();
  });

  it('all member devices stale ⇒ vacated', () => {
    const presence = [dev('a-pub', { last_seen_ms: NOW - STALE - 1 }), dev('b-pub', { last_seen_ms: NOW - STALE - 1 })];
    const d = electFleetLeader(input({ presence }));
    expect(d.leaderDevicePubkey).toBeNull();
  });
});

describe('lease stickiness — damps failover flap', () => {
  // Find two devices where HRW would prefer B, but A is the incumbent.
  const ps = devs(8).map((p) => dev(p));
  const hrwLeader = electFleetLeader(input({ presence: ps })).leaderDevicePubkey!;
  const nonLeader = ps.map((r) => r.device_pubkey).find((p) => p !== hrwLeader)!;

  it('keeps a LIVE incumbent within the lease window even when HRW prefers another', () => {
    const incumbent: FleetLeaderLease = { devicePubkey: nonLeader, githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: ps, incumbent }));
    expect(d.leaderDevicePubkey).toBe(nonLeader); // sticky, not the HRW winner
    expect(d.changed).toBe(false);
    expect(leadershipAnnouncement(d, incumbent)).toBeNull();
  });

  it('yields to the HRW winner once the lease has expired', () => {
    const incumbent: FleetLeaderLease = { devicePubkey: nonLeader, githubUserId: OWNER, sinceMs: NOW - LEASE - 1, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: ps, incumbent }));
    expect(d.leaderDevicePubkey).toBe(hrwLeader);
    expect(d.changed).toBe(true);
    expect(leadershipAnnouncement(d, incumbent)?.reason).toBe('failover');
  });

  it('never keeps a DEAD incumbent sticky — yields immediately', () => {
    // Incumbent within lease window BUT no longer present ⇒ HRW winner takes over.
    const incumbent: FleetLeaderLease = { devicePubkey: 'dead-pub', githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: ps, incumbent }));
    expect(d.leaderDevicePubkey).toBe(hrwLeader);
    expect(d.changed).toBe(true);
  });
});

describe('roster-epoch alignment (C4)', () => {
  const ps = devs(8).map((p) => dev(p));
  const hrwLeader = electFleetLeader(input({ presence: ps })).leaderDevicePubkey!;
  const nonLeader = ps.map((r) => r.device_pubkey).find((p) => p !== hrwLeader)!;

  it('an epoch ADVANCE breaks stale stickiness (re-elect fresh)', () => {
    // Incumbent would be sticky at epoch 1, but the roster epoch advanced to 2.
    const incumbent: FleetLeaderLease = { devicePubkey: nonLeader, githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: ps, incumbent, rosterEpoch: 2 }));
    expect(d.epochAdvanced).toBe(true);
    expect(d.leaderDevicePubkey).toBe(hrwLeader); // stickiness dropped
    expect(d.rosterEpoch).toBe(2);
    expect(leadershipAnnouncement(d, incumbent)?.reason).toBe('epoch-advance');
  });

  it('a revoked leader loses the fleet immediately on the epoch bump', () => {
    // The incumbent leader (uid 100) is dropped from the roster + epoch bumps.
    const presence = [dev('owner-dev'), dev('revoked-dev', { github_user_id: 100 })];
    const incumbent: FleetLeaderLease = { devicePubkey: 'revoked-dev', githubUserId: 100, sinceMs: NOW - 1_000, rosterEpoch: 1 };
    const d = electFleetLeader(
      input({ presence, incumbent, rosterEpoch: 2, rosterMemberUids: new Set([OWNER]) }),
    );
    expect(d.leaderDevicePubkey).toBe('owner-dev');
    expect(d.leaderGithubUserId).toBe(OWNER);
    expect(d.changed).toBe(true);
  });

  it('same epoch + same live leader ⇒ no change, no announce', () => {
    const incumbent: FleetLeaderLease = { devicePubkey: hrwLeader, githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 1 };
    const d = electFleetLeader(input({ presence: ps, incumbent, rosterEpoch: 1 }));
    expect(d.leaderDevicePubkey).toBe(hrwLeader);
    expect(d.changed).toBe(false);
    expect(leadershipAnnouncement(d, incumbent)).toBeNull();
  });
});

describe('fencing — a behind roster read defers to a higher-epoch lease', () => {
  it('does not override a lease minted under a higher epoch', () => {
    const ps = devs(4).map((p) => dev(p));
    const incumbent: FleetLeaderLease = { devicePubkey: 'other-leader-pub', githubUserId: OWNER, sinceMs: NOW - 1_000, rosterEpoch: 5 };
    const d = electFleetLeader(input({ presence: ps, incumbent, rosterEpoch: 3 }));
    expect(d.fenced).toBe(true);
    expect(d.leaderDevicePubkey).toBe('other-leader-pub');
    expect(d.rosterEpoch).toBe(5);
    expect(d.changed).toBe(false);
  });

  it('acceptLeadershipAnnouncement rejects a lower-epoch (stale) announce', () => {
    expect(acceptLeadershipAnnouncement(5, 5)).toBe(true);
    expect(acceptLeadershipAnnouncement(6, 5)).toBe(true);
    expect(acceptLeadershipAnnouncement(4, 5)).toBe(false); // fenced out
  });

  it('foldHighestSeenEpoch is monotonic', () => {
    const ann = { scopeKey: SCOPE_KEY, leaderDevicePubkey: 'x', leaderGithubUserId: OWNER, rosterEpoch: 7, reason: 'elected' as const };
    expect(foldHighestSeenEpoch(5, ann)).toBe(7);
    expect(foldHighestSeenEpoch(9, ann)).toBe(9);
  });
});

describe('determinism — every peer computes the identical leader (agreement-free)', () => {
  it('is independent of which peer is self and of presence row order', () => {
    const ps = devs(9).map((p) => dev(p));
    const baseline = electFleetLeader(input({ presence: ps })).leaderDevicePubkey!;
    // Each peer sees the same full presence set but with itself as self, in shuffled order.
    for (const p of ps) {
      const shuffled = [...ps].reverse();
      const d = electFleetLeader(input({ presence: shuffled, self: self(p.device_pubkey) }));
      expect(d.leaderDevicePubkey).toBe(baseline);
    }
  });
});

describe('announce reasons + lease bookkeeping', () => {
  it('reason "elected" on a first election', () => {
    const d = electFleetLeader(input({ presence: [dev('a-pub')] }));
    expect(leadershipAnnouncement(d, null)?.reason).toBe('elected');
  });

  it('nextLeaseFromDecision preserves sinceMs across a no-op re-election and resets on change', () => {
    const ps = devs(6).map((p) => dev(p));
    const leader = electFleetLeader(input({ presence: ps })).leaderDevicePubkey!;
    const incumbent: FleetLeaderLease = { devicePubkey: leader, githubUserId: OWNER, sinceMs: NOW - 10_000, rosterEpoch: 1 };
    const same = electFleetLeader(input({ presence: ps, incumbent }));
    const keptLease = nextLeaseFromDecision(same, incumbent, NOW);
    expect(keptLease?.sinceMs).toBe(NOW - 10_000); // preserved
    expect(keptLease?.rosterEpoch).toBe(1);

    // A different leader resets sinceMs to now.
    const other = ps.map((r) => r.device_pubkey).find((p) => p !== leader)!;
    const otherInc: FleetLeaderLease = { devicePubkey: other, githubUserId: OWNER, sinceMs: NOW - LEASE - 1, rosterEpoch: 1 };
    const moved = electFleetLeader(input({ presence: ps, incumbent: otherInc }));
    const newLease = nextLeaseFromDecision(moved, otherInc, NOW);
    expect(newLease?.devicePubkey).toBe(leader);
    expect(newLease?.sinceMs).toBe(NOW);
  });

  it('nextLeaseFromDecision returns null when leadership is vacated', () => {
    const d = electFleetLeader(input({ presence: [] }));
    expect(nextLeaseFromDecision(d, null, NOW)).toBeNull();
  });
});
