import { describe, it, expect } from 'vitest';
import { knownQueryNamesV2 } from './index';

/**
 * The Learning tab's improvements feed reads the `learning.improvements` named
 * query (operator-learning-tab-2026-06-09 P-002). The resolver itself is thin glue
 * over the separately-tested readImprovementItems + buildDigest path (D-003), so
 * here we just assert it's registered in the v2 resolver — a missing registration
 * is the failure mode that would silently 404 the tab.
 */
describe('learning.* resolver registration', () => {
  it('registers learning.improvements + learning.gym + learning.apiary in the v2 named-query resolver', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.improvements');
    expect(names).toContain('learning.gym');
    expect(names).toContain('learning.apiary');
  });
});
