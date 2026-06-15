// @vitest-environment jsdom
//
// ChunkReloadPrompt — listens for Vite's `vite:preloadError` and shows a
// one-time, dismissible sonner toast whose action hard-reloads to pick up the
// new build. It renders null; its job is the window listener + the
// shown-once guard + the action wiring, so these tests mock sonner + hardReload
// and drive the event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { toast } from 'sonner';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';

vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/hard-reload', () => ({ hardReload: vi.fn() }));

import ChunkReloadPrompt from './ChunkReloadPrompt';

const toastMock = toast as unknown as ReturnType<typeof vi.fn>;
const hardReloadMock = hardReload as unknown as ReturnType<typeof vi.fn>;

const firePreloadError = () =>
  act(() => {
    window.dispatchEvent(new Event('vite:preloadError'));
  });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('<ChunkReloadPrompt>', () => {
  it('renders null and shows no toast before any preload error', () => {
    const { container } = render(<ChunkReloadPrompt />);
    expect(container.innerHTML).toBe('');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('shows the stable-id reload toast on the first preload error', () => {
    render(<ChunkReloadPrompt />);
    firePreloadError();
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [message, opts] = toastMock.mock.calls[0];
    expect(message).toBe('A newer build is available');
    expect(opts).toMatchObject({ id: 'chunk-reload-prompt', duration: Infinity });
    expect(opts.action.label).toBe('Reload');
    expect(opts.description).toContain('app was updated underneath it');
  });

  it('the action onClick hard-reloads', () => {
    render(<ChunkReloadPrompt />);
    firePreloadError();
    const { action } = toastMock.mock.calls[0][1] as { action: { onClick: () => void } };
    expect(hardReloadMock).not.toHaveBeenCalled();
    action.onClick();
    expect(hardReloadMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes: repeated preload errors only ever show one toast (shown-once guard)', () => {
    render(<ChunkReloadPrompt />);
    firePreloadError();
    firePreloadError();
    firePreloadError();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount: a later preload error shows nothing', () => {
    const { unmount } = render(<ChunkReloadPrompt />);
    unmount();
    firePreloadError();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
