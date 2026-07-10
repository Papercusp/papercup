/**
 * Unit tests for getRoleStyle. Locks in the contract:
 *   - Canonical roles return their override color.
 *   - Non-canonical roles get a stable hash-derived HSL.
 *   - Fallback ('unknown' grey) for empty/null/undefined.
 *   - Title-cased label, with dash/underscore handling.
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORICAL,
  CUPBOARD_LISTING_KIND_TONE,
  FEED_KIND_COLOR,
  FEED_KIND_FALLBACK,
  getRoleStyle,
  ROLE,
} from './theme';

describe('central categorical palette', () => {
  it('keeps every fixed swatch hex and rgb representations paired', () => {
    for (const swatch of Object.values(CATEGORICAL)) {
      expect(swatch.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(swatch.rgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
    }
    expect(CATEGORICAL.pink500).toEqual({ hex: '#ec4899', rgb: '236, 72, 153' });
  });

  it('owns the complete feed-kind and Cupboard listing-kind lookups', () => {
    expect(FEED_KIND_COLOR.handoff).toBe(CATEGORICAL.violet400.hex);
    expect(FEED_KIND_COLOR.handoff_accepted).toBe(CATEGORICAL.violet300.hex);
    expect(FEED_KIND_FALLBACK).toBe(CATEGORICAL.slate500.hex);
    expect(Object.keys(CUPBOARD_LISTING_KIND_TONE).sort()).toEqual([
      'blueprint', 'harness', 'learning-pack', 'plugin', 'tool-pack',
    ]);
  });
});

describe('getRoleStyle', () => {
  it('returns canonical color for known roles', () => {
    expect(getRoleStyle('worker').solid).toBe(ROLE.worker.solid);
    expect(getRoleStyle('orchestrator').solid).toBe(ROLE.orchestrator.solid);
    expect(getRoleStyle('validator').solid).toBe(ROLE.validator.solid);
    expect(getRoleStyle('planner').solid).toBe(ROLE.planner.solid);
    expect(getRoleStyle('escalator').solid).toBe(ROLE.escalator.solid);
  });

  it('case-insensitive on canonical roles', () => {
    expect(getRoleStyle('WORKER').solid).toBe(ROLE.worker.solid);
    expect(getRoleStyle('Validator').solid).toBe(ROLE.validator.solid);
  });

  it('returns unknown grey for empty/null/undefined', () => {
    expect(getRoleStyle('').solid).toBe(ROLE.unknown.solid);
    expect(getRoleStyle(null).solid).toBe(ROLE.unknown.solid);
    expect(getRoleStyle(undefined).solid).toBe(ROLE.unknown.solid);
  });

  it('returns hash-derived HSL for unknown roles', () => {
    const result = getRoleStyle('reviewer');
    expect(result.solid).toMatch(/^hsl\(\d+ 65% 55%\)$/);
    expect(result.label).toBe('Reviewer');
  });

  it('different unknown roles get different colors', () => {
    const a = getRoleStyle('reviewer');
    const b = getRoleStyle('scoper');
    const c = getRoleStyle('curator');
    expect(a.solid).not.toBe(b.solid);
    expect(b.solid).not.toBe(c.solid);
    expect(a.solid).not.toBe(c.solid);
  });

  it('same unknown role always gets the same color (stability across calls)', () => {
    const a = getRoleStyle('reviewer');
    const b = getRoleStyle('reviewer');
    expect(a.solid).toBe(b.solid);
  });

  it('title-cases multi-word role names', () => {
    expect(getRoleStyle('infra-reviewer').label).toBe('Infra Reviewer');
    expect(getRoleStyle('security-reviewer').label).toBe('Security Reviewer');
    expect(getRoleStyle('project_manager').label).toBe('Project Manager');
    expect(getRoleStyle('ui-qa').label).toBe('Ui Qa');
  });

  it('non-canonical roles do not collide with canonical role colors', () => {
    // Verify hash-derived HSL never accidentally produces a hex string
    // identical to a canonical override (would cause visual ambiguity).
    const canonical = new Set<string>(Object.values(ROLE).map((r) => r.solid));
    for (const role of ['reviewer', 'scoper', 'architect', 'curator', 'debugger']) {
      const { solid } = getRoleStyle(role);
      expect(canonical.has(solid)).toBe(false);
      expect(solid).toMatch(/^hsl\(/);
    }
  });
});
