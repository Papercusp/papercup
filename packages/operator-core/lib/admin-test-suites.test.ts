/**
 * Coverage for admin-test-suites' pure registry helpers: listAdminTestSuites,
 * expandAdminTestSuiteSelection ('all-safe' → the safeDefault subset, else the
 * single id), and the isAdminTestSuiteId guard.
 */
import { describe, expect, it } from 'vitest';
import {
  listAdminTestSuites,
  expandAdminTestSuiteSelection,
  isAdminTestSuiteId,
} from './admin-test-suites';

const suites = listAdminTestSuites();

describe('listAdminTestSuites', () => {
  it('returns a non-empty registry, each with an id + safeDefault flag', () => {
    expect(suites.length).toBeGreaterThan(0);
    for (const s of suites) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.safeDefault).toBe('boolean');
    }
  });
});

describe('expandAdminTestSuiteSelection', () => {
  it("'all-safe' expands to exactly the safeDefault suites", () => {
    const expanded = expandAdminTestSuiteSelection('all-safe');
    const expectedSafe = suites.filter((s) => s.safeDefault).map((s) => s.id).sort();
    expect([...expanded].sort()).toEqual(expectedSafe);
  });

  it('a specific id expands to just that id', () => {
    const id = suites[0].id;
    expect(expandAdminTestSuiteSelection(id)).toEqual([id]);
  });
});

describe('isAdminTestSuiteId', () => {
  it('accepts a registered id, rejects anything else', () => {
    expect(isAdminTestSuiteId(suites[0].id)).toBe(true);
    expect(isAdminTestSuiteId('definitely-not-a-suite')).toBe(false);
  });
});
