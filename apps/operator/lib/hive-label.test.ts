import { describe, it, expect } from 'vitest';
import { hiveHomeLabel } from './hive-label';

describe('hiveHomeLabel', () => {
  it('strips a trailing -hive home suffix for display', () => {
    expect(hiveHomeLabel('shared_hive_test-hive')).toBe('shared_hive_test');
    expect(hiveHomeLabel('web-hive')).toBe('web');
  });

  it('leaves a member slug (no -hive suffix) untouched', () => {
    expect(hiveHomeLabel('shared_hive_test')).toBe('shared_hive_test');
    expect(hiveHomeLabel('web')).toBe('web');
  });

  it('only strips a TRAILING -hive (not an internal occurrence)', () => {
    expect(hiveHomeLabel('hive-tools')).toBe('hive-tools');
    expect(hiveHomeLabel('my-hive-project')).toBe('my-hive-project');
  });

  it('handles null/undefined/empty as empty string', () => {
    expect(hiveHomeLabel(null)).toBe('');
    expect(hiveHomeLabel(undefined)).toBe('');
    expect(hiveHomeLabel('')).toBe('');
  });
});
