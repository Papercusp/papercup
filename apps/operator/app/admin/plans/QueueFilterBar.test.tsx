// @vitest-environment jsdom
/**
 * QueueFilterBar.test.tsx — the Queue's collapsed Filter (props-pure presentational
 * component). Pins the genuine logic, not the markup: the active-count badge derivation
 * (kinds + todos + blocked + a non-'all' tier), the per-kind active state (aria-pressed +
 * count), the toggle callbacks fire with the right id, and the tier clear-chip is shown
 * ONLY when a tier deep-link is set. A regression in the activeCount math (the badge that
 * tells the user how filtered the Queue is) or a mis-wired toggle is what this catches.
 *
 * In-tree (apps/operator, jsdom + RTL, NOT fail-on-console → reliable). The Tooltip
 * wrapper + TIER_LABEL are stubbed so the test is pure-render.
 * Run: cd apps/operator && npx vitest run app/admin/plans/QueueFilterBar.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(() => cleanup()); // no auto-cleanup configured → unmount between renders

vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./plans-api', () => ({ TIER_LABEL: { all: 'All', now: 'Now', next: 'Next', blocker: 'Blocker' } }));

import QueueFilterBar, { type QueueFilterBarProps } from './QueueFilterBar';

function setup(overrides: Partial<QueueFilterBarProps> = {}) {
  const props: QueueFilterBarProps = {
    kinds: [], onToggleKind: vi.fn(), counts: {},
    showTodos: false, showBlocked: false, onToggleTodos: vi.fn(), onToggleBlocked: vi.fn(),
    todoCount: 0, blockedCount: 0, open: true, onOpenChange: vi.fn(),
    ...overrides,
  };
  render(<QueueFilterBar {...props} />);
  return props;
}

describe('QueueFilterBar', () => {
  it('shows no active badge when nothing is filtered', () => {
    setup();
    expect(screen.getByRole('button', { name: /^Filter/ }).textContent).toBe('Filter');
  });

  it('derives the active-count badge from kinds + todos + blocked + a non-all tier', () => {
    setup({ kinds: ['coord-message'], showTodos: true, showBlocked: false, tierFilter: 'blocker', onClearTier: vi.fn() });
    // 1 kind + 1 todos + 0 blocked + 1 tier = 3
    expect(screen.getByRole('button', { name: /^Filter/ }).textContent).toContain('3');
  });

  it('marks a selected kind active (aria-pressed) and shows its count', () => {
    setup({ kinds: ['smoke-fail'], counts: { 'smoke-fail': 3, 'coord-message': 0 } });
    expect(screen.getByRole('button', { name: 'Smoke, 3' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Messages, 0' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('fires onToggleKind with the kind id when a chip is clicked', () => {
    const { onToggleKind } = setup({ counts: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Messages, 0' }));
    expect(onToggleKind).toHaveBeenCalledWith('coord-message');
  });

  it('shows the tier clear-chip only when a tier is set, and clears on click', () => {
    const onClearTier = vi.fn();
    setup({ tierFilter: 'blocker', onClearTier });
    const chip = screen.getByRole('button', { name: /Blocker/ });
    fireEvent.click(chip);
    expect(onClearTier).toHaveBeenCalledTimes(1);
  });

  it('does not show a tier chip when the tier is all', () => {
    setup({ tierFilter: 'all', onClearTier: vi.fn() });
    expect(screen.queryByText(/Blocker/)).toBeNull();
  });

  it('wires the backlog toggles (pressed state + callbacks)', () => {
    const { onToggleBlocked } = setup({ showTodos: true, todoCount: 5, blockedCount: 2 });
    expect(screen.getByRole('button', { name: 'Pickable todos, 5' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Blocked, 2' }));
    expect(onToggleBlocked).toHaveBeenCalledTimes(1);
  });
});
