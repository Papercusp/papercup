/**
 * Voice engine framework (Phase 1c).
 *
 * Three TTS engines + two STT engines, all behind common interfaces.
 * `detectEngines(prefs)` probes availability and picks the active pair
 * per v4 §1.1.1 + §1.2.
 *
 * Endpoint resolution:
 *   STT (Whisper):  mcp probe → VOICEMODE_WHISPER_URL → http://localhost:2022
 *   TTS (Kokoro):   mcp probe → VOICEMODE_KOKORO_URL  → http://localhost:8880
 *   TTS (ElevenLabs): API key from credentials.json
 *
 * Engine adapters are lazy-instantiated; `health()` is the cheap probe
 * the chrome boots with.
 */

import { readElevenLabsKey, readOpenAiKey, readCartesiaKey, readDeepgramKey } from './voice-credentials';
import type { SttEngineKind, TtsEngineKind, VoicePrefs } from './voice-prefs';

export type Priority = 'polite' | 'assertive';

export interface SpeakOptions {
  voice?: string;
  rate?: number;
  priority?: Priority;
}

export interface VoiceListItem {
  id: string;
  name: string;
  lang?: string;
}

export interface SttEngine {
  kind: SttEngineKind;
  health(): Promise<boolean>;
  // Streaming transcription returns partials + a final marker; the chrome
  // bridge (voice-mode.ts) wires this into `onFinalUtterance`.
  transcribeStream?(): AsyncIterable<{ partial: string; isFinal: boolean }>;
}

export interface TtsEngine {
  kind: TtsEngineKind;
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  cancel(): Promise<void>;
  voices(): Promise<VoiceListItem[]>;
  health(): Promise<boolean>;
  /** Cumulative chars-spoken since process start (for ElevenLabs cost tracking). */
  charsSpoken(): number;
}

export interface EnginesContext {
  whisperBase: string | null;
  kokoroBase: string | null;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  cartesiaApiKey: string | null;
  deepgramApiKey: string | null;
}

export interface DetectResult {
  ctx: EnginesContext;
  stt: SttEngine | null;
  tts: TtsEngine;
  sttKind: SttEngineKind;
  ttsKind: TtsEngineKind;
}

const DEFAULT_WHISPER = 'http://localhost:2022';
const DEFAULT_KOKORO = 'http://localhost:8880';

/**
 * Resolve Voicemode endpoints per v4 §1.1.1.
 * MCP service probe is server-side and isn't available in the browser;
 * client uses env-style hints injected via `<script>` or falls back to
 * the default ports. The chrome surfaces a "Re-detect engines" button
 * that re-runs this resolution.
 */
export async function resolveVoicemodeEndpoints(): Promise<{
  whisperBase: string | null;
  kokoroBase: string | null;
}> {
  // Browser context: read window-injected hints if present (the chrome
  // can pass detected ports via a global), otherwise probe the default
  // ports' /health endpoints in parallel.
  const w = (typeof window !== 'undefined' ? (window as any).__papercuspVoicemode : undefined) ?? {};
  const whisperHint: string | undefined = w.whisperBase;
  const kokoroHint: string | undefined = w.kokoroBase;

  const [whisperBase, kokoroBase] = await Promise.all([
    probeHealth(whisperHint ?? DEFAULT_WHISPER),
    probeHealth(kokoroHint ?? DEFAULT_KOKORO),
  ]);
  return { whisperBase, kokoroBase };
}

