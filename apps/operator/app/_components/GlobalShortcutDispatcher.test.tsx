// @vitest-environment jsdom
/**
 * GlobalShortcutDispatcher.test.tsx — render-tier coverage for the single
 * window-level keydown dispatcher (the Notion pattern). The component renders
 * nothing; its behaviour is the side-effect: on mount it seeds the keymap and
 * wires window listeners, on every keydown it calls `dispatchKeydown`, and on
 * unmount it tears the listeners down. We mock the shortcut bus + registry and
 * assert each of those by firing real window events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const dispatchKeydown = vi.fn();
const refreshKeymap = vi.fn();
const loadOverrides = vi.fn(() => ({ 'a.b': 'mod+k' }));

vi.mock('@papercusp/operator-core/lib/shortcut-bus', () => ({
  dispatchKeydown: (e: KeyboardEvent) => dispatchKeydown(e),
  refreshKeymap: (o: unknown) => refreshKeymap(o),
}));
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  loadOverrides: () => loadOverrides(),
}));

import GlobalShortcutDispatcher from './GlobalShortcutDispatcher';

beforeEach(() => {
  dispatchKeydown.mockClear();
  refreshKeymap.mockClear();
  loadOverrides.mockClear();
});
afterEach(cleanup);

describe('GlobalShortcutDispatcher', () => {
  it('renders nothing', () => {
    const { container } = render(<GlobalShortcutDispatcher />);
    expect(container.firstChild).toBeNull();
  });

  it('seeds the keymap from the overrides on mount', () => {
    render(<GlobalShortcutDispatcher />);
    expect(loadOverrides).toHaveBeenCalled();
    expect(refreshKeymap).toHaveBeenCalledWith({ 'a.b': 'mod+k' });
  });

  it('dispatches every window keydown through the bus', () => {
    render(<GlobalShortcutDispatcher />);
    dispatchKeydown.mockClear();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(dispatchKeydown).toHaveBeenCalledTimes(1);
    expect(dispatchKeydown.mock.calls[0][0]).toMatchObject({ key: 'k' });
  });

  it('refreshes the keymap when shortcuts change (custom event) or storage fires', () => {
    render(<GlobalShortcutDispatcher />);
    refreshKeymap.mockClear();
    window.dispatchEvent(new Event('papercusp:shortcuts-changed'));
    expect(refreshKeymap).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('storage'));
    expect(refreshKeymap).toHaveBeenCalledTimes(2);
  });

  it('removes the keydown listener on unmount (no dispatch after teardown)', () => {
    const { unmount } = render(<GlobalShortcutDispatcher />);
    unmount();
    dispatchKeydown.mockClear();
    fireEvent.keyDown(window, { key: 'k' });
    expect(dispatchKeydown).not.toHaveBeenCalled();
  });
});
