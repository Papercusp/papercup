/**
 * Voice preferences storage (Phase 1c of voice-mode plan v4).
 *
 * Source of truth: `<papercuspRoot>/system/operator/voice-prefs.json`.
 *
 * Schema covers:
 *   - 7 feature toggles (suggestion announcements, toasts, flips, etc.)
 *   - 3 engine selectors (sttEngine, ttsEngine, elevenlabsVoiceId)
 *   - 1 leak-warning consent record (webSpeechLeakAcked)
 *   - 1 hardware-suggestion ack (kokoroSlowSuggestionDismissed)
 *   - Internal state: nudge dedup last-spoken-at per kind
 *
 * voice-prefs.json is on the snapshot private list (per v4 §10) — does
 * not travel when forking a workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';

export type SttEngineKind = 'voicemode' | 'webspeech' | 'deepgram' | 'off';
export type TtsEngineKind = 'kokoro' | 'browser' | 'elevenlabs' | 'openai' | 'cartesia';
/**
 * Full-agent engine — bundles STT + LLM + TTS + intent dispatch in one
 * connection. When set to anything other than 'off', it OVERRIDES
 * sttEngine + ttsEngine: voice-mode.ts uses the full-agent transport
 * and bypasses the per-utterance pipeline.
 */
export type FullAgentEngineKind =
  | 'off'
  | 'openai-realtime'
  | 'gemini-live'
  | 'elevenlabs-conversational'  // legacy alias of elevenlabs-conv
  | 'elevenlabs-conv';            // primary in v5+ (Conv AI agent platform)

export interface VoicePrefs {
  // Feature toggles (defaults reflect v4 §3.2)
  speakSuggestions: boolean;        // ON
  speakBackgroundToasts: boolean;   // ON
  speakReceivingFlips: boolean;     // OFF — chatty
  speakEscalations: boolean;        // ON — significant
  speakCadenceStatus: boolean;      // OFF — chatty
  speakNudges: boolean;             // ON
  wakeWordIntents: boolean;         // ON

  // Engine selection
  sttEngine: SttEngineKind;
  ttsEngine: TtsEngineKind;
  /** Full-agent engine. When set to anything but 'off', overrides STT + TTS. */
  fullAgentEngine: FullAgentEngineKind;
  /**
   * Wake-word engine. 'off' = transcribe-everything-then-string-match (current default);
   * 'porcupine' = Picovoice Porcupine (commercial, free for dev, BYO key);
   * 'openwakeword' = openWakeWord (Apache 2.0, no key, custom-trainable).
   */
  wakeWordEngine: 'off' | 'porcupine' | 'openwakeword';
  /** Wake-word keyword. Each engine has its own model name space. */
  porcupineKeyword: 'Computer' | 'Jarvis' | 'Bumblebee' | 'Picovoice' | 'Porcupine' | 'Alexa' | 'Hey Google' | 'Hey Siri' | 'Okay Google' | 'Terminator' | 'Americano' | 'Blueberry' | 'Grapefruit' | 'Grasshopper';
  openwakewordKeyword: 'alexa' | 'hey_jarvis' | 'hey_mycroft' | 'hey_rhasspy' | 'ok_nabu' | 'weather' | 'timer';
  /**
   * Noise suppression engine for the mic input.
   * 'browser' = built-in WebRTC noiseSuppression (free, default);
   * 'rnnoise' = Jitsi RNNoise WASM (BSD, stronger);
   * 'koala' = Picovoice Koala (commercial, BYO key);
   * 'off' = no suppression.
   */
  noiseSuppressionEngine: 'off' | 'browser' | 'rnnoise' | 'koala';
  elevenlabsVoiceId: string;        // default Adam preset
  openaiVoice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  openaiModel: 'tts-1' | 'tts-1-hd';
  cartesiaVoiceId: string;
  cartesiaModel: 'sonic' | 'sonic-2';

  /**
   * ElevenLabs Conversational AI agent ID (`agent_…`). Required when
   * fullAgentEngine === 'elevenlabs-conv'. Set in /settings/voice;
   * separate from the ElevenLabs API key (which lives in
   * voice-credentials and is shared with the TTS path).
   */
  elevenLabsAgentId: string;
  /**
   * Auto-open the operator panel when delegate_to_claude completes
   * with a result that should be shown.
   */
  voicePanelAutoOpen: boolean;
  /**
   * Cached scan / verbatim readout cap. Voice speaks fullText if its
   * word count is ≤ this; otherwise speaks gist + 'details in panel'.
   * Default 120 words ≈ 60s of speech at standard rates.
   */
  voiceMaxSpokenWords: number;

  // One-time consents
  webSpeechLeakAcked: boolean;
  kokoroSlowSuggestionDismissed: boolean;

  // Internal: persisted nudge dedup last-spoken-at per kind
  nudgeDedup: {
    budget:  { lastSpokenAt: string | null };
    breaker: { lastSpokenAt: string | null };
    pause:   { lastSpokenAt: string | null };
  };
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakReceivingFlips: false,
  speakEscalations: true,
  speakCadenceStatus: false,
  speakNudges: true,
  wakeWordIntents: true,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  fullAgentEngine: 'off',
  wakeWordEngine: 'off',
  porcupineKeyword: 'Computer',
  openwakewordKeyword: 'hey_jarvis',
  noiseSuppressionEngine: 'browser',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Adam preset
  openaiVoice: 'nova',
  openaiModel: 'tts-1',
  cartesiaVoiceId: 'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop Man, common preset
  cartesiaModel: 'sonic-2',
  elevenLabsAgentId: '',
  voicePanelAutoOpen: true,
  voiceMaxSpokenWords: 120,
  webSpeechLeakAcked: false,
  kokoroSlowSuggestionDismissed: false,
  nudgeDedup: {
    budget:  { lastSpokenAt: null },
    breaker: { lastSpokenAt: null },
    pause:   { lastSpokenAt: null },
  },
};

function PATH() {
  return papercuspPath('system', 'operator', 'voice-prefs.json');
}

export function loadVoicePrefs(): VoicePrefs {
  const path = PATH();
  if (!existsSync(path)) return { ...DEFAULT_VOICE_PREFS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<VoicePrefs>;
    // Merge with defaults so newly-added fields don't break old files.
    return mergePrefs(DEFAULT_VOICE_PREFS, raw);
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export function saveVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const current = loadVoicePrefs();
  const next = mergePrefs(current, patch);
  const path = PATH();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

function mergePrefs(base: VoicePrefs, patch: Partial<VoicePrefs>): VoicePrefs {
  const out: VoicePrefs = { ...base, ...patch };
  // Deep-merge nudgeDedup so partial patches don't drop unwritten kinds.
  if (patch.nudgeDedup) {
    out.nudgeDedup = {
      budget:  { ...base.nudgeDedup.budget,  ...patch.nudgeDedup.budget  },
      breaker: { ...base.nudgeDedup.breaker, ...patch.nudgeDedup.breaker },
      pause:   { ...base.nudgeDedup.pause,   ...patch.nudgeDedup.pause   },
    };
  } else {
    out.nudgeDedup = {
      budget:  { ...base.nudgeDedup.budget  },
      breaker: { ...base.nudgeDedup.breaker },
      pause:   { ...base.nudgeDedup.pause   },
    };
  }
  return out;
}
