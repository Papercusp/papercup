/**
 * Unit tests for the P2P rollout-tier policy (p2p-work-distribution P-005).
 * Pins the FS-D5 HARD GATE: tier 2 (cross-user) is structurally unreachable
 * until §5.4 per-scope crypto + the X1 loopback boundary (P-105) land, and the
 * capability ceilings (tier 2 ≤ Delegate, tier 3 = Operator) stay consistent.
 */
import { describe, expect, it } from 'vitest';
import {
  TIER2_PREREQS_LANDED,
  TIER3_PREREQS_LANDED,
  TIER_CAPABILITY_CEILING,
  crossUserCapabilityCeiling,
  describeRolloutTier,
  resolveMaxRolloutTier,
  rolloutTiersInvariant,
  tierAllowsCrossUser,
} from './rollout-tiers';

describe('resolveMaxRolloutTier', () => {
  it('flag OFF ⇒ tier 0 (the kill-switch stops everything)', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: false })).toBe(0);
    // ...even if prereqs are (hypothetically) landed — the kill-switch wins.
    expect(
      resolveMaxRolloutTier({ flagEnabled: false, tier2PrereqsLanded: true, tier3PrereqsLanded: true }),
    ).toBe(0);
  });

  it('flag ON, no prereqs ⇒ tier 1 (same-owner only) — the state TODAY', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true })).toBe(1);
  });

  it('FS-D5: the shipped constants keep tier 2 structurally unreachable today', () => {
    expect(TIER2_PREREQS_LANDED).toBe(false);
    expect(TIER3_PREREQS_LANDED).toBe(false);
    // The real default-arg path (no injected prereqs) must resolve to tier 1.
    expect(resolveMaxRolloutTier({ flagEnabled: true })).toBe(1);
  });

  it('widens to tier 2 only when tier-2 prereqs land (P-105 flips the switch)', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true, tier2PrereqsLanded: true })).toBe(2);
  });

  it('tier 3 requires BOTH prereqs; tier-3 prereqs alone never yield 3', () => {
    expect(resolveMaxRolloutTier({ flagEnabled: true, tier2PrereqsLanded: true, tier3PrereqsLanded: true })).toBe(3);
    // spawn ⊇ delegate reach: t3 without t2 cannot skip past tier 1.
    expect(resolveMaxRolloutTier({ flagEnabled: true, tier3PrereqsLanded: true })).toBe(1);
  });
});

describe('tierAllowsCrossUser', () => {
  it('tiers 0 and 1 never reach cross-user peers; tiers 2 and 3 do', () => {
    expect(tierAllowsCrossUser(0)).toBe(false);
    expect(tierAllowsCrossUser(1)).toBe(false);
    expect(tierAllowsCrossUser(2)).toBe(true);
    expect(tierAllowsCrossUser(3)).toBe(true);
  });
});

describe('crossUserCapabilityCeiling', () => {
  it('tier ≤ 1: empty (same-owner only, no cross-user grant is enforceable)', () => {
    expect(crossUserCapabilityCeiling(0)).toEqual([]);
    expect(crossUserCapabilityCeiling(1)).toEqual([]);
  });

  it('tier 2 caps at Delegate (+work-offer, wake) and NEVER carries spawn', () => {
    const caps = crossUserCapabilityCeiling(2);
    expect(caps).toContain('work-offer');
    expect(caps).toContain('wake');
    expect(caps).not.toContain('spawn');
  });

  it('tier 3 carries the Operator set including spawn', () => {
    expect(crossUserCapabilityCeiling(3)).toContain('spawn');
  });

  it('returns a fresh array (no shared mutable ceiling state)', () => {
    const a = crossUserCapabilityCeiling(2);
    a.push('spawn' as never);
    expect(crossUserCapabilityCeiling(2)).not.toContain('spawn');
  });
});

describe('rolloutTiersInvariant (FS-D5 recurrence guard)', () => {
  it('the shipped ceilings are healthy (no violations)', () => {
    expect(rolloutTiersInvariant()).toEqual([]);
  });

  it('flags a tier-2 ceiling that leaks spawn', () => {
    // Simulate a bad edit: point tier 2 at Operator.
    const saved = TIER_CAPABILITY_CEILING[2];
    (TIER_CAPABILITY_CEILING as Record<number, string>)[2] = 'operator';
    try {
      expect(rolloutTiersInvariant()).toContain('tier 2 ceiling must not carry spawn (Delegate cap)');
    } finally {
      (TIER_CAPABILITY_CEILING as Record<number, string>)[2] = saved;
    }
  });

  it('flags tier-3 prereqs landed without tier-2 prereqs', () => {
    expect(rolloutTiersInvariant(false, true)).toContain(
      'tier 3 prereqs cannot be landed without tier 2 prereqs',
    );
  });
});

describe('describeRolloutTier', () => {
  it('gives a human line for every tier', () => {
    expect(describeRolloutTier(0)).toMatch(/kill-switch/i);
    expect(describeRolloutTier(1)).toMatch(/same-owner/i);
    expect(describeRolloutTier(2)).toMatch(/Delegate/i);
    expect(describeRolloutTier(3)).toMatch(/Operator/i);
  });
});
