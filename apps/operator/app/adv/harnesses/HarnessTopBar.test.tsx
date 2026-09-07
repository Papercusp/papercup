// @vitest-environment jsdom
//
// HarnessTopBar — the /adv/harnesses actions bar. It is DOCK-level only: add
// panel + reset layout. The heavy child (AddPanelCatalog) is stubbed; it isn't
// the thing under test.
//
// WHAT THIS SUITE DELIBERATELY NO LONGER COVERS (EI-18814950644299297): the
// "Workspaces (N)" and "Register sub-pots" buttons moved OFF this bar to the pot
// bar (AdvPotBar) on 2026-07-27, per an owner ask — they were pot administration
// wearing dock chrome. This suite kept asserting they render here and kept
// driving RegisterSubsButton's POST/toast branching THROUGH this component, so
// seven of its eight tests went red on a move that broke nothing. Those six
// behavioral tests are not lost — they now live in RegisterSubsButton.test.tsx,
// rendering that component directly. What is left here is exactly what this bar
// still owns, which is the whole point: a top-bar suite should fail when the top
// bar changes, not when something that used to sit on it moves house.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../harness/dock/AddPanelCatalog', () => ({ AddPanelCatalog: () => <span data-testid="add-panel" /> }));
const resetLayout = vi.fn();
vi.mock('../../harness/dock/dock-actions', () => ({ resetLayout: () => resetLayout() }));
vi.mock('../../../lib/flag-hooks', () => ({ useFlag: () => false }));
vi.mock('../../../lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    const label = key === 'workUnit' ? (opts?.plural ? 'Deliverables' : 'Deliverable') : key === 'pot' ? 'Pot' : key;
    return opts?.lower ? label.toLowerCase() : label;
  },
}));
vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => <span title={label}>{children}</span>,
}));

import HarnessTopBar from './HarnessTopBar';

afterEach(() => {
  cleanup();
  resetLayout.mockReset();
});

describe('<HarnessTopBar />', () => {
  it('renders the dock action row (add panel, reset layout) for a slug', () => {
    render(<HarnessTopBar slug="h" />);
    expect(screen.getByTestId('add-panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reset layout/i })).toBeTruthy();
    expect(screen.getByTitle(/default Deliverables \/ Detail split/)).toBeTruthy();
  });

  it('does NOT render the pot-level actions — they belong to the pot bar now', () => {
    // Pins the 2026-07-27 move so a well-meaning revert re-reds HERE, with a
    // reason, instead of silently restoring pot administration to the dock bar.
    render(<HarnessTopBar slug="h" />);
    expect(screen.queryByRole('button', { name: /register sub-/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /workspaces/i })).toBeNull();
  });

  it('reset-layout button invokes resetLayout()', () => {
    render(<HarnessTopBar slug="h" />);
    fireEvent.click(screen.getByRole('button', { name: /reset layout/i }));
    expect(resetLayout).toHaveBeenCalledTimes(1);
  });

  it('renders no dock actions without a slug', () => {
    render(<HarnessTopBar slug="" />);
    expect(screen.queryByTestId('add-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: /reset layout/i })).toBeNull();
  });
});
