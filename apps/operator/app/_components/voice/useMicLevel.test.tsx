/**
 * @vitest-environment jsdom
 *
 * Tests for the mic-level visualization hook. This is the hook behind the
 * "No audio detected" PTT failure: it opens its own getUserMedia stream,
 * runs an AnalyserNode, and reports both the RMS-threshold crossings
 * (audioReceiving) and any capture error. The regression we fixed — a
 * never-resumed, suspended-by-default AudioContext feeding the analyser
 * nothing — is locked down here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMicLevel } from './useMicLevel';

let lastCtx: FakeCtx | null = null;
let rafCb: ((t: number) => void) | null = null;
let getUserMedia: ReturnType<typeof vi.fn>;
let track: { stop: ReturnType<typeof vi.fn> };

class FakeAnalyser {
  fftSize = 512;
  smoothingTimeConstant = 0;
  /** Uniform time-domain byte value the buffer fills with (128 = silence). */
  val = 128;
  getByteTimeDomainData(buf: Uint8Array) { buf.fill(this.val); }
}

class FakeCtx {
  state: 'suspended' | 'running' = 'suspended';
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => {});
  analyser = new FakeAnalyser();
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => this.analyser);
  constructor() { lastCtx = this; }
}

beforeEach(() => {
  lastCtx = null;
  rafCb = null;
  track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  (window as any).AudioContext = FakeCtx;
  (window as any).webkitAudioContext = FakeCtx;
  window.requestAnimationFrame = ((cb: (t: number) => void) => { rafCb = cb; return 1; }) as any;
  window.cancelAnimationFrame = (() => { rafCb = null; }) as any;
});

/** Invoke the pending rAF callback at timestamp `t` (it reschedules itself). */
function driveTick(t: number) {
  const cb = rafCb;
  rafCb = null;
  cb?.(t);
}

describe('useMicLevel', () => {
  it('does not open the mic when inactive', () => {
    renderHook(() => useMicLevel(false, vi.fn(), vi.fn()));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('resumes a suspended AudioContext and clears the capture error on success', async () => {
    const onErr = vi.fn();
    renderHook(() => useMicLevel(true, vi.fn(), onErr));
    await waitFor(() => expect(lastCtx).not.toBeNull());
    await waitFor(() => expect(lastCtx!.resume).toHaveBeenCalled());
    expect(lastCtx!.state).toBe('running');
    expect(onErr).toHaveBeenCalledWith(null);
  });

  it('reports the getUserMedia error when capture is denied', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    getUserMedia.mockRejectedValueOnce(err);
    const onErr = vi.fn();
    renderHook(() => useMicLevel(true, vi.fn(), onErr));
    await waitFor(() => expect(onErr).toHaveBeenCalledWith(err));
  });

  it('flips receiving true/false across the RMS hysteresis thresholds', async () => {
    const onRecv = vi.fn();
    renderHook(() => useMicLevel(true, onRecv, vi.fn()));
    await waitFor(() => expect(rafCb).not.toBeNull());

    lastCtx!.analyser.val = 145; // loud → eased ≈ 0.68, above RECEIVING_ON (0.08)
    driveTick(100);
    expect(onRecv).toHaveBeenLastCalledWith(true);

    lastCtx!.analyser.val = 128; // silence → eased 0, below RECEIVING_OFF (0.04)
    driveTick(200);
    expect(onRecv).toHaveBeenLastCalledWith(false);
  });

  it('stops the mic track and closes the context on unmount', async () => {
    const { unmount } = renderHook(() => useMicLevel(true, vi.fn(), vi.fn()));
    await waitFor(() => expect(lastCtx).not.toBeNull());
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(lastCtx!.close).toHaveBeenCalled();
  });
});
