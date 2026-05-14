import { describe, expect, it } from 'vitest';

import type { OpenCardWithRun } from '@/lib/use-state-snapshots';

import { selectFocusedCard } from './select-focused-card';

function card(overrides: Partial<OpenCardWithRun> = {}): OpenCardWithRun {
  return {
    runId: 'r-1',
    correlationId: 'c-1',
    prompt: 'Pick',
    dataSchemaJson: {},
    createdAt: 0,
    ...overrides,
  };
}

describe('selectFocusedCard', () => {
  it('empty list → null', () => {
    expect(selectFocusedCard([])).toBeNull();
  });

  it('single entry → that entry', () => {
    const c = card();
    expect(selectFocusedCard([c])).toBe(c);
  });

  it('multiple entries → returns the first (createdAt-ascending order)', () => {
    const a = card({ correlationId: 'a', createdAt: 1 });
    const b = card({ correlationId: 'b', createdAt: 2 });
    const c = card({ correlationId: 'c', createdAt: 3 });
    expect(selectFocusedCard([a, b, c])?.correlationId).toBe('a');
  });

  it('does not mutate input', () => {
    const arr = [card({ correlationId: 'x' }), card({ correlationId: 'y' })];
    const before = [...arr];
    selectFocusedCard(arr);
    expect(arr).toEqual(before);
  });
});
