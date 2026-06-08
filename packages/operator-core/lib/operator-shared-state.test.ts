/**
 * Tests for the pure auto-accept policy predicates used by both the panel and
 * the background scanner. Run with:
 *   cd packages/operator-core && npx vitest run lib/operator-shared-state.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isAutoAcceptLevel, isAutoAcceptedByThreshold } from './operator-shared-state';

describe('isAutoAcceptLevel', () => {
  it('accepts the four valid levels', () => {
    for (const v of ['off', 'low', 'medium', 'high']) {
      expect(isAutoAcceptLevel(v)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const v of ['', 'HIGH', 'none', 1, null, undefined, {}, ['low']]) {
      expect(isAutoAcceptLevel(v)).toBe(false);
    }
  });
});

describe('isAutoAcceptedByThreshold', () => {
  const tiers = ['low', 'medium', 'high'] as const;

  it('threshold "off" never auto-accepts', () => {
    for (const t of tiers) expect(isAutoAcceptedByThreshold(t, 'off')).toBe(false);
  });

  it('threshold "high" always auto-accepts', () => {
    for (const t of tiers) expect(isAutoAcceptedByThreshold(t, 'high')).toBe(true);
  });

  it('threshold "medium" accepts everything except high-tier', () => {
    expect(isAutoAcceptedByThreshold('low', 'medium')).toBe(true);
    expect(isAutoAcceptedByThreshold('medium', 'medium')).toBe(true);
    expect(isAutoAcceptedByThreshold('high', 'medium')).toBe(false);
  });

  it('threshold "low" accepts only low-tier', () => {
    expect(isAutoAcceptedByThreshold('low', 'low')).toBe(true);
    expect(isAutoAcceptedByThreshold('medium', 'low')).toBe(false);
    expect(isAutoAcceptedByThreshold('high', 'low')).toBe(false);
  });
});
