import { describe, it, expect } from 'vitest';
import { potHomeLabel } from './pot-label';

describe('potHomeLabel', () => {
  it('strips a trailing -hive home suffix for display', () => {
    expect(potHomeLabel('shared_hive_test-hive')).toBe('shared_hive_test');
    expect(potHomeLabel('web-hive')).toBe('web');
  });

  it('leaves a member slug (no -hive suffix) untouched', () => {
    expect(potHomeLabel('shared_hive_test')).toBe('shared_hive_test');
    expect(potHomeLabel('web')).toBe('web');
  });

  it('only strips a TRAILING -hive (not an internal occurrence)', () => {
    expect(potHomeLabel('hive-tools')).toBe('hive-tools');
    expect(potHomeLabel('my-hive-project')).toBe('my-hive-project');
  });

  it('handles null/undefined/empty as empty string', () => {
    expect(potHomeLabel(null)).toBe('');
    expect(potHomeLabel(undefined)).toBe('');
    expect(potHomeLabel('')).toBe('');
  });
});
