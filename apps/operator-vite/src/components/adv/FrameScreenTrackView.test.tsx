// @vitest-environment jsdom
/**
 * FrameScreenTrackView coverage (hive-frame-desktops-live-view-2026-06-06 P-013,
 * D-004) — the v3 screen-track watch leg + its TRANSPARENT fallback contract.
 *
 * The component bails (calls onUnavailable, parent drops to VNC) when:
 *   - WebCodecs can't run here,
 *   - the operator's voice surface is in a DIFFERENT channel (never hijack a call),
 *   - no frame:<slug>:<display> peer / no frame arrives within the timeout;
 * and connects + paints the canvas when a matching peer publishes a frame. The
 * voice-status fetch, the video session (connectDesktopVideo), and webCodecsSupported
 * are mocked; fake timers drive the first-frame timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  webCodecs: true,
  captured: null as null | {
    harness: string;
    onStatus?: (s: { peers: Array<{ id: string; label: string }> }) => void;
    onPeerFrame?: (peerId: string, frame: { close: () => void; displayWidth?: number; displayHeight?: number }) => void;
    onError?: (e: unknown) => void;
  },
  close: vi.fn(),
}));

vi.mock('../../lib/video/video-codec', () => ({
  webCodecsSupported: () => h.webCodecs,
}));
vi.mock('../../lib/video/desktop-video-client', () => ({
  connectDesktopVideo: (opts: typeof h.captured) => {
    h.captured = opts;
    return { close: h.close };
  },
}));

import FrameScreenTrackView from './FrameScreenTrackView';

function stubVoiceStatus(channelId: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ status: { channel: channelId ? { id: channelId } : null } }) })),
  );
}

/** Render + flush the async voice-status check so the session connects. */
async function renderView(props: Partial<Parameters<typeof FrameScreenTrackView>[0]> = {}) {
  const onUnavailable = vi.fn();
  const r = render(<FrameScreenTrackView slug="frame-1" display={2} onUnavailable={onUnavailable} {...props} />);
  await act(async () => {}); // fetch().then(json)
  await act(async () => {}); // the awaited current-channel check
  return { ...r, onUnavailable };
}

beforeEach(() => {
  h.webCodecs = true;
  h.captured = null;
  h.close = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('<FrameScreenTrackView>', () => {
  it('shows the tuning overlay and connects for the harness when idle (no voice channel)', async () => {
    stubVoiceStatus(null);
    await renderView();
    expect(screen.getByText(/Tuning to the screen track/)).toBeTruthy();
    expect(h.captured).not.toBeNull();
    expect(h.captured!.harness).toBe('frame-1');
  });

  it('bails to VNC when WebCodecs is unavailable — never builds a session', async () => {
    h.webCodecs = false;
    stubVoiceStatus(null);
    const { onUnavailable } = await renderView();
    expect(onUnavailable).toHaveBeenCalledWith('WebCodecs unavailable in this webview');
    expect(h.captured).toBeNull();
  });

  it('bails when the operator is in a DIFFERENT voice channel (does not hijack the call)', async () => {
    stubVoiceStatus('vid-other-harness');
    const { onUnavailable } = await renderView({ slug: 'frame-1' });
    expect(onUnavailable).toHaveBeenCalledWith("operator is in voice channel 'vid-other-harness' — not switching it");
    expect(h.captured).toBeNull();
  });

  it('connects when the operator is already tuned to this harness vid-<slug>', async () => {
    stubVoiceStatus('vid-frame-1');
    const { onUnavailable } = await renderView({ slug: 'frame-1' });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(h.captured).not.toBeNull();
  });

  it('connects anyway when the voice-status fetch throws (status unreadable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('status endpoint down');
    }));
    const { onUnavailable } = await renderView();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(h.captured).not.toBeNull();
  });

  it('bails on the first-frame timeout when no frame arrives in time', async () => {
    vi.useFakeTimers();
    stubVoiceStatus(null);
    const onUnavailable = vi.fn();
    render(<FrameScreenTrackView slug="frame-1" display={2} onUnavailable={onUnavailable} />);
    await vi.waitFor(() => expect(h.captured).not.toBeNull());
    // The first-frame guard is 8s — advance past it with no frame delivered.
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onUnavailable).toHaveBeenCalledWith('no screen track for this display (frame not publishing?)');
  });

  it('paints the canvas + clears the overlay when the matching frame:<slug>:<display> peer pushes a frame', async () => {
    stubVoiceStatus(null);
    const { onUnavailable } = await renderView({ slug: 'frame-1', display: 2 });
    // Announce the matching peer, then push a frame from it.
    act(() => h.captured!.onStatus!({ peers: [{ id: 'peer-7', label: 'frame:frame-1:2' }] }));
    const close = vi.fn();
    act(() => h.captured!.onPeerFrame!('peer-7', { close, displayWidth: 640, displayHeight: 480 }));
    expect(close).toHaveBeenCalled(); // frame always released
    expect(screen.queryByText(/Tuning to the screen track/)).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('ignores (and releases) frames from a non-matching peer', async () => {
    stubVoiceStatus(null);
    await renderView({ slug: 'frame-1', display: 2 });
    act(() => h.captured!.onStatus!({ peers: [{ id: 'peer-7', label: 'frame:frame-1:2' }] }));
    const close = vi.fn();
    act(() => h.captured!.onPeerFrame!('someone-else', { close }));
    expect(close).toHaveBeenCalled();
    // still tuning — no matching frame painted
    expect(screen.getByText(/Tuning to the screen track/)).toBeTruthy();
  });

  it('bails on a session error (onError → drop to VNC)', async () => {
    stubVoiceStatus(null);
    const { onUnavailable } = await renderView();
    act(() => h.captured!.onError!(new Error('channel exploded')));
    expect(onUnavailable).toHaveBeenCalledWith('video channel error');
  });

  it('closes the session on unmount', async () => {
    stubVoiceStatus(null);
    const { unmount } = await renderView();
    unmount();
    expect(h.close).toHaveBeenCalled();
  });
});
