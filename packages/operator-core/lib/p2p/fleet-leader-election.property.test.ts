/**
 * fleet-leader-election.property.test.ts — P-302. The invariants a cross-machine
 * leader election must hold for ANY federated input:
 *   (1) DETERMINISM / agreement-free — every peer (whichever device is `self`, in
 *       any row order) computes the identical leader when it shares the presence set,
 *   (2) MEMBERSHIP + LIVENESS — an elected leader is ALWAYS a live roster-member
 *       device (or null); a non-member / stale device never leads,
 *   (3) HRW CHURN CONFINEMENT — removing a NON-leader member device never moves
 *       the leader (the property a global argmin lacks),
 *   (4) STICKINESS — a live incumbent within its lease + roster generation is
 *       retained regardless of the HRW preference.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { electFleetLeader, type FleetMemberDevice, type ElectFleetLeaderInput } from './fleet-leader-election';
import type { ScopeId } from '../sync/hive-git/scope-repo';

const NOW = 1_800_000_000_000;
const STALE = 90_000;
const LEASE = 30_000;
const OWNER = 42;
const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' };

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

/** Distinct device pubkeys. */
const pubkeysArb = fc.uniqueArray(fc.hexaString({ minLength: 6, maxLength: 14 }), {
  minLength: 1,
  maxLength: 10,
});

/** A set of LIVE member devices (all owned by OWNER, all fresh). */
const liveMembersArb: fc.Arbitrary<FleetMemberDevice[]> = pubkeysArb.map((pubs) =>
  pubs.map((p) => ({ device_pubkey: p, github_user_id: OWNER, machine_label: p, last_seen_ms: NOW - 1_000 })),
);

describe('property: determinism / agreement-free', () => {
  it('the leader is independent of which device is `self` and of row order', () => {
    fc.assert(
      fc.property(liveMembersArb, fc.integer({ min: 0, max: 1_000 }), (members, seed) => {
        const baseline = electFleetLeader(input({ presence: members })).leaderDevicePubkey;
        // Every peer federates its own row, so self ∈ presence. Pick each as self.
        for (const m of members) {
          const rotated = [...members.slice(seed % members.length), ...members.slice(0, seed % members.length)];
          const d = electFleetLeader(
            input({ presence: rotated, self: { githubUserId: OWNER, devicePubkey: m.device_pubkey } }),
          );
          expect(d.leaderDevicePubkey).toBe(baseline);
        }
      }),
    );
  });
});

describe('property: membership + liveness invariant', () => {
  it('an elected leader is always a LIVE roster-member device (or null)', () => {
    const mixedArb = fc.array(
      fc.record({
        device_pubkey: fc.hexaString({ minLength: 6, maxLength: 14 }),
        github_user_id: fc.constantFrom(OWNER, 99, 100), // OWNER is the only member
        stale: fc.boolean(),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(mixedArb, (rows) => {
        const presence: FleetMemberDevice[] = rows.map((r) => ({
          device_pubkey: r.device_pubkey,
          github_user_id: r.github_user_id,
          machine_label: r.device_pubkey,
          last_seen_ms: r.stale ? NOW - STALE - 1 : NOW - 1_000,
        }));
        const d = electFleetLeader(input({ presence, rosterMemberUids: new Set([OWNER]) }));
        if (d.leaderDevicePubkey == null) return; // vacated is always legal
        const winner = presence.find((p) => p.device_pubkey === d.leaderDevicePubkey);
        expect(winner).toBeDefined();
        expect(winner!.github_user_id).toBe(OWNER); // member
        expect(winner!.last_seen_ms).toBeGreaterThan(NOW - STALE); // live
      }),
    );
  });
});

describe('property: HRW churn confinement', () => {
  it('removing a NON-leader member device never moves the leader', () => {
    fc.assert(
      fc.property(
        liveMembersArb.filter((m) => m.length >= 2),
        fc.integer({ min: 0, max: 1_000 }),
        (members, idx) => {
          const leader = electFleetLeader(input({ presence: members })).leaderDevicePubkey!;
          // Pick a device to remove that is NOT the leader.
          const removable = members.filter((m) => m.device_pubkey !== leader);
          if (removable.length === 0) return;
          const victim = removable[idx % removable.length];
          const reduced = members.filter((m) => m.device_pubkey !== victim.device_pubkey);
          const after = electFleetLeader(input({ presence: reduced })).leaderDevicePubkey;
          expect(after).toBe(leader); // leader unchanged — churn confined
        },
      ),
    );
  });
});

describe('property: stickiness retains a live incumbent within its lease', () => {
  it('a live incumbent in the same roster generation is kept regardless of HRW', () => {
    fc.assert(
      fc.property(
        liveMembersArb.filter((m) => m.length >= 2),
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 0, max: LEASE - 1 }),
        (members, idx, age) => {
          // Make any live member the incumbent, elected `age` ms ago (< LEASE).
          const incDev = members[idx % members.length];
          const d = electFleetLeader(
            input({
              presence: members,
              incumbent: { devicePubkey: incDev.device_pubkey, githubUserId: OWNER, sinceMs: NOW - age, rosterEpoch: 1 },
              rosterEpoch: 1,
            }),
          );
          // The incumbent is live + within lease + same epoch ⇒ it stays leader.
          expect(d.leaderDevicePubkey).toBe(incDev.device_pubkey);
          expect(d.changed).toBe(false);
        },
      ),
    );
  });
});
