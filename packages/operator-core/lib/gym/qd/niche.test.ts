/**
 * Unit tests for the gym-QD niche/behavior math (P-010). Pure — no PG, no LLM.
 */
import { describe, it, expect } from 'vitest';
import {
  nicheKey,
  describeBehavior,
  coordsToFeatures,
  featureDistance,
  noveltyFromMembers,
  SCOPE_BANDS,
  RISK_BANDS,
  DOMAIN_VOCAB,
  GYM_NICHE_CELL_COUNT,
} from './niche';

const ov = (po: Record<string, string>) => ({ promptOverrides: po });

describe('nicheKey', () => {
  it('is canonical scope|domain|risk and lowercases the domain', () => {
    expect(nicheKey({ scope: 'local', domain: 'Quality', risk: 'low' })).toBe('local|quality|low');
    expect(nicheKey({ scope: 'architectural', domain: 'execution', risk: 'high' })).toBe('architectural|execution|high');
  });
});

describe('GYM_NICHE_CELL_COUNT', () => {
  it('is scope × domain × risk', () => {
    expect(GYM_NICHE_CELL_COUNT).toBe(SCOPE_BANDS.length * DOMAIN_VOCAB.length * RISK_BANDS.length);
    expect(GYM_NICHE_CELL_COUNT).toBe(60);
  });
});

describe('describeBehavior — scope band (# roles changed)', () => {
  it('baseline (empty overlay, no parent) → the degenerate local/mixed/low cell', () => {
    const d = describeBehavior({ overlay: ov({}) });
    expect(d.coords).toEqual({ scope: 'local', domain: 'mixed', risk: 'low' });
  });

  it('one role → local', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'x'.repeat(50) }) }).coords.scope).toBe('local');
  });

  it('two roles → module', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'a', scoper: 'b' }) }).coords.scope).toBe('module');
  });

  it('three or four roles → cross-cutting', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'a', scoper: 'b', validator: 'c' }) }).coords.scope).toBe('cross-cutting');
    expect(describeBehavior({ overlay: ov({ worker: 'a', scoper: 'b', validator: 'c', documenter: 'd' }) }).coords.scope).toBe('cross-cutting');
  });

  it('five+ roles → architectural', () => {
    expect(
      describeBehavior({ overlay: ov({ worker: 'a', scoper: 'b', architect: 'c', validator: 'd', reviewer: 'e' }) }).coords.scope,
    ).toBe('architectural');
  });

  it('inherited unchanged roles are NOT counted toward scope', () => {
    // worker is identical to parent → only scoper is a real change → local, not module.
    const d = describeBehavior({ overlay: ov({ worker: 'same', scoper: 'new' }), parentOverlay: ov({ worker: 'same' }) });
    expect(d.coords.scope).toBe('local');
    expect(d.coords.domain).toBe('planning'); // scoper → planning
  });
});

describe('describeBehavior — domain (role-category)', () => {
  it('a single-category change reports that domain', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'a' }) }).coords.domain).toBe('execution');
    expect(describeBehavior({ overlay: ov({ scoper: 'a' }) }).coords.domain).toBe('planning');
    expect(describeBehavior({ overlay: ov({ validator: 'a' }) }).coords.domain).toBe('quality');
    expect(describeBehavior({ overlay: ov({ documenter: 'a' }) }).coords.domain).toBe('knowledge');
  });

  it('two same-domain roles stay in that domain', () => {
    expect(describeBehavior({ overlay: ov({ validator: 'a', reviewer: 'b' }) }).coords.domain).toBe('quality');
  });

  it('cross-domain changes → mixed', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'a', scoper: 'b' }) }).coords.domain).toBe('mixed');
  });

  it('an unknown role falls back to execution', () => {
    expect(describeBehavior({ overlay: ov({ 'some-future-role': 'a' }) }).coords.domain).toBe('execution');
  });
});

