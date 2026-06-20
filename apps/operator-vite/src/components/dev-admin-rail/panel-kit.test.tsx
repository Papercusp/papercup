// @vitest-environment jsdom
/**
 * panel-kit.test.tsx — the shared dev-admin-rail glance-panel helpers:
 * formatRelative (every relative-time bucket + the —/just-now guards, with a
 * pinned Date.now), PanelBar (label, optional refresh button + its fetching
 * state, children), and PanelState (error / loading / empty / nothing branches).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { formatRelative, PanelBar, PanelState } from './panel-kit';

const NOW = 1_700_000_000_000;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('formatRelative', () => {
  it('renders an em-dash for missing timestamps', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
    expect(formatRelative(0)).toBe('—');
  });
  it('renders "just now" for a future timestamp', () => {
    expect(formatRelative(NOW + 5_000)).toBe('just now');
  });
  it('renders seconds, minutes, hours, and days buckets', () => {
    expect(formatRelative(NOW - 12_000)).toBe('12s ago');
    expect(formatRelative(NOW - 4 * 60_000)).toBe('4m ago');
    expect(formatRelative(NOW - 2 * 3_600_000)).toBe('2h ago');
    expect(formatRelative(NOW - 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('PanelBar', () => {
  it('renders the label and no button when onRefresh is absent', () => {
    render(<PanelBar label="Runs" />);
    expect(screen.getByText('Runs')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a labelled refresh button that fires onRefresh', () => {
    const onRefresh = vi.fn();
    render(<PanelBar label="Flags" onRefresh={onRefresh} />);
    const btn = screen.getByRole('button', { name: 'Refresh Flags' });
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toContain('Refresh');
  });

  it('disables the button and shows the spinning state while fetching', () => {
    render(<PanelBar label="Flags" fetching onRefresh={() => {}} />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain('is-spinning');
    expect(btn.textContent).toContain('Refreshing…');
  });

  it('renders children between the spacer and the button', () => {
    render(<PanelBar label="X" onRefresh={() => {}}><span data-testid="extra" /></PanelBar>);
    expect(screen.getByTestId('extra')).toBeTruthy();
  });
});

describe('PanelState', () => {
  it('renders the error message', () => {
    render(<PanelState error={new Error('boom')} />);
    expect(screen.getByText(/Failed to load: boom/)).toBeTruthy();
  });
  it('renders the loading placeholder', () => {
    render(<PanelState loading />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
  it('renders the empty hint (and a default when none given)', () => {
    const { rerender } = render(<PanelState empty emptyHint="No flags yet" />);
    expect(screen.getByText('No flags yet')).toBeTruthy();
    rerender(<PanelState empty />);
    expect(screen.getByText('Nothing to show.')).toBeTruthy();
  });
  it('renders nothing when no state flags are set', () => {
    render(<div data-testid="wrap"><PanelState /></div>);
    expect(screen.getByTestId('wrap').textContent).toBe('');
  });
  it('prioritizes error over loading and empty', () => {
    render(<PanelState error={new Error('x')} loading empty />);
    expect(screen.getByText(/Failed to load: x/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
