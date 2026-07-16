import { describe, expect, it } from 'vitest';
import { planEventProgressTitle } from './plan-event-title';

describe('planEventProgressTitle (WI-5040)', () => {
  it('composes slug + item + status transition when summary is absent (the 100% real case)', () => {
    expect(
      planEventProgressTitle({
        plan_slug: 'papercup-chat-release-grade-loop-2026-07-16',
        detail: 'P-003',
        before: 'todo',
        after: 'wip',
      }),
    ).toBe('papercup-chat-release-grade-loop-2026-07-16 P-003: todo → wip');
  });

  it('omits the transition arrow when before === after or before is missing', () => {
    expect(planEventProgressTitle({ plan_slug: 'my-plan', detail: 'P-001', after: 'done' })).toBe(
      'my-plan P-001: done',
    );
    expect(
      planEventProgressTitle({ plan_slug: 'my-plan', detail: 'P-001', before: 'done', after: 'done' }),
    ).toBe('my-plan P-001: done');
  });

  it('degrades gracefully with partial fields', () => {
    expect(planEventProgressTitle({ plan_slug: 'my-plan' })).toBe('my-plan updated');
    expect(planEventProgressTitle({ detail: 'P-002', after: 'blocked' })).toBe('plan P-002: blocked');
  });

  it('prefers an explicit non-empty summary verbatim', () => {
    expect(
      planEventProgressTitle({ summary: 'custom line', plan_slug: 'x', detail: 'P-9', after: 'done' }),
    ).toBe('custom line');
  });

  it('falls back to the legacy literal only when NOTHING is available', () => {
    expect(planEventProgressTitle({})).toBe('plan update');
    expect(planEventProgressTitle({ summary: '  ' })).toBe('plan update');
  });
});
