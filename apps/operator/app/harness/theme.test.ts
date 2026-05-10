/**
 * Unit tests for getRoleStyle. Locks in the contract:
 *   - Canonical roles return their override color.
 *   - Non-canonical roles get a stable hash-derived HSL.
 *   - Fallback ('unknown' grey) for empty/null/undefined.
 *   - Title-cased label, with dash/underscore handling.
 */
import { describe, it, expect } from 'vitest';
import { getRoleStyle, ROLE } from './theme';

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
    const c = getRoleStyle('expert');
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
    const canonical = new Set(Object.values(ROLE).map((r) => r.solid));
    for (const role of ['reviewer', 'scoper', 'architect', 'expert', 'feedback', 'curator', 'debugger']) {
      const { solid } = getRoleStyle(role);
      expect(canonical.has(solid)).toBe(false);
      expect(solid).toMatch(/^hsl\(/);
    }
  });
});
