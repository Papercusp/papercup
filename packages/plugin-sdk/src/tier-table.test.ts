import { describe, expect, it } from 'vitest';
import { lookupTier } from './tier-table';

describe('lookupTier', () => {
  it('resolves an exact substrate cap', () => {
    expect(lookupTier('messages:write')).toBe('medium');
    expect(lookupTier('tasks:read')).toBe('low');
  });

  it('resolves wildcard prefixes', () => {
    expect(lookupTier('secrets:read:OPENAI_KEY')).toBe('high');
    expect(lookupTier('harness:dispatch:foo')).toBe('high');
    expect(lookupTier('data:read:goals:goal-12')).toBe('medium');
  });

  it('returns null for unknown caps (caller forces high)', () => {
    expect(lookupTier('plugin:custom:thing')).toBeNull();
    expect(lookupTier('made:up:cap')).toBeNull();
  });
});
