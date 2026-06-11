// network-board tier classifier (hive-network-surface-2026-06-11 B-08 / C-3):
// the ONE map from a hive-context's provenance to its capability tier + trust.
// Shared by B-08 (aggregate board) and B-11 (HUD Hives relabel) — this test pins
// the mapping so the two surfaces can never disagree on what "trusted" means.

import { describe, expect, it } from 'vitest';
import { classifyNetworkTier, trustForTier } from './tier-classifier';
import type { NetworkTier, NetworkTrust } from './types';

describe('classifyNetworkTier', () => {
  it('home own-hive → tier 1 / local', () => {
    expect(classifyNetworkTier({ kind: 'local-hive', isHome: true })).toEqual({
      tier: 1,
      trust: 'local',
    });
  });

  it('own other hive (same box) → tier 2 / admin', () => {
    expect(classifyNetworkTier({ kind: 'local-hive', isHome: false })).toEqual({
      tier: 2,
      trust: 'admin',
    });
  });

  it('federated peer Swarm → tier 3 / federated', () => {
    expect(classifyNetworkTier({ kind: 'federated-peer' })).toEqual({
      tier: 3,
      trust: 'federated',
    });
  });

  it('foreign directory hive → tier 4 / gossip', () => {
    expect(classifyNetworkTier({ kind: 'foreign-hive' })).toEqual({
      tier: 4,
      trust: 'gossip',
    });
  });

  it('trust is a strict function of tier (no other combinations exist)', () => {
    const seen = new Set<NetworkTrust>();
    for (const src of [
      { kind: 'local-hive', isHome: true } as const,
      { kind: 'local-hive', isHome: false } as const,
      { kind: 'federated-peer' } as const,
      { kind: 'foreign-hive' } as const,
    ]) {
      const { tier, trust } = classifyNetworkTier(src);
      // each tier maps to exactly one trust, and no trust repeats across tiers
      expect(trust).toBe(trustForTier(tier));
      expect(seen.has(trust)).toBe(false);
      seen.add(trust);
    }
    expect(seen).toEqual(new Set(['local', 'admin', 'federated', 'gossip']));
  });
});

describe('trustForTier', () => {
  it.each<[NetworkTier, NetworkTrust]>([
    [1, 'local'],
    [2, 'admin'],
    [3, 'federated'],
    [4, 'gossip'],
  ])('tier %i → %s', (tier, trust) => {
    expect(trustForTier(tier)).toBe(trust);
  });
});
