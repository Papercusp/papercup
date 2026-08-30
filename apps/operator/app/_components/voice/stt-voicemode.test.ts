import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  newMicVAD: vi.fn(),
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: h.newMicVAD },
}));

vi.mock('@papercusp/operator-core/lib/voice-engines/whisper', () => ({
  transcribeChunk: vi.fn(),
}));

vi.mock('./f32-to-wav', () => ({
  f32ToWav: vi.fn(),
}));

vi.mock('./capture-window', () => ({
  captureWindowEndingAt: vi.fn(() => ({ startedAtMs: 0, endedAtMs: 0 })),
}));

describe('startWhisperCapture — vad-web timing options', () => {
  let originalWindow: unknown;
  let originalMediaDevices: unknown;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    const g = globalThis as any;
    originalWindow = g.window;
    originalMediaDevices = g.navigator?.mediaDevices;
    g.window = g;
    if (!g.navigator) g.navigator = {};
    g.navigator.mediaDevices = { getUserMedia: vi.fn() };

    h.newMicVAD.mockResolvedValue({
      start: vi.fn(async () => {}),
      pause: vi.fn(),
      destroy: vi.fn(),
    });
  });

  afterEach(() => {
    const g = globalThis as any;
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
    if (g.navigator) g.navigator.mediaDevices = originalMediaDevices;
  });

  it('passes millisecond options and never the ignored frame-named options', async () => {
    const { startWhisperCapture } = await import('./stt-voicemode');

    const capture = await startWhisperCapture('http://localhost:2022', {
      onFinal: vi.fn(),
    });

    expect(h.newMicVAD).toHaveBeenCalledTimes(1);
    const options = h.newMicVAD.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      minSpeechMs: 400,
      redemptionMs: 1400,
      preSpeechPadMs: 800,
    });
    expect(options).not.toHaveProperty('minSpeechFrames');
    expect(options).not.toHaveProperty('redemptionFrames');
    expect(options).not.toHaveProperty('preSpeechPadFrames');

    capture.stop();
  });
});
