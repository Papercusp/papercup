/** NicheDescriptorV1 (federated-scout-gym F0-1/D-002) — key round-trip, version
 *  isolation, and classifier totality/determinism. */
import { describe, expect, it } from 'vitest';
import {
  classifyHeuristically,
  mapV1KeyForward,
  nicheKeyV1,
  parseNicheKeyV1,
  NICHE_SHAPES,
  NICHE_SURFACES,
  type NicheDescriptorV1,
} from './niche-descriptor';

describe('nicheKeyV1 / parseNicheKeyV1', () => {
  it('round-trips every valid descriptor', () => {
    for (const surface of NICHE_SURFACES) {
      for (const shape of NICHE_SHAPES) {
        const d: NicheDescriptorV1 = { v: 1, surface, shape, risk: 2, size: 'm' };
        expect(parseNicheKeyV1(nicheKeyV1(d))).toEqual(d);
      }
    }
  });

  it('rejects foreign/future keys (merge stays version-isolated)', () => {
    expect(parseNicheKeyV1('v2:emb/000123')).toBeNull();
    expect(parseNicheKeyV1('v1:not-a-surface/guard/r2/m')).toBeNull();
    expect(parseNicheKeyV1('garbage')).toBeNull();
  });

  it('mapV1KeyForward is identity until v2 exists', () => {
    const k = nicheKeyV1({ v: 1, surface: 'loop', shape: 'guard', risk: 1, size: 's' });
    expect(mapV1KeyForward(k)).toBe(k);
  });
});

describe('classifyHeuristically (deterministic total fallback)', () => {
  it('is total and deterministic', () => {
    const d1 = classifyHeuristically('completely unrelated text with no keywords at all');
    const d2 = classifyHeuristically('completely unrelated text with no keywords at all');
    expect(d1).toEqual(d2);
    expect(parseNicheKeyV1(nicheKeyV1(d1))).toEqual(d1);
  });

  it('classifies plausible real-idea texts sensibly', () => {
    const guard = classifyHeuristically(
      'chronic autoloop failure escalator: a watchdog sweep that detects red cycles and files an alert observation',
    );
    expect(guard.shape).toBe('guard');

    const substrate = classifyHeuristically(
      'federate gym elites over the peer-log substrate with admission and epoch crypto',
    );
    expect(substrate.surface).toBe('substrate');

    const lowRisk = classifyHeuristically('tune a config threshold flag for the prompt');
    expect(lowRisk.risk).toBe(1);
  });
});
