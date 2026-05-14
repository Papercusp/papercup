/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MissingPanel, MISSING_PANEL_TIMEOUT_MS } from './MissingPanel';
import { panelRegistry } from './panel-registry';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

beforeEach(() => panelRegistry._reset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MissingPanel', () => {
  it('renders the loading state initially', () => {
    const api = mockApi();
    render(
      <MissingPanel
        panelId="p1"
        panelType="plugin:foo:bar"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/Loading plugin:foo:bar/)).toBeTruthy();
  });

  it('renders the real component once it registers', () => {
    const Real = () => <div data-testid="real">REAL</div>;
    const api = mockApi();
    render(
      <MissingPanel
        panelId="p1"
        panelType="plugin:foo:bar"
        params={{}}
        api={api}
      />,
    );
    expect(screen.queryByTestId('real')).toBeNull();
    act(() => {
      panelRegistry.register('plugin:foo:bar', Real);
    });
    expect(screen.getByTestId('real')).toBeTruthy();
  });

  it('shows "not installed" + Remove button after timeout', () => {
    vi.useFakeTimers();
    const api = mockApi();
    render(
      <MissingPanel
        panelId="p1"
        panelType="plugin:foo:bar"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/Loading plugin:foo:bar/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(MISSING_PANEL_TIMEOUT_MS + 100);
    });
    expect(screen.getByText(/is not installed/i)).toBeTruthy();
    expect(screen.getByText(/Remove panel/i)).toBeTruthy();
  });

  it('Remove button calls api.close()', () => {
    vi.useFakeTimers();
    const api = mockApi();
    render(
      <MissingPanel
        panelId="p1"
        panelType="plugin:foo:bar"
        params={{}}
        api={api}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(MISSING_PANEL_TIMEOUT_MS + 100);
    });
    fireEvent.click(screen.getByText(/Remove panel/i));
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});
