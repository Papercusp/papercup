import { describe, it, expect } from 'vitest';
import { knownQueryNamesV2 } from './index';

/**
 * The Learning tab's improvements feed reads the `learning.improvements` named
 * query (operator-learning-tab-2026-06-09 P-002). The resolver itself is thin glue
 * over the separately-tested readImprovementItems + buildDigest path (D-003), so
 * here we just assert it's registered in the v2 resolver — a missing registration
 * is the failure mode that would silently 404 the tab.
 */
describe('learning.improvements resolver registration', () => {
  it('is registered in the v2 named-query resolver', () => {
    expect(knownQueryNamesV2()).toContain('learning.improvements');
  });
});
