/**
 * @vitest-environment jsdom
 *
 * Tests for the push-to-talk raw-capture path — the WebKitGTK-safe
 * replacement for the Silero-VAD whisper capture. Covers the pure helpers
 * (resampling, peak, blank-transcript detection, the no-audio/transcribe
 * classification) plus the Web Audio capture lifecycle with mocked nodes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resampleLinearTo16k,
  peakAmplitude,
  isBlankTranscript,
  classifyPttResult,
  startPttRawCapture,
  PTT_SILENCE_PEAK,
  PTT_MIN_DURATION_SEC,
  type PttRawCaptureResult,
} from './ptt-capture';

describe('resampleLinearTo16k', () => {
  it('returns the input unchanged when already 16k', () => {
    const s = new Float32Array([0.1, -0.2, 0.3]);
    expect(resampleLinearTo16k(s, 16000)).toBe(s);
  });

  it('returns empty for empty input', () => {
    expect(resampleLinearTo16k(new Float32Array(0), 44100).length).toBe(0);
  });

  it('downsamples 48k → 16k by a factor of 3', () => {
    const s = new Float32Array(300).map((_, i) => Math.sin(i / 5));
    const out = resampleLinearTo16k(s, 48000);
    expect(out.length).toBe(100);
  });

  it('downsamples 44.1k → 16k by the correct ratio', () => {
    const s = new Float32Array(44100); // 1s
    const out = resampleLinearTo16k(s, 44100);
    expect(out.length).toBe(16000); // floor(44100 / (44100/16000))
  });

  it('linearly interpolates between samples (2x downsample picks evens)', () => {
    const s = new Float32Array([0, 1, 2, 3, 4, 5]);
    const out = resampleLinearTo16k(s, 32000); // ratio 2 → out[i] = s[2i]
    expect(Array.from(out)).toEqual([0, 2, 4]);
  });

  it('preserves the first sample exactly', () => {
    const s = new Float32Array([0.42, 0.1, -0.1, 0.9]);
    expect(resampleLinearTo16k(s, 48000)[0]).toBeCloseTo(0.42, 6);
  });
});

describe('peakAmplitude', () => {
  it('is 0 for an all-zero (dead/muted) buffer', () => {
    expect(peakAmplitude(new Float32Array(1000))).toBe(0);
  });
  it('returns the max absolute value', () => {
    expect(peakAmplitude(new Float32Array([0.1, -0.7, 0.3, -0.2]))).toBeCloseTo(0.7, 6);
  });
});

describe('isBlankTranscript', () => {
  it.each([
    [null], [undefined], [''], ['   '], ['\n'],
    ['[BLANK_AUDIO]'], [' [BLANK_AUDIO]\n'], ['[SILENCE]'], ['[ Silence ]'],
    ['(phone ringing)'], ['...'], ['—'],
  ])('treats %j as blank', (t) => {
    expect(isBlankTranscript(t as string | null | undefined)).toBe(true);
  });

  it.each([
    ['hello'], ['operator status'], ['  open the dashboard  '],
    ['Yes.'], ['turn 3'], ['[note] real text after marker'],
  ])('treats %j as a real transcript', (t) => {
    expect(isBlankTranscript(t)).toBe(false);
  });
});

describe('classifyPttResult', () => {
  const make = (over: Partial<PttRawCaptureResult>): PttRawCaptureResult => ({
    samples: new Float32Array(16000),
    sampleRate: 16000,
    peak: 0.5,
    durationSec: 1,
    ...over,
  });

  it('null / empty buffer → no-audio', () => {
    expect(classifyPttResult(null)).toBe('no-audio');
    expect(classifyPttResult(make({ samples: new Float32Array(0) }))).toBe('no-audio');
  });

  it('too-short hold → no-audio', () => {
    expect(classifyPttResult(make({ durationSec: PTT_MIN_DURATION_SEC - 0.01 }))).toBe('no-audio');
  });

  it('dead/muted track (peak below the silence floor) → no-audio', () => {
    expect(classifyPttResult(make({ peak: PTT_SILENCE_PEAK / 2 }))).toBe('no-audio');
  });

  it('working mic with signal → transcribe', () => {
    expect(classifyPttResult(make({ peak: 0.2, durationSec: 0.8 }))).toBe('transcribe');
  });

  it('quiet-but-live mic (just above floor) → transcribe (whisper decides on words)', () => {
    expect(classifyPttResult(make({ peak: PTT_SILENCE_PEAK * 2, durationSec: 1 }))).toBe('transcribe');
  });
});

// --- Web Audio capture lifecycle (mocked nodes) ---

let lastCtx: FakeCtx | null = null;
let getUserMedia: ReturnType<typeof vi.fn>;
let track: { stop: ReturnType<typeof vi.fn> };

class FakeScriptProcessor {
  onaudioprocess: ((e: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  /** Drive one audio callback with the given frame of samples. */
  emit(frame: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
  }
}

class FakeCtx {
  state: 'suspended' | 'running' = 'suspended';
  sampleRate = 48000;
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => {});
  sp = new FakeScriptProcessor();
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => this.sp);
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  destination = {};
  constructor() { lastCtx = this; }
}

beforeEach(() => {
  lastCtx = null;
  track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = FakeCtx;
});

describe('startPttRawCapture', () => {
  it('resumes a suspended context and accumulates captured samples + peak', async () => {
    const cap = await startPttRawCapture();
    expect(lastCtx!.resume).toHaveBeenCalled();
    expect(lastCtx!.state).toBe('running');

    lastCtx!.sp.emit(new Float32Array([0.1, -0.5, 0.2]));
    lastCtx!.sp.emit(new Float32Array([0.05, 0.3]));

    const result = cap.stop();
    const expected = [0.1, -0.5, 0.2, 0.05, 0.3];
    expect(result.samples.length).toBe(expected.length);
    expected.forEach((v, i) => expect(result.samples[i]).toBeCloseTo(v, 5));
    expect(result.peak).toBeCloseTo(0.5, 6);
    expect(result.sampleRate).toBe(48000);
    expect(result.durationSec).toBeCloseTo(5 / 48000, 8);
  });

  it('copies each frame (later mutation of the source buffer is not retained)', async () => {
    const cap = await startPttRawCapture();
    const frame = new Float32Array([0.9, 0.8]);
    lastCtx!.sp.emit(frame);
    frame[0] = 0; frame[1] = 0; // mutate the reused inputBuffer after the callback
    const result = cap.stop();
    expect(result.samples.length).toBe(2);
    expect(result.samples[0]).toBeCloseTo(0.9, 5);
    expect(result.samples[1]).toBeCloseTo(0.8, 5);
  });

  it('releases the mic track and closes the context on stop', async () => {
    const cap = await startPttRawCapture();
    cap.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(lastCtx!.close).toHaveBeenCalled();
  });

  it('stop() is idempotent', async () => {
    const cap = await startPttRawCapture();
    lastCtx!.sp.emit(new Float32Array([0.2]));
    cap.stop();
    const second = cap.stop();
    expect(second.samples.length).toBe(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('throws when getUserMedia is unavailable', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    await expect(startPttRawCapture()).rejects.toThrow(/getUserMedia/);
  });
});
