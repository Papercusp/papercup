// @vitest-environment jsdom
//
// OfflineIndicator — renders the @papercusp/sync connectivity store's `offline`
// state as a persistent, stable-id sonner toast (and dismisses it on recover).
// The component itself renders null; its whole job is the toast side-effect, so
// these tests mock `useSyncConnectivity` + `sonner.toast` and assert the
// error/dismiss calls across mount + the offline⇄online transitions.
//
// EI-3033: the alarm toast is DEBOUNCED on the time axis — it only appears once
// the outage has persisted past OFFLINE_TOAST_GRACE_MS, so a brief reconnect
// blip under fleet load never interrupts the user. These tests drive fake
// timers to assert the debounce + the brief-drop-recovers regression.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { toast } from 'sonner';

const H = vi.hoisted(() => ({ offline: false }));

vi.mock('@papercusp/sync', () => ({
  useSyncConnectivity: () => ({ offline: H.offline }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

import OfflineIndicator, { OFFLINE_TOAST_GRACE_MS } from './OfflineIndicator';

const TOAST_ID = 'sync-offline-indicator';
const errorMock = () => toast.error as ReturnType<typeof vi.fn>;
const dismissMock = () => toast.dismiss as ReturnType<typeof vi.fn>;

beforeEach(() => {
  H.offline = false;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('<OfflineIndicator>', () => {
  it('renders null (no DOM output)', () => {
    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('debounces: when already offline, the error toast fires only after the grace window', () => {
    H.offline = true;
    render(<OfflineIndicator />);
    // Within the grace window — no alarm yet.
    expect(errorMock()).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS));
    expect(errorMock()).toHaveBeenCalledTimes(1);
    const [message, opts] = errorMock().mock.calls[0];
    expect(message).toBe('Operator connection lost');
    expect(opts).toMatchObject({ id: TOAST_ID, duration: Infinity });
    expect(opts.description).toContain('Live data is paused');
  });

  it('dismisses the toast by stable id on mount when online', () => {
    H.offline = false;
    render(<OfflineIndicator />);
    expect(dismissMock()).toHaveBeenCalledWith(TOAST_ID);
    expect(errorMock()).not.toHaveBeenCalled();
  });

  it('fires the error toast after the grace window when transitioning online → offline', () => {
    H.offline = false;
    const { rerender } = render(<OfflineIndicator />);
    errorMock().mockClear();
    dismissMock().mockClear();

    H.offline = true;
    rerender(<OfflineIndicator />);
    expect(errorMock()).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS));
    expect(errorMock()).toHaveBeenCalledTimes(1);
    expect(errorMock().mock.calls[0][1]).toMatchObject({ id: TOAST_ID });
  });

  it('does NOT fire for a brief drop that recovers within the grace window (EI-3033)', () => {
    H.offline = false;
    const { rerender } = render(<OfflineIndicator />);
    errorMock().mockClear();
    dismissMock().mockClear();

    // Brief drop under fleet load.
    H.offline = true;
    rerender(<OfflineIndicator />);
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS - 1));
    expect(errorMock()).not.toHaveBeenCalled();

    // Reconnects before the grace elapses — the pending alarm must be cancelled.
    H.offline = false;
    rerender(<OfflineIndicator />);
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS * 2));

    expect(errorMock()).not.toHaveBeenCalled();
  });

  it('dismisses the toast when a sustained outage recovers (offline → online)', () => {
    H.offline = true;
    const { rerender } = render(<OfflineIndicator />);
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS));
    expect(errorMock()).toHaveBeenCalledTimes(1);
    dismissMock().mockClear();

    H.offline = false;
    rerender(<OfflineIndicator />);
    expect(dismissMock()).toHaveBeenCalledWith(TOAST_ID);
  });

  it('does not re-fire while offline stays unchanged across re-renders (effect dep is `offline`)', () => {
    H.offline = true;
    const { rerender } = render(<OfflineIndicator />);
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS));
    expect(errorMock()).toHaveBeenCalledTimes(1);
    rerender(<OfflineIndicator />); // same offline value → effect dep unchanged
    act(() => vi.advanceTimersByTime(OFFLINE_TOAST_GRACE_MS));
    expect(errorMock()).toHaveBeenCalledTimes(1);
  });
});