describe('describeBehavior — risk band (change magnitude)', () => {
  it('small change → low', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'x'.repeat(100) }) }).coords.risk).toBe('low');
  });

  it('mid-size change → medium', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'x'.repeat(800) }) }).coords.risk).toBe('medium');
  });

  it('large change → high', () => {
    expect(describeBehavior({ overlay: ov({ worker: 'x'.repeat(2000) }) }).coords.risk).toBe('high');
  });

  it('a same-length total rewrite counts as the full rewrite size (not zero risk)', () => {
    const parent = ov({ worker: 'a'.repeat(2000) });
    const d = describeBehavior({ overlay: ov({ worker: 'b'.repeat(2000) }), parentOverlay: parent });
    // length delta is 0 but the content changed → magnitude = full size → high.
    expect(d.coords.risk).toBe('high');
  });

  it('a modification uses the length delta', () => {
    const parent = ov({ worker: 'a'.repeat(100) });
    const d = describeBehavior({ overlay: ov({ worker: 'a'.repeat(100) + 'x'.repeat(500) }), parentOverlay: parent });
    expect(d.coords.risk).toBe('medium'); // delta 500 ∈ [400, 1500)
  });
});

describe('coordsToFeatures', () => {
  it('is [scopeNorm, riskNorm, ...oneHot(domain)] with each component in [0,1]', () => {
    const f = coordsToFeatures({ scope: 'local', domain: 'execution', risk: 'low' });
    expect(f).toHaveLength(2 + DOMAIN_VOCAB.length);
    expect(f[0]).toBe(0); // local = scope index 0 → 0
    expect(f[1]).toBe(0); // low = risk index 0 → 0
    // one-hot for 'execution' (DOMAIN_VOCAB index 1)
    expect(f.slice(2)).toEqual([0, 1, 0, 0, 0]);
  });

  it('maps the top bands to 1', () => {
    const f = coordsToFeatures({ scope: 'architectural', domain: 'mixed', risk: 'high' });
    expect(f[0]).toBe(1);
    expect(f[1]).toBe(1);
    expect(f.slice(2)).toEqual([0, 0, 0, 0, 1]); // mixed is the last domain
  });

  it('an out-of-vocab domain → all-zero one-hot', () => {
    const f = coordsToFeatures({ scope: 'local', domain: 'not-a-domain', risk: 'low' });
    expect(f.slice(2)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('featureDistance', () => {
  it('is 0 for identical vectors and symmetric', () => {
    const a = coordsToFeatures({ scope: 'local', domain: 'execution', risk: 'low' });
    const b = coordsToFeatures({ scope: 'architectural', domain: 'knowledge', risk: 'high' });
    expect(featureDistance(a, a)).toBe(0);
    expect(featureDistance(a, b)).toBeCloseTo(featureDistance(b, a), 12);
  });

  it('is in [0,1] and larger for more-distant cells', () => {
    const local = coordsToFeatures({ scope: 'local', domain: 'execution', risk: 'low' });
    const near = coordsToFeatures({ scope: 'module', domain: 'execution', risk: 'low' });
    const far = coordsToFeatures({ scope: 'architectural', domain: 'knowledge', risk: 'high' });
    const dNear = featureDistance(local, near);
    const dFar = featureDistance(local, far);
    expect(dNear).toBeGreaterThan(0);
    expect(dFar).toBeGreaterThan(dNear);
    expect(dFar).toBeLessThanOrEqual(1);
  });
});

describe('noveltyFromMembers', () => {
  const A = coordsToFeatures({ scope: 'local', domain: 'execution', risk: 'low' });
  const B = coordsToFeatures({ scope: 'architectural', domain: 'knowledge', risk: 'high' });

  it('an empty archive is maximally novel (1)', () => {
    expect(noveltyFromMembers(A, [])).toBe(1);
  });

  it('excludeSelf (default) drops the exact self-match → only-self archive is still novel', () => {
    expect(noveltyFromMembers(A, [A])).toBe(1);
  });

  it('mean distance to the k nearest OTHER members', () => {
    const score = noveltyFromMembers(A, [A, B], 3);
    expect(score).toBeCloseTo(featureDistance(A, B), 12); // B is the only "other"
  });

  it('excludeSelf:false counts a candidate landing on a covered cell as novelty 0', () => {
    expect(noveltyFromMembers(A, [A, B], 1, { excludeSelf: false })).toBe(0);
  });
});
