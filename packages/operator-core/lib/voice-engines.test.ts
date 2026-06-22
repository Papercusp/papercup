import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock fetch + credentials so the engine selector runs deterministically
// without touching the filesystem or network.
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

vi.mock('./voice-credentials', () => ({
  readElevenLabsKey: vi.fn(() => null),
  readOpenAiKey: vi.fn(() => null),
  readCartesiaKey: vi.fn(() => null),
  readDeepgramKey: vi.fn(() => null),
}));

import { detectEngines } from './voice-engines';
import * as creds from './voice-credentials';
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from './voice-prefs';

const basePrefs: VoicePrefs = {
  // Spread the canonical defaults so this stays complete as VoicePrefs grows (it had drifted
  // 37 fields behind the type); the explicit values below are the test's intended overrides.
  ...DEFAULT_VOICE_PREFS,
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakReceivingFlips: false,
  speakEscalations: true,
  speakCadenceStatus: false,
  speakNudges: true,
  wakeWordIntents: true,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  openaiVoice: 'nova',
  openaiModel: 'tts-1',
  cartesiaVoiceId: 'a0e99841-438c-4a64-b679-ae501e7d6091',
  cartesiaModel: 'sonic-2',
  webSpeechLeakAcked: false,
  kokoroSlowSuggestionDismissed: false,
  nudgeDedup: {
    budget:  { lastSpokenAt: null },
    breaker: { lastSpokenAt: null },
    pause:   { lastSpokenAt: null },
  },
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(creds.readElevenLabsKey).mockResolvedValue(null);
  vi.mocked(creds.readOpenAiKey).mockResolvedValue(null);
  vi.mocked(creds.readCartesiaKey).mockResolvedValue(null);
  vi.mocked(creds.readDeepgramKey).mockResolvedValue(null);
});

afterEach(() => { vi.clearAllMocks(); });

const okHealth = () => Promise.resolve({ ok: true } as Response);
const failHealth = () => Promise.resolve({ ok: false } as Response);

describe('detectEngines', () => {
  it('selects kokoro TTS when Voicemode is reachable', async () => {
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines(basePrefs);
    expect(r.ttsKind).toBe('kokoro');
    expect(r.ctx.kokoroBase).toBe('http://localhost:8880');
  });

  it('falls back to browser TTS when Voicemode kokoro is unreachable', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(':8880')) return failHealth();
      return okHealth();
    });
    const r = await detectEngines(basePrefs);
    expect(r.ttsKind).toBe('browser');
  });

  it('selects elevenlabs when configured + requested', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readElevenLabsKey).mockResolvedValue('sk_test');
    const r = await detectEngines({ ...basePrefs, ttsEngine: 'elevenlabs' });
    expect(r.ttsKind).toBe('elevenlabs');
    expect(r.ctx.elevenlabsApiKey).toBe('sk_test');
  });

  it('falls back to browser when elevenlabs requested but no key', async () => {
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines({ ...basePrefs, ttsEngine: 'elevenlabs' });
    expect(r.ttsKind).toBe('browser');
  });

  it('selects openai when configured + requested', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readOpenAiKey).mockResolvedValue('sk-openai');
    const r = await detectEngines({ ...basePrefs, ttsEngine: 'openai' });
    expect(r.ttsKind).toBe('openai');
  });

  it('selects cartesia when configured + requested', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readCartesiaKey).mockResolvedValue('sk-cartesia');
    const r = await detectEngines({ ...basePrefs, ttsEngine: 'cartesia' });
    expect(r.ttsKind).toBe('cartesia');
  });

  it('selects voicemode STT when whisper reachable', async () => {
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines(basePrefs);
    expect(r.sttKind).toBe('voicemode');
    expect(r.ctx.whisperBase).toBe('http://localhost:2022');
  });

  it('returns sttKind=off when sttEngine=off', async () => {
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines({ ...basePrefs, sttEngine: 'off' });
    expect(r.sttKind).toBe('off');
    expect(r.stt).toBeNull();
  });

  it('falls back to local whisper (NOT webspeech) without leak acknowledgement', async () => {
    // webspeech leaks audio to the cloud; without the ack it must not be chosen —
    // but with local whisper up, STT degrades to voicemode rather than silently off.
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines({ ...basePrefs, sttEngine: 'webspeech', webSpeechLeakAcked: false });
    expect(r.sttKind).toBe('voicemode');
  });

  it('selects webspeech when leak acknowledged', async () => {
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines({ ...basePrefs, sttEngine: 'webspeech', webSpeechLeakAcked: true });
    expect(r.sttKind).toBe('webspeech');
  });

  it('exposes all four cloud key fields in context', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readElevenLabsKey).mockResolvedValue('e');
    vi.mocked(creds.readOpenAiKey).mockResolvedValue('o');
    vi.mocked(creds.readCartesiaKey).mockResolvedValue('c');
    vi.mocked(creds.readDeepgramKey).mockResolvedValue('d');
    const r = await detectEngines(basePrefs);
    expect(r.ctx.elevenlabsApiKey).toBe('e');
    expect(r.ctx.openaiApiKey).toBe('o');
    expect(r.ctx.cartesiaApiKey).toBe('c');
    expect(r.ctx.deepgramApiKey).toBe('d');
  });

  it('falls back to local whisper (NOT deepgram) without leak acknowledgement', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readDeepgramKey).mockResolvedValue('dg-key');
    const r = await detectEngines({ ...basePrefs, sttEngine: 'deepgram', webSpeechLeakAcked: false });
    expect(r.sttKind).toBe('voicemode');
  });

  it('falls back to local whisper when deepgram is requested but has no key', async () => {
    // The real-world bug this guards (broken voice round-trip, 2026-06-22): a user
    // with sttEngine=deepgram and no key had STT silently OFF — speech never
    // transcribed. With local whisper up it now degrades to voicemode instead.
    mockFetch.mockImplementation(okHealth);
    const r = await detectEngines({ ...basePrefs, sttEngine: 'deepgram', webSpeechLeakAcked: true });
    expect(r.sttKind).toBe('voicemode');
  });

  it('stays OFF when the chosen STT engine is unavailable AND local whisper is down', async () => {
    // The fallback is gated on a reachable local whisper; with :2022 down there is no
    // safe keyless STT, so it correctly remains off (never silently uses a cloud engine).
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(':2022')) return failHealth();
      return okHealth();
    });
    const r = await detectEngines({ ...basePrefs, sttEngine: 'deepgram', webSpeechLeakAcked: true });
    expect(r.sttKind).toBe('off');
    expect(r.stt).toBeNull();
  });

  it('selects deepgram when key + leak ack present', async () => {
    mockFetch.mockImplementation(okHealth);
    vi.mocked(creds.readDeepgramKey).mockResolvedValue('dg-key');
    const r = await detectEngines({ ...basePrefs, sttEngine: 'deepgram', webSpeechLeakAcked: true });
    expect(r.sttKind).toBe('deepgram');
  });
});
