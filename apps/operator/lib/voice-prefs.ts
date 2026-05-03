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

export type SttEngineKind = 'voicemode' | 'webspeech' | 'off';
export type TtsEngineKind = 'kokoro' | 'browser' | 'elevenlabs';

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
  elevenlabsVoiceId: string;        // default Adam preset

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
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Adam preset
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
