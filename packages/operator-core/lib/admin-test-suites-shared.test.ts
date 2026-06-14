import { describe, it, expect } from 'vitest';
import { ADMIN_TEST_SUITES, ADMIN_TEST_SUITE_IDS } from './admin-test-suites-shared';

describe('ADMIN_TEST_SUITES registry', () => {
  it('derives ADMIN_TEST_SUITE_IDS as the suites in order', () => {
    expect(ADMIN_TEST_SUITE_IDS).toEqual(ADMIN_TEST_SUITES.map((s) => s.id));
  });

  it('has unique suite ids', () => {
    const ids = ADMIN_TEST_SUITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every suite is fully specified', () => {
    const runners = new Set(['tauri', 'host', 'mixed']);
    for (const s of ADMIN_TEST_SUITES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(runners.has(s.runner)).toBe(true);
      expect(s.estimatedSeconds).toBeGreaterThan(0);
      expect(typeof s.safeDefault).toBe('boolean');
      expect(Array.isArray(s.tags)).toBe(true);
      expect(s.tags.length).toBeGreaterThan(0);
    }
  });

  it('includes desktop-health as a safe default', () => {
    const dh = ADMIN_TEST_SUITES.find((s) => s.id === 'desktop-health');
    expect(dh).toBeDefined();
    expect(dh!.safeDefault).toBe(true);
  });

  it('has at least one safe-default suite (the "all-safe" selection is non-empty)', () => {
    expect(ADMIN_TEST_SUITES.some((s) => s.safeDefault)).toBe(true);
  });
});
