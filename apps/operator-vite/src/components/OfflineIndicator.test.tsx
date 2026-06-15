// @vitest-environment jsdom
//
// OfflineIndicator — renders the @papercusp/sync connectivity store's `offline`
// state as a persistent, stable-id sonner toast (and dismisses it on recover).
// The component itself renders null; its whole job is the toast side-effect, so
// these tests mock `useSyncConnectivity` + `sonner.toast` and assert the
// error/dismiss calls across mount + the offline⇄online transitions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { toast } from 'sonner';

const H = vi.hoisted(() => ({ offline: false }));

vi.mock('@papercusp/sync', () => ({
  useSyncConnectivity: () => ({ offline: H.offline }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

import OfflineIndicator from './OfflineIndicator';

const TOAST_ID = 'sync-offline-indicator';

beforeEach(() => {
  H.offline = false;
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('<OfflineIndicator>', () => {
  it('renders null (no DOM output)', () => {
    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('fires the persistent error toast on mount when already offline', () => {
    H.offline = true;
    render(<OfflineIndicator />);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toBe('Operator connection lost');
    expect(opts).toMatchObject({ id: TOAST_ID, duration: Infinity });
    expect(opts.description).toContain('Live data is paused');
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it('dismisses the toast by stable id on mount when online', () => {
    H.offline = false;
    render(<OfflineIndicator />);
    expect(toast.dismiss).toHaveBeenCalledWith(TOAST_ID);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('fires the error toast when transitioning online → offline', () => {
    H.offline = false;
    const { rerender } = render(<OfflineIndicator />);
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
    (toast.dismiss as ReturnType<typeof vi.fn>).mockClear();

    H.offline = true;
    rerender(<OfflineIndicator />);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ id: TOAST_ID });
  });

  it('dismisses the toast when transitioning offline → online (auto-recover)', () => {
    H.offline = true;
    const { rerender } = render(<OfflineIndicator />);
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
    (toast.dismiss as ReturnType<typeof vi.fn>).mockClear();

    H.offline = false;
    rerender(<OfflineIndicator />);
    expect(toast.dismiss).toHaveBeenCalledWith(TOAST_ID);
  });

  it('does not re-fire while offline stays unchanged across re-renders (effect dep is `offline`)', () => {
    H.offline = true;
    const { rerender } = render(<OfflineIndicator />);
    expect(toast.error).toHaveBeenCalledTimes(1);
    rerender(<OfflineIndicator />); // same offline value → effect dep unchanged
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
