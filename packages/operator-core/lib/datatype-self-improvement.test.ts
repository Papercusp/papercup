/**
 * datatype-self-improvement.test — the P-010 declare-time policy (pure, no DB).
 * Locks: authoritative tiers REQUIRE a well-formed self-improvement surface; projection
 * is exempt but validated-when-present; a supplied surface must be complete (all three
 * legs); an in-place update preserves the stored surface when the call omits it.
 */
import { describe, it, expect } from 'vitest';
import {
  requiresSelfImprovement,
  checkSelfImprovementForDeclare,
  SelfImprovementSurfaceSchema,
  SELF_IMPROVEMENT_EXPECTED_SHAPE,
} from './datatype-self-improvement';

const VALID = {
  improvements: [{ id: 'tighten-thesis', description: 'sharpen the core claim to a single falsifiable line' }],
  scorecard: [{ metric: 'thesis-clarity', description: 'how unambiguous the claim is', weight: 0.5 }],
  gym: { signals: ['realized P&L vs forecast'], rubric: 'a win raises the scorecard without adding new risk' },
};

describe('requiresSelfImprovement — authoritative tiers only', () => {
  it('generic-kind and first-class require it; projection does not', () => {
    expect(requiresSelfImprovement('generic-kind')).toBe(true);
    expect(requiresSelfImprovement('first-class')).toBe(true);
    expect(requiresSelfImprovement('projection')).toBe(false);
  });
});

describe('checkSelfImprovementForDeclare — required-by-tier', () => {
  it('generic-kind with NO surface and no existing → self_improvement_required (with the expected shape)', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self_improvement_required');
    expect(r.expectedShape).toBe(SELF_IMPROVEMENT_EXPECTED_SHAPE);
    expect(r.message).toMatch(/self-improvable by construction/);
  });

  it('first-class with NO surface → self_improvement_required', () => {
    const r = checkSelfImprovementForDeclare('first-class', undefined);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self_improvement_required');
  });

  it('projection with NO surface → ok, value null (exempt)', () => {
    const r = checkSelfImprovementForDeclare('projection', null);
    expect(r).toEqual({ ok: true, value: null });
  });
});

describe('checkSelfImprovementForDeclare — a supplied surface is validated on ANY tier', () => {
  it('accepts a complete surface and returns the parsed value', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).toEqual(VALID);
  });

  it('validates a surface supplied on a projection too (optional but not unchecked)', () => {
    const bad = checkSelfImprovementForDeclare('projection', { improvements: [], scorecard: [], gym: {} });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.reason).toBe('self_improvement_invalid');
  });

  it('rejects a PARTIAL surface — a scorecard with no gym is not "self-improvable"', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', {
      improvements: VALID.improvements,
      scorecard: VALID.scorecard,
      // gym omitted
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self_improvement_invalid');
    expect(r.issues?.some((i) => i.startsWith('gym'))).toBe(true);
  });

  it('rejects an empty improvements taxonomy', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', { ...VALID, improvements: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self_improvement_invalid');
  });

  it('rejects a gym with no signals', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', {
      ...VALID,
      gym: { signals: [], rubric: 'x' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.issues?.some((i) => i.startsWith('gym.signals'))).toBe(true);
  });

  it('rejects a scorecard weight outside 0..1', () => {
    const r = checkSelfImprovementForDeclare('generic-kind', {
      ...VALID,
      scorecard: [{ metric: 'm', description: 'd', weight: 1.5 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self_improvement_invalid');
  });
});

describe('checkSelfImprovementForDeclare — in-place update preserves the stored surface', () => {
  it('a required tier omitting the surface PRESERVES the existing one (no forced re-send)', () => {
    const existing = { ...VALID } as Record<string, unknown>;
    const r = checkSelfImprovementForDeclare('generic-kind', null, existing);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).toBe(existing); // preserved as-is
  });

  it('a freshly-supplied surface OVERRIDES the stored one', () => {
    const existing = { ...VALID } as Record<string, unknown>;
    const next = {
      ...VALID,
      improvements: [{ id: 'widen-evidence', description: 'add an independent corroborating source' }],
    };
    const r = checkSelfImprovementForDeclare('generic-kind', next, existing);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).toEqual(next);
  });
});

describe('SelfImprovementSurfaceSchema — the persisted shape', () => {
  it('strips unknown keys and keeps the three legs', () => {
    const parsed = SelfImprovementSurfaceSchema.parse({ ...VALID, bogus: 'nope' });
    expect(Object.keys(parsed).sort()).toEqual(['gym', 'improvements', 'scorecard']);
  });
});