async function probeHealth(base: string): Promise<string | null> {
  try {
    const r = await fetch(`${base}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
    if (r.ok) return base;
    return null;
  } catch {
    return null;
  }
}

export async function detectEngines(prefs: VoicePrefs): Promise<DetectResult> {
  const { whisperBase, kokoroBase } = await resolveVoicemodeEndpoints();
  // BUGFIX: these reads are async (Promise<string|null>); they were assigned WITHOUT await, so
  // every key was a (truthy) Promise — engine selection picked key-requiring engines even with no
  // key, and passed the Promise itself as `apiKey`. EnginesContext expects `string|null`, so the
  // missing await was both a type error and a real runtime bug. Await them (Promise.all keeps the
  // reads parallel). (Surfaced by the operator-core lint:tsc cleanup — EI-1341.)
  const [elevenlabsApiKey, openaiApiKey, cartesiaApiKey, deepgramApiKey] = await Promise.all([
    readElevenLabsKey(),
    readOpenAiKey(),
    readCartesiaKey(),
    readDeepgramKey(),
  ]);
  const ctx: EnginesContext = { whisperBase, kokoroBase, elevenlabsApiKey, openaiApiKey, cartesiaApiKey, deepgramApiKey };

  // STT selection (per v4 §1.1)
  let stt: SttEngine | null = null;
  let sttKind: SttEngineKind = 'off';
  if (prefs.sttEngine === 'voicemode' && whisperBase) {
    const { createVoicemodeWhisper } = await import('./voice-engines/whisper');
    stt = createVoicemodeWhisper(whisperBase);
    sttKind = 'voicemode';
  } else if (prefs.sttEngine === 'webspeech' && prefs.webSpeechLeakAcked) {
    const { createWebSpeechStt } = await import('./voice-engines/webspeech');
    stt = createWebSpeechStt();
    sttKind = 'webspeech';
  } else if (prefs.sttEngine === 'deepgram' && deepgramApiKey && prefs.webSpeechLeakAcked) {
    const { createDeepgramStt } = await import('./voice-engines/deepgram');
    stt = createDeepgramStt({ apiKey: deepgramApiKey });
    sttKind = 'deepgram';
  }

  // STT fallback: the user WANTS speech input (engine !== 'off') but the chosen
  // engine was unavailable — a cloud engine with no key (deepgram), or web-speech
  // without the leak ack — so the chain above left `stt` null and STT would be
  // SILENTLY OFF (mic dead, the user speaks and nothing transcribes, with no
  // signal why). When the LOCAL Voicemode/Whisper server is up, drop to it: it's
  // keyless and privacy-safe (audio never leaves the machine, so no ack needed).
  // Mirrors the TTS branch's always-available browser fallback. An explicit
  // 'off' is preserved (no degradation when the user disabled STT on purpose).
  if (!stt && prefs.sttEngine !== 'off' && whisperBase) {
    const { createVoicemodeWhisper } = await import('./voice-engines/whisper');
    stt = createVoicemodeWhisper(whisperBase);
    sttKind = 'voicemode';
  }

  // TTS selection (per v4 §1.2)
  let tts: TtsEngine;
  let ttsKind: TtsEngineKind;
  const requested = prefs.ttsEngine;
  if (requested === 'kokoro' && kokoroBase) {
    const { createKokoroTts } = await import('./voice-engines/kokoro');
    tts = createKokoroTts(kokoroBase);
    ttsKind = 'kokoro';
  } else if (requested === 'elevenlabs' && elevenlabsApiKey) {
    const { createElevenLabsTts } = await import('./voice-engines/elevenlabs');
    tts = createElevenLabsTts({ apiKey: elevenlabsApiKey, voiceId: prefs.elevenlabsVoiceId });
    ttsKind = 'elevenlabs';
  } else if (requested === 'openai' && openaiApiKey) {
    const { createOpenAiTts } = await import('./voice-engines/openai');
    tts = createOpenAiTts({
      apiKey: openaiApiKey,
      voice: prefs.openaiVoice,
      model: prefs.openaiModel,
    });
    ttsKind = 'openai';
  } else if (requested === 'cartesia' && cartesiaApiKey) {
    const { createCartesiaTts } = await import('./voice-engines/cartesia');
    tts = createCartesiaTts({
      apiKey: cartesiaApiKey,
      voiceId: prefs.cartesiaVoiceId,
      model: prefs.cartesiaModel,
    });
    ttsKind = 'cartesia';
  } else {
    // Fallback: browser TTS. Always available client-side.
    const { createBrowserTts } = await import('./voice-engines/browser');
    tts = createBrowserTts();
    ttsKind = 'browser';
  }

  return { ctx, stt, tts, sttKind, ttsKind };
}
