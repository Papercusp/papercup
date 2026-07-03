import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ROLLOUT_TIER,
  federatedShareDecision,
  federationRolloutInvariant,
  gossipFanout,
  resolveMaxRolloutTier,
  shareAllowed,
} from './federation-rollout';

describe('resolveMaxRolloutTier — kill-switch + structural clamp', () => {
  it('flag OFF ⇒ tier 0 (nothing shared) regardless of configuration', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: false, configuredMaxTier: 3 })).toBe(0);
  });

  it('flag ON but no prereqs landed ⇒ clamps to tier 1 even if the owner configured 3', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true, configuredMaxTier: 3 })).toBe(1);
  });

  it('defaults the ceiling to tier 1 (hive-members-only) when unset', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true })).toBe(DEFAULT_MAX_ROLLOUT_TIER);
    expect(DEFAULT_MAX_ROLLOUT_TIER).toBe(1);
  });

  it('cross-hive gossip landed ⇒ tier 2 reachable, tier 3 still clamped without the reputation gate', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true, configuredMaxTier: 2, crossHiveLanded: true })).toBe(2);
    expect(resolveMaxRolloutTier({ flagEnabled: true, configuredMaxTier: 3, crossHiveLanded: true })).toBe(2);
  });

  it('both prereqs landed ⇒ tier 3 reachable, but the owner ceiling still caps it', () => {
    expect(
      resolveMaxRolloutTier({ flagEnabled: true, configuredMaxTier: 3, crossHiveLanded: true, reputationGateLanded: true }),
    ).toBe(3);
    expect(
      resolveMaxRolloutTier({ flagEnabled: true, configuredMaxTier: 1, crossHiveLanded: true, reputationGateLanded: true }),
    ).toBe(1);
  });
});

describe('shareAllowed — audience gating per tier', () => {
  it('tier 0 shares to nobody', () => {
    expect(shareAllowed(0, 'hive-member')).toBe(false);
    expect(shareAllowed(0, 'cross-hive')).toBe(false);
    expect(shareAllowed(0, 'open-network')).toBe(false);
  });

  it('tier 1 shares to hive members only', () => {
    expect(shareAllowed(1, 'hive-member')).toBe(true);
    expect(shareAllowed(1, 'cross-hive')).toBe(false);
    expect(shareAllowed(1, 'open-network')).toBe(false);
  });

  it('tier 2 adds cross-hive, tier 3 adds open-network', () => {
    expect(shareAllowed(2, 'cross-hive')).toBe(true);
    expect(shareAllowed(2, 'open-network')).toBe(false);
    expect(shareAllowed(3, 'open-network')).toBe(true);
  });
});

describe('federatedShareDecision — the egress writer one-call gate', () => {
  it('denies a cross-hive share at the default (tier-1) ceiling', () => {
    expect(federatedShareDecision({ flagEnabled: true, audience: 'cross-hive' })).toEqual({ tier: 1, allowed: false });
  });

  it('allows a hive-member share at tier 1, and cross-hive once gossip lands', () => {
    expect(federatedShareDecision({ flagEnabled: true, audience: 'hive-member' })).toEqual({ tier: 1, allowed: true });
    expect(
      federatedShareDecision({ flagEnabled: true, configuredMaxTier: 2, crossHiveLanded: true, audience: 'cross-hive' }),
    ).toEqual({ tier: 2, allowed: true });
  });

  it('denies everything when the kill-switch is off', () => {
    expect(federatedShareDecision({ flagEnabled: false, audience: 'hive-member' })).toEqual({ tier: 0, allowed: false });
  });
});

describe('gossipFanout — log-cost coverage', () => {
  it('is 0 with no peers and grows logarithmically, capped', () => {
    expect(gossipFanout(0)).toBe(0);
    expect(gossipFanout(1)).toBe(1); // ceil(log2(2)) = 1
    expect(gossipFanout(7)).toBe(3); // ceil(log2(8)) = 3
    expect(gossipFanout(1000, { cap: 8 })).toBe(8); // ceil(log2(1001))=10 → capped
  });
});

describe('federationRolloutInvariant', () => {
  it('holds across the flag/prereq/ceiling matrix', () => {
    const cases = [
      { flagEnabled: false, configuredMaxTier: 3 as const },
      { flagEnabled: true },
      { flagEnabled: true, configuredMaxTier: 2 as const, crossHiveLanded: true },
      { flagEnabled: true, configuredMaxTier: 3 as const, crossHiveLanded: true, reputationGateLanded: true },
    ];
    for (const c of cases) expect(federationRolloutInvariant(c)).toBe(true);
  });
});
