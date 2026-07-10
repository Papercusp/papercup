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

const Wrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter searchParams="?qAutonomy=true">{children}</NuqsTestingAdapter>;
const ClosedWrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter>;

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
  it('defaults to a compact Decision style summary', () => {
    render(<AutonomySurfacing {...makeProps()} />, { wrapper: ClosedWrap });
    expect(screen.getByText('Decision style')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.queryByText('Retry limit')).toBeNull();
  });

  it('shows Manual when autonomy is disarmed and never lists categories', () => {
    H.armed = false;
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.queryByText('Code edits')).toBeNull(); // categories only listed when armed
  });

  it('summarizes automatic coverage without exposing cryptic category ceilings', () => {
    H.armed = true;
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByText('2/3 automatic')).toBeTruthy();
    expect(screen.getByText('2 of 3 categories')).toBeTruthy();
    const meter = screen.getByRole('progressbar', { name: 'Automatic decision coverage' });
    expect(meter.getAttribute('aria-valuenow')).toBe('2');
    expect(meter.getAttribute('aria-valuemax')).toBe('3');
    expect(screen.queryByText('Code edits')).toBeNull();
    expect(screen.queryByText('Research')).toBeNull();
  });

  it('displays the live breaker threshold (not a hardcoded 3)', () => {
    H.policy = POLICY;
    render(<AutonomySurfacing {...makeProps({ breakerThreshold: 5 })} />, { wrapper: Wrap });
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('failed attempts')).toBeTruthy();
    expect(screen.getByText('Retry limit')).toBeTruthy();
  });

  it('falls back to 3 when no live breaker value is supplied', () => {
    render(<AutonomySurfacing {...makeProps({ breakerThreshold: null })} />, { wrapper: Wrap });
    expect(screen.getByText('Retry limit')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('Autonomy settings calls the navigate callback', () => {
    const props = makeProps();
    render(<AutonomySurfacing {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: /Autonomy settings/i }));
    expect(props.onManageAutonomy).toHaveBeenCalledTimes(1);
  });

  it('the decomposition segmented control writes the chosen mode and clears to null', () => {
    const props = makeProps({ decomposition: null });
    render(<AutonomySurfacing {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: 'Parallel' }));
    expect(props.onSetDecomposition).toHaveBeenCalledWith('parallel');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(props.onSetDecomposition).toHaveBeenCalledWith(null);
  });

  it('shows a direct workspace reset when parallelism is customized', () => {
    const props = makeProps({ decomposition: 'parallel' });
    render(<AutonomySurfacing {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: 'Use workspace parallelism' }));
    expect(props.onSetDecomposition).toHaveBeenCalledWith(null);
  });
});
