import { describe, expect, it } from 'vitest';
import {
  computeDepthAwareCrowding,
  CONTROL_HIVE_FEDERATED_PRIMING,
  DEFAULT_FEDERATED_PRIMING,
  isControlHivePriming,
  resolveFederatedPrimingConfig,
} from './federated-priming';

describe('resolveFederatedPrimingConfig / control profile', () => {
  it('returns the owner-ratified defaults when unset', () => {
    expect(resolveFederatedPrimingConfig()).toEqual(DEFAULT_FEDERATED_PRIMING);
    expect(resolveFederatedPrimingConfig(null)).toEqual(DEFAULT_FEDERATED_PRIMING);
  });

  it('recognizes the all-zero control arm', () => {
    expect(isControlHivePriming(CONTROL_HIVE_FEDERATED_PRIMING)).toBe(true);
    expect(isControlHivePriming(DEFAULT_FEDERATED_PRIMING)).toBe(false);
  });
});

describe('computeDepthAwareCrowding', () => {
  it('counts depth by elites above the fitness bar, not mere occupancy', () => {
    const stats = computeDepthAwareCrowding(
      [
        { nicheKey: 'v1:loop/guard/r2/m', fitness: 0.91, sourceHive: null },
        { nicheKey: 'v1:loop/guard/r2/m', fitness: 0.87, sourceHive: 'peer-a' },
        { nicheKey: 'v1:loop/guard/r2/m', fitness: 0.41, sourceHive: 'peer-b' }, // occupied, but below bar
        { nicheKey: 'v1:ui/integration/r2/m', fitness: 0.93, sourceHive: 'peer-c' },
      ],
      { fitnessBar: 0.8 },
    );

    expect(stats[0]).toMatchObject({
      nicheKey: 'v1:loop/guard/r2/m',
      totalElites: 3,
      elitesAboveBar: 2,
      contributingSources: 3,
      sourcesAboveBar: 2,
      bestFitness: 0.91,
    });
    expect(stats[1]).toMatchObject({
      nicheKey: 'v1:ui/integration/r2/m',
      totalElites: 1,
      elitesAboveBar: 1,
    });
  });

  it('counts novelty gifts and keeps local+foreign sources distinct', () => {
    const [stat] = computeDepthAwareCrowding(
      [
        { nicheKey: 'v1:infra/observability/r1/s', fitness: 0.9, noveltyGift: true },
        { nicheKey: 'v1:infra/observability/r1/s', fitness: 0.95, sourceHive: 'peer-a', noveltyGift: true },
      ],
      { fitnessBar: 0.5 },
    );

    expect(stat.noveltyGiftCount).toBe(2);
    expect(stat.contributingSources).toBe(2);
    expect(stat.sourcesAboveBar).toBe(2);
  });

  it('uses the mapping seam when grouping raw niche keys', () => {
    const [stat] = computeDepthAwareCrowding(
      [
        { nicheKey: 'v1:loop/guard/r2/m', fitness: 0.9 },
        { nicheKey: 'v2:emb/0007', fitness: 0.92, sourceHive: 'peer-a' },
      ],
      {
        fitnessBar: 0.8,
        mapKey: (key) => (key === 'v1:loop/guard/r2/m' ? 'v2:emb/0007' : key),
      },
    );

    expect(stat.nicheKey).toBe('v2:emb/0007');
    expect(stat.rawKeys).toEqual(['v1:loop/guard/r2/m', 'v2:emb/0007']);
    expect(stat.elitesAboveBar).toBe(2);
  });
});
