import { describe, expect, it } from 'vitest';
import { lifecycleBindingsForWorkItem } from './work-items';

describe('lifecycleBindingsForWorkItem (state-plane P-013)', () => {
  it('always retires the work-item binding and every linked plan lane', () => {
    expect(
      lifecycleBindingsForWorkItem({
        id: 'WI-40313',
        sourcePlanSlug: 'state-plane-interest-and-hardening-2026-08-21',
        sourcePlanItemIds: ['P-013', 'P-014'],
      }),
    ).toEqual([
      { kind: 'work-item', ref: 'WI-40313' },
      { kind: 'plan-lane', ref: 'state-plane-interest-and-hardening-2026-08-21#P-013' },
      { kind: 'plan-lane', ref: 'state-plane-interest-and-hardening-2026-08-21#P-014' },
    ]);
  });

  it('does not invent a plan-lane binding when the work item is not plan-linked', () => {
    expect(
      lifecycleBindingsForWorkItem({
        id: 'EI-1',
        sourcePlanSlug: null,
        sourcePlanItemIds: ['P-999'],
      }),
    ).toEqual([{ kind: 'work-item', ref: 'EI-1' }]);
  });
});
