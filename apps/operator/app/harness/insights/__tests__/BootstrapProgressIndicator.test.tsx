/**
 * @vitest-environment jsdom
 *
 * BootstrapProgressIndicator — P-066 tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { BootstrapProgressIndicator } from '../BootstrapProgressIndicator';

afterEach(() => {
  cleanup();
});

describe('BootstrapProgressIndicator — P-066', () => {
  it('renders nothing when totalOps = 0', () => {
    render(<BootstrapProgressIndicator totalOps={0} mergedOps={0} />);
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('renders syncing pill when merged < total', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={3} />);
    const el = screen.getByTestId('bootstrap-progress-indicator');
    expect(el.getAttribute('data-state')).toBe('syncing');
    expect(el.textContent).toContain('Syncing 3/10');
  });

  it('renders caught-up pill when merged >= total', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={10} />);
    const el = screen.getByTestId('bootstrap-progress-indicator');
    expect(el.getAttribute('data-state')).toBe('caught-up');
    expect(el.textContent).toContain('Up to date');
  });

  it('caught-up state also fires when merged > total (race)', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={15} />);
    expect(
      screen
        .getByTestId('bootstrap-progress-indicator')
        .getAttribute('data-state'),
    ).toBe('caught-up');
  });

  it('omits dismiss button when onDismiss not provided', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={3} />);
    expect(screen.queryByTestId('bootstrap-progress-dismiss')).toBeNull();
  });

  it('shows dismiss button when onDismiss is provided (syncing)', () => {
    const onDismiss = vi.fn();
    render(
      <BootstrapProgressIndicator
        totalOps={10}
        mergedOps={3}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('bootstrap-progress-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows dismiss button when onDismiss is provided (caught-up)', () => {
    const onDismiss = vi.fn();
    render(
      <BootstrapProgressIndicator
        totalOps={10}
        mergedOps={10}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('bootstrap-progress-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('an unresolved head cannot render up to date from matching counts', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={10} joinState="joining" />);
    expect(screen.getByTestId('bootstrap-progress-indicator').getAttribute('data-state')).toBe('syncing');
    expect(screen.getByText('Joining')).toBeTruthy();
  });

  it('does not call a completed join up to date while new content or materialization is pending', () => {
    const { rerender } = render(<BootstrapProgressIndicator totalOps={11} mergedOps={10} joinState="complete" />);
    expect(screen.getByTestId('bootstrap-progress-indicator').getAttribute('data-state')).toBe('syncing');
    rerender(<BootstrapProgressIndicator totalOps={10} mergedOps={10} joinState="complete" caughtUp={false} />);
    expect(screen.getByTestId('bootstrap-progress-indicator').getAttribute('data-state')).toBe('syncing');
  });

  it('shows a stalled join and an admitted empty completion', () => {
    const { rerender } = render(<BootstrapProgressIndicator totalOps={10} mergedOps={3} joinState="failed" />);
    expect(screen.getByText('Sync stalled')).toBeTruthy();
    rerender(<BootstrapProgressIndicator totalOps={0} mergedOps={0} joinState="complete" />);
    expect(screen.getByTestId('bootstrap-progress-indicator').getAttribute('data-state')).toBe('caught-up');
  });

  it('tooltip includes percentage', () => {
    render(<BootstrapProgressIndicator totalOps={10} mergedOps={3} />);
    const el = screen.getByTestId('bootstrap-progress-indicator');
    expect(el.getAttribute('title')).toContain('30%');
  });
});
