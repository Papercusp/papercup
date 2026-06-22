/**
 * gym-bridge — unit coverage for the PURE QD (quality-diversity) math of the
 * gym↔scout archive bridge: the behaviour-descriptor metric + novelty distance
 * that decide which Scout ideas open a new "distant niche". (The archive/store
 * ports are IO-bound and tested elsewhere; these functions are pure.)
 */
import { describe, it, expect } from 'vitest';
import {
  SCOPE_ORDER,
  RISK_ORDER,
  nicheKey,
  scopeOrdinal,
  riskOrdinal,
  behaviorDistance,
  noveltyDistance,
  describeScoutIdea,
  type BehaviorDescriptor,
  type NicheCoords,
} from './gym-bridge';

const desc = (features: number[], domain = 'sync', scope = 'module', risk = 'medium'): BehaviorDescriptor =>
  ({ coords: { scope, domain, risk }, features }) as BehaviorDescriptor;

describe('nicheKey / ordinals', () => {
  it('nicheKey is scope|domain|risk with the domain trimmed + lowercased', () => {
    expect(nicheKey({ scope: 'module', domain: '  Sync  ', risk: 'high' } as NicheCoords)).toBe('module|sync|high');
  });

  it('scopeOrdinal / riskOrdinal index the band order; an unknown band → 0', () => {
    expect(SCOPE_ORDER.map(scopeOrdinal)).toEqual([0, 1, 2, 3]);
    expect(RISK_ORDER.map(riskOrdinal)).toEqual([0, 1, 2]);
    expect(scopeOrdinal('bogus' as never)).toBe(0);
    expect(riskOrdinal('bogus' as never)).toBe(0);
  });
});

describe('behaviorDistance', () => {
  it('is 0 for the same point', () => {
    expect(behaviorDistance(desc([0.2, 0.4]), desc([0.2, 0.4]))).toBe(0);
  });

  it('is Euclidean over the continuous features (same domain → no penalty)', () => {
    expect(behaviorDistance(desc([0, 0]), desc([3, 4]))).toBe(5); // 3-4-5
  });

  it('zero-pads the shorter feature vector', () => {
    expect(behaviorDistance(desc([1]), desc([1, 2]))).toBe(2); // d=[0,-2] → sqrt(4)
  });

  it('adds a domainWeight² categorical penalty when domains differ (case/space-insensitive)', () => {
    expect(behaviorDistance(desc([0, 0], 'a'), desc([0, 0], 'b'))).toBe(1); // default weight 1 → sqrt(1)
    expect(behaviorDistance(desc([0, 0], 'a'), desc([0, 0], 'b'), 2)).toBe(2); // weight 2 → sqrt(4)
    expect(behaviorDistance(desc([0, 0], 'Sync'), desc([0, 0], ' sync '))).toBe(0); // same domain normalized
  });
});

describe('noveltyDistance', () => {
  const at = (f0: number) => ({ descriptor: desc([f0, 0]) });

  it('an empty archive is maximally novel (Infinity)', () => {
    expect(noveltyDistance(desc([0, 0]), [])).toBe(Infinity);
  });

  it('is the mean distance to the k nearest elites', () => {
    const elites = [at(1), at(2), at(10)]; // distances from [0,0]: 1, 2, 10
    expect(noveltyDistance(desc([0, 0]), elites, 2)).toBe(1.5);
    expect(noveltyDistance(desc([0, 0]), elites, 3)).toBeCloseTo((1 + 2 + 10) / 3, 10);
  });

  it('uses all elites when k exceeds the archive size', () => {
    expect(noveltyDistance(desc([0, 0]), [at(4)], 3)).toBe(4);
  });
});

describe('describeScoutIdea', () => {
  it('maps a fully-tagged idea to coords + the [novelty, feasibility, scopeOrd/3, riskOrd/2] features', () => {
    const d = describeScoutIdea({ id: 'i', scope: 'cross-cutting', domain: '  Coord ', risk: 'high', novelty: 0.8, feasibility: 0.4 });
    expect(d.coords).toEqual({ scope: 'cross-cutting', domain: 'coord', risk: 'high' });
    expect(d.features).toEqual([0.8, 0.4, 2 / 3, 2 / 2]); // scopeOrd('cross-cutting')=2, riskOrd('high')=2
  });

  it('applies conservative fallbacks (module / general / medium; novelty .5 / feasibility .5)', () => {
    const d = describeScoutIdea({ id: 'i' });
    expect(d.coords).toEqual({ scope: 'module', domain: 'general', risk: 'medium' });
    expect(d.features).toEqual([0.5, 0.5, 1 / 3, 1 / 2]);
  });

  it('a moonshot with no scores → high risk + 0.9 novelty', () => {
    const d = describeScoutIdea({ id: 'i', moonshot: true });
    expect(d.coords.risk).toBe('high');
    expect(d.features[0]).toBe(0.9);
  });

  it('clamps novelty + feasibility into [0,1]', () => {
    const d = describeScoutIdea({ id: 'i', novelty: 1.5, feasibility: -0.3 });
    expect(d.features[0]).toBe(1);
    expect(d.features[1]).toBe(0);
  });
});
