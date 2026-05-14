'use client';

/**
 * Client-side voice-prefs cache.
 *
 * The server-side `voice-prefs.ts` reads the filesystem directly and
 * can't run in the browser. Client surfaces (toasts, panel commands)
 * use this cache, kept in sync with the API.
 *
 * The cache hydrates on first read and refreshes whenever
 * /api/agent-mcp/operator-voice-prefs is PUT (settings page exposes
 * `setVoicePrefsClient` for that path).
 */

import type { VoicePrefs } from '../../../lib/voice-prefs';

const DEFAULT_CLIENT_PREFS: VoicePrefs = {
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakReceivingFlips: false,
  speakEscalations: true,
  speakCadenceStatus: false,
  speakNudges: true,
  wakeWordIntents: true,
  speakOpenCards: true,
  cardAnsweringEnabled: true,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  webSpeechLeakAcked: false,
  kokoroSlowSuggestionDismissed: false,
  nudgeDedup: {
    budget:  { lastSpokenAt: null },
    breaker: { lastSpokenAt: null },
    pause:   { lastSpokenAt: null },
  },
};

let cache: VoicePrefs = { ...DEFAULT_CLIENT_PREFS };
let hydrated = false;

export function loadVoicePrefsClient(): VoicePrefs {
  if (!hydrated && typeof window !== 'undefined') {
    // Lazy fetch on first access; subsequent reads use the cache.
    hydrated = true;
    void fetch('/api/agent-mcp/operator-voice-prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (p) cache = p as VoicePrefs; })
      .catch(() => {});
  }
  return cache;
}

export function setVoicePrefsClient(next: VoicePrefs): void {
  cache = next;
}

export async function refreshVoicePrefsClient(): Promise<VoicePrefs> {
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (r.ok) {
      cache = (await r.json()) as VoicePrefs;
    }
  } catch { /* keep last */ }
  return cache;
}
