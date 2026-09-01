import { describe, expect, it } from 'vitest';
import { resolvePlanRunItemKind } from './plan-run-action';

describe('resolvePlanRunItemKind', () => {
  it('keeps feature and maps stale/unknown executor kinds to feature', () => {
    expect(resolvePlanRunItemKind('feature')).toBe('feature');
    expect(resolvePlanRunItemKind('chunk')).toBe('feature');
    expect(resolvePlanRunItemKind('research-task')).toBe('feature');
    expect(resolvePlanRunItemKind(undefined)).toBe('feature');
  });
});
