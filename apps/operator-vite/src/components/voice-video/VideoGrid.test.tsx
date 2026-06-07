// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { VoiceSessionStatus } from '../../lib/video/desktop-video-client';

// Capture the session callbacks + spy the session/capture (hoisted: referenced
// inside the vi.mock factories).
const h = vi.hoisted(() => ({
  captured: { opts: null as null | { onStatus?: (s: unknown) => void; onPeerFrame?: unknown } },
  session: {
    setMuted: vi.fn(),
    setCameraOn: vi.fn(),
    sendCamFrame: vi.fn(),
    videoPeers: vi.fn(() => [] as string[]),
    close: vi.fn(),
  },
  startCameraCapture: vi.fn(async () => ({
    stop: vi.fn(),
    encoder: { encode: vi.fn(), requestKeyframe: vi.fn(), reconfigure: vi.fn(), close: vi.fn() },
    stream: { getVideoTracks: () => [{ stop: vi.fn() }] },
  })),
}));

vi.mock('../../lib/video/desktop-video-client', () => ({
  connectDesktopVideo: (opts: { onStatus?: (s: unknown) => void }) => {
    h.captured.opts = opts;
    return h.session;
  },
}));
vi.mock('../../lib/video/camera-capture', () => ({ startCameraCapture: h.startCameraCapture }));
// Runtime-config port discovery (P-015 D-014) — resolve immediately in tests.
vi.mock('../../lib/voice/resolve-voice-ws-url', () => ({
  resolveDesktopVoiceWsUrl: () => Promise.resolve('ws://127.0.0.1:3076/api/desktop/voice'),
}));

import VideoGrid from './VideoGrid';

function fakeWebCodecs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.VideoEncoder = function () {} as never;
  g.VideoDecoder = function () {} as never;
  g.EncodedVideoChunk = function () {} as never;
}

beforeEach(() => {
  fakeWebCodecs();
  h.captured.opts = null;
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.VideoEncoder;
  delete g.VideoDecoder;
  delete g.EncodedVideoChunk;
});

async function renderGrid() {
  const r = render(
    <NuqsTestingAdapter>
      <VideoGrid harnessSlug="harnessX" />
    </NuqsTestingAdapter>,
  );
  // Flush the (mocked) runtime-config URL resolution so the session connects.
  await act(async () => {});
  return r;
}

function pushStatus(status: VoiceSessionStatus) {
  act(() => {
    h.captured.opts?.onStatus?.(status);
  });
}

describe('<VideoGrid>', () => {
  it('connects for the harness and renders the control bar + empty state', async () => {
    await renderGrid();
    expect(h.captured.opts).not.toBeNull();
    expect(screen.getByText(/Waiting for others to join/)).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: /call controls/i })).toBeTruthy();
    expect(screen.getByText(/Mute/)).toBeTruthy();
    expect(screen.getByText(/Camera/)).toBeTruthy();
    expect(screen.getByText(/Share screen/)).toBeTruthy();
    expect(screen.getByText(/Leave/)).toBeTruthy();
  });

  it('renders a tile per peer and flags the active speaker', async () => {
    await renderGrid();
    pushStatus({
      channel: { id: 'vid-harnessX' },
      muted: false,
      identity: { id: 'me', label: 'Me' },
      peers: [
        { id: 'a', label: 'Alice', muted: false, speaking: false, cameraOn: false },
        { id: 'b', label: 'Bob', muted: false, speaking: true, cameraOn: false },
      ],
    });
    expect(screen.getByLabelText('Alice')).toBeTruthy();
    const bob = screen.getByLabelText('Bob (speaking)');
    expect(bob.getAttribute('data-speaking')).toBe('true');
    // waiting state is gone
    expect(screen.queryByText(/Waiting for others to join/)).toBeNull();
  });

  it('camera button is enabled when WebCodecs is available (not audio-only)', async () => {
    await renderGrid();
    const cam = screen.getByText(/Camera/).closest('button')!;
    expect(cam.hasAttribute('disabled')).toBe(false);
  });

  it('toggling mute drives the session', async () => {
    await renderGrid();
    fireEvent.click(screen.getByText(/Mute/));
    // nuqs updates vmute → re-render → effect calls setMuted(true)
    await screen.findByText(/Unmute/);
    expect(h.session.setMuted).toHaveBeenCalledWith(true);
  });

  it('Leave tears down the session', async () => {
    await renderGrid();
    fireEvent.click(screen.getByText(/Leave/));
    expect(h.session.close).toHaveBeenCalled();
  });

  it('closes the session on unmount', async () => {
    const { unmount } = await renderGrid();
    unmount();
    expect(h.session.close).toHaveBeenCalled();
  });
});
