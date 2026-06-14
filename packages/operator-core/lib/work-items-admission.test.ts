import { describe, it, expect } from 'vitest';
import { isAutoPickable } from './work-items-admission';

/**
 * P-001 of shared-hive-trust-admission-2026-06-14. The G2 admission predicate is the
 * single source of truth for every claim/place path; this pins its truth table.
 */
describe('isAutoPickable — G2 admission predicate', () => {
  it('local origin is always pickable (verdict irrelevant)', () => {
    expect(isAutoPickable('local', null)).toBe(true);
    expect(isAutoPickable('local', undefined)).toBe(true);
    expect(isAutoPickable('local', 'reject')).toBe(true);
  });

  it('NULL/undefined origin is pickable (pre-G1 back-compat = local)', () => {
    expect(isAutoPickable(null, null)).toBe(true);
    expect(isAutoPickable(undefined, undefined)).toBe(true);
  });

  it('remote + un-admitted is NOT pickable (quarantined, fail-safe)', () => {
    expect(isAutoPickable('remote', null)).toBe(false);
    expect(isAutoPickable('remote', undefined)).toBe(false);
    expect(isAutoPickable('remote', 'pending')).toBe(false);
    expect(isAutoPickable('remote', 'reject')).toBe(false);
  });

  it('remote becomes pickable only once the auditor admits it', () => {
    expect(isAutoPickable('remote', 'admit')).toBe(true);
  });
});
