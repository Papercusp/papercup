/**
 * Agent peer tests (P-011/P-012): WAV codec round-trip, utterance segmentation
 * → mocked Whisper, and voiceAgentSay → mocked TTS → paced mic frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeWavPcm16, encodeWavPcm16, resamplePcm16 } from './wav';
import { VOICE_FRAME_SAMPLES } from './codec';

// ---- manager + prefs + synthesize mocks (hoisted before importing the SUT)
const peerFrameCbs: Array<(id: string, f: Int16Array) => void> = [];
const pushMicFrame = vi.fn();
let mockChannel: { id: string } | null = { id: 'vc-1' };
let mockTtsEngine = 'kokoro';

vi.mock('./manager', () => ({
  onPeerFrame: (cb: (id: string, f: Int16Array) => void) => {
    peerFrameCbs.push(cb);
    return () => {
      const i = peerFrameCbs.indexOf(cb);
      if (i >= 0) peerFrameCbs.splice(i, 1);
    };
  },
  pushMicFrame: (f: Int16Array) => pushMicFrame(f),
  voiceStatus: () => ({ channel: mockChannel, muted: false, peers: [], identity: { id: 't', label: 't' } }),
}));

vi.mock('../voice-prefs', () => ({
  loadVoicePrefs: async () => ({ ttsEngine: mockTtsEngine }),
}));

const synthesizeMock = vi.fn();
vi.mock('../endpoint-route/routes/agent-mcp/operator-tts', () => ({
  synthesize: (...args: unknown[]) => synthesizeMock(...args),
}));
vi.mock('../endpoint-route/routes/agent-mcp/operator-voice-proxy-helpers', () => ({
  VOICEMODE_URL: 'http://voicemode.test',
}));

import { enableVoiceAgent, onTranscript, voiceAgentSay } from './agent-peer';

const loudFrame = () => {
  const f = new Int16Array(VOICE_FRAME_SAMPLES);
  for (let i = 0; i < f.length; i++) f[i] = ((i % 80) - 40) * 400; // well above threshold
  return f;
};
const silentFrame = () => new Int16Array(VOICE_FRAME_SAMPLES);

describe('wav codec', () => {
  it('round-trips PCM16 mono and survives resampling', () => {
    const pcm = new Int16Array(1600);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 10) * 12000);
    const wav = encodeWavPcm16(pcm, 16_000);
    const dec = decodeWavPcm16(wav);
    expect(dec.sampleRate).toBe(16_000);
    expect(dec.channels).toBe(1);
    expect([...dec.samples.slice(0, 8)]).toEqual([...pcm.slice(0, 8)]);
    const up = resamplePcm16(dec.samples, 16_000, 48_000);
    expect(Math.abs(up.length - 4800)).toBeLessThanOrEqual(1);
  });
});

describe('utterance segmentation → STT', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ text: ' hello world ' }) })),
    );
  });
  afterEach(() => {
    enableVoiceAgent(false);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('segments speech-then-silence into one transcript', async () => {
    enableVoiceAgent(true);
    expect(peerFrameCbs).toHaveLength(1);
    const got: Array<{ peerId: string; text: string }> = [];
    const off = onTranscript((t) => got.push(t));

    // 10 loud frames (200ms speech), then 30 silent (600ms) → utterance closes
    for (let i = 0; i < 10; i++) peerFrameCbs[0]('peer-A', loudFrame());
    for (let i = 0; i < 30; i++) peerFrameCbs[0]('peer-A', silentFrame());
    await new Promise((r) => setTimeout(r, 50));

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ peerId: 'peer-A', text: 'hello world' });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('voicemode.test/v1/audio/transcriptions');
    off();
  });

  it('ignores sub-threshold blips (never opens an utterance)', async () => {
    enableVoiceAgent(true);
    const got: unknown[] = [];
    onTranscript((t) => got.push(t));
    for (let i = 0; i < 3; i++) peerFrameCbs[0]('peer-B', loudFrame()); // <MIN_SPEECH_FRAMES
    for (let i = 0; i < 40; i++) peerFrameCbs[0]('peer-B', silentFrame());
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toHaveLength(0);
  });
});

describe('voiceAgentSay', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockChannel = { id: 'vc-1' };
    mockTtsEngine = 'kokoro';
  });

  it('TTS → wav → 48k paced frames into the channel', async () => {
    // 0.1s of 24k mono WAV from the mocked synthesize → 0.1s @48k = 5 frames
    const pcm24 = new Int16Array(2400).fill(800);
    const wav = encodeWavPcm16(pcm24, 24_000);
    synthesizeMock.mockResolvedValue({ ok: true, audio: wav.buffer, contentType: 'audio/wav' });

    const frames = await voiceAgentSay('hello there');
    // The channel say-path always asks synthesize for a WAV container.
    expect(synthesizeMock).toHaveBeenCalledWith('kokoro', 'hello there', undefined, expect.anything(), {
      container: 'wav',
    });
    expect(frames).toBe(5);
    expect(pushMicFrame).toHaveBeenCalledTimes(5);
    expect((pushMicFrame.mock.calls[0][0] as Int16Array).length).toBe(VOICE_FRAME_SAMPLES);
  });

  it('speaks via elevenlabs — synthesize returns a WAV-wrapped stream → paced frames', async () => {
    // The narrator (B1) runs ttsEngine:'elevenlabs'. synthesize (real impl,
    // mocked here) returns audio/wav for container:'wav' — the EL raw PCM
    // wrapped into a RIFF/WAVE. 0.1s of 24k PCM → 5 frames @48k.
    mockTtsEngine = 'elevenlabs';
    const pcm24 = new Int16Array(2400).fill(600);
    const wav = encodeWavPcm16(pcm24, 24_000);
    synthesizeMock.mockResolvedValue({ ok: true, audio: wav.buffer, contentType: 'audio/wav' });

    const frames = await voiceAgentSay('the agents are on two machines');
    expect(synthesizeMock).toHaveBeenCalledWith(
      'elevenlabs',
      'the agents are on two machines',
      undefined,
      expect.anything(),
      { container: 'wav' },
    );
    expect(frames).toBe(5);
    expect(pushMicFrame).toHaveBeenCalledTimes(5);
  });

  it('no-ops on a non-wav content-type (e.g. an engine that ignored the wav request)', async () => {
    mockTtsEngine = 'elevenlabs';
    synthesizeMock.mockResolvedValue({
      ok: true,
      audio: new ArrayBuffer(64),
      contentType: 'audio/mpeg',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frames = await voiceAgentSay('mp3 should not reach the channel');
    expect(frames).toBe(0);
    expect(pushMicFrame).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('needs WAV/PCM'));
    errSpy.mockRestore();
  });

  it('no-ops when not in a channel', async () => {
    mockChannel = null;
    const frames = await voiceAgentSay('into the void');
    expect(frames).toBe(0);
    expect(synthesizeMock).not.toHaveBeenCalled();
  });
});
