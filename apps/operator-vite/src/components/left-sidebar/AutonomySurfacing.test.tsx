// @vitest-environment jsdom
/**
 * AutonomySurfacing.test — the 👑 Queen tab autonomy + decomposition surface
 * (queen-steering-panel-2026-06-15 P-009).
 *
 * Pins: the policy roll-up + defensive row filter; the armed-vs-not read-through;
 * the live breaker threshold display; and the advisory decomposition writes.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({
  policy: [] as unknown[],
  armed: false,
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.policy, loading: false, error: null }),
}));
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => H.armed }));

import AutonomySurfacing, { policyRows, summarizePolicy } from './AutonomySurfacing';

const Wrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter>;

type Props = Parameters<typeof AutonomySurfacing>[0];
function makeProps(over: Partial<Props> = {}): Props {
  return {
    decomposition: null,
    breakerThreshold: null,
    busy: false,
    onSetDecomposition: vi.fn(),
    onManageAutonomy: vi.fn(),
    ...over,
  };
}

const POLICY = [
  { category: 'code-edit', effectiveCeiling: 'low', locked: false, label: 'Code edits' },
  { category: 'deploy', effectiveCeiling: 'never-auto', locked: true, label: 'Deploy' },
  { category: 'research', effectiveCeiling: 'moderate', locked: false, label: 'Research' },
];

afterEach(() => {
  cleanup();
  H.policy = [];
  H.armed = false;
});

describe('AutonomySurfacing pure helpers', () => {
  it('policyRows drops rows that are not decoded PolicyRows (defensive)', () => {
    expect(policyRows(null)).toEqual([]);
    expect(policyRows([{ slug: 'x', directive: null } as unknown])).toEqual([]); // a steering row, not a policy row
    expect(policyRows(POLICY)).toHaveLength(3);
  });
  it('summarizePolicy rolls up total / active / locked', () => {
    expect(summarizePolicy(policyRows(POLICY))).toEqual({ total: 3, active: 2, locked: 1 });
  });
});

describe('AutonomySurfacing rendering', () => {
  it('shows "not armed" when autonomy is disarmed and never lists categories', () => {
    H.armed = false;
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByText('not armed')).toBeTruthy();
    expect(screen.queryByText('Code edits')).toBeNull(); // categories only listed when armed
  });

  it('summarizes the policy + lists active categories when armed', () => {
    H.armed = true;
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByText('armed')).toBeTruthy();
    expect(screen.getByText('Code edits')).toBeTruthy();
    expect(screen.getByText('Research')).toBeTruthy();
    expect(screen.queryByText('Deploy')).toBeNull(); // never-auto ⇒ not in the active list
  });

  it('displays the live breaker threshold (not a hardcoded 3)', () => {
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps({ breakerThreshold: 5 })} />, { wrapper: Wrap });
    expect(screen.getByText(/5/)).toBeTruthy();
    expect(screen.getByText('Cursed-item breaker')).toBeTruthy();
  });

  it('falls back to 3 when no live breaker value is supplied', () => {
    render(<AutonomySurfacing {...makeProps({ breakerThreshold: null })} />, { wrapper: Wrap });
    expect(screen.getByText('Cursed-item breaker')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('"Manage autonomy policy" calls the navigate callback', () => {
    const props = makeProps();
    render(<AutonomySurfacing {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: /Manage autonomy policy/i }));
    expect(props.onManageAutonomy).toHaveBeenCalledTimes(1);
  });

  it('the decomposition segmented control writes the chosen mode and clears to null', () => {
    const props = makeProps({ decomposition: null });
    render(<AutonomySurfacing {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: 'Parallel' }));
    expect(props.onSetDecomposition).toHaveBeenCalledWith('parallel');
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(props.onSetDecomposition).toHaveBeenCalledWith(null);
  });
});
