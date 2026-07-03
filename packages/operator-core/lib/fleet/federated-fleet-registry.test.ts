import { describe, it, expect } from 'vitest';
import {
  resolveFederatedFleetLeader,
  unionFederatedFleetMembers,
  type FederatedFleetMember,
} from './federated-fleet-registry';

describe('resolveFederatedFleetLeader', () => {
  it('prefers the durable LOCAL registry leader over any federated signal', () => {
    const members: FederatedFleetMember[] = [{ ownerId: 'su-remote', fleetRole: 'leader' }];
    expect(
      resolveFederatedFleetLeader({ localRegistryLeader: 'su-local', federatedMembers: members }),
    ).toBe('su-local');
  });

  it('derives the leader from a federated member when the registry row is elsewhere', () => {
    const members: FederatedFleetMember[] = [
      { ownerId: 'su-a', fleetRole: 'member' },
      { ownerId: 'su-b', fleetRole: 'leader' },
    ];
    expect(
      resolveFederatedFleetLeader({ localRegistryLeader: null, federatedMembers: members }),
    ).toBe('su-b');
  });

  it('is role-case-insensitive', () => {
    const members: FederatedFleetMember[] = [{ ownerId: 'su-b', fleetRole: 'LEADER' }];
    expect(resolveFederatedFleetLeader({ federatedMembers: members })).toBe('su-b');
  });

  it('picks deterministically (lowest ownerId) when two machines both claim leader', () => {
    const members: FederatedFleetMember[] = [
      { ownerId: 'su-zeta', fleetRole: 'leader' },
      { ownerId: 'su-alpha', fleetRole: 'leader' },
    ];
    // Order-independent: both orderings converge on the same pick.
    expect(resolveFederatedFleetLeader({ federatedMembers: members })).toBe('su-alpha');
    expect(
      resolveFederatedFleetLeader({ federatedMembers: [...members].reverse() }),
    ).toBe('su-alpha');
  });

  it('returns null for a leaderless fleet (no local registry, no federated leader)', () => {
    const members: FederatedFleetMember[] = [{ ownerId: 'su-a', fleetRole: 'member' }];
    expect(
      resolveFederatedFleetLeader({ localRegistryLeader: null, federatedMembers: members }),
    ).toBeNull();
    expect(resolveFederatedFleetLeader({})).toBeNull();
  });

  it('ignores a blank local leader and falls through to the federated leader', () => {
    const members: FederatedFleetMember[] = [{ ownerId: 'su-b', fleetRole: 'leader' }];
    expect(
      resolveFederatedFleetLeader({ localRegistryLeader: '   ', federatedMembers: members }),
    ).toBe('su-b');
  });
});

describe('unionFederatedFleetMembers', () => {
  it('unions local + federated members, deduped, provenance-ordered', () => {
    expect(
      unionFederatedFleetMembers({
        localMemberIds: ['su-local1', 'su-local2'],
        federatedMemberIds: ['su-local2', 'su-remote1'],
      }),
    ).toEqual(['su-local1', 'su-local2', 'su-remote1']);
  });

  it('folds the leader in LAST when absent (matches the local push-if-missing fix)', () => {
    expect(
      unionFederatedFleetMembers({
        localMemberIds: ['su-m1'],
        federatedMemberIds: ['su-m2'],
        leaderOwnerId: 'su-lead',
      }),
    ).toEqual(['su-m1', 'su-m2', 'su-lead']);
  });

  it('does NOT reorder a leader who is already a live member', () => {
    expect(
      unionFederatedFleetMembers({
        localMemberIds: ['su-lead', 'su-m1'],
        federatedMemberIds: [],
        leaderOwnerId: 'su-lead',
      }),
    ).toEqual(['su-lead', 'su-m1']);
  });

  it('drops blank / nullish ids and dedupes across all three sources', () => {
    expect(
      unionFederatedFleetMembers({
        localMemberIds: ['su-a', '', '  '],
        federatedMemberIds: ['su-a', 'su-b'],
        leaderOwnerId: 'su-b',
      }),
    ).toEqual(['su-a', 'su-b']);
  });

  it('collapses to local-only behavior on a single box (empty federated inputs)', () => {
    expect(
      unionFederatedFleetMembers({ localMemberIds: ['su-a', 'su-b'] }),
    ).toEqual(['su-a', 'su-b']);
    expect(unionFederatedFleetMembers({})).toEqual([]);
  });
});
