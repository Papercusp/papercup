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

import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

const DEFAULT_CLIENT_PREFS: VoicePrefs = {
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakModeFlips: false,
  speakCadenceStatus: false,
  speakNudges: true,
  wakeWordIntents: true,
  speakOpenCards: true,
  cardAnsweringEnabled: true,
  silenceNudgeGraceSecs: 30,
  speakSessionHandoff: true,
  proactiveTicksEnabled: true,
  maxConsecutiveContinues: 5,
  maxContinueChainSecs: 300,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  audienceMode: 'engineer' as const,
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

type Listener = (prefs: VoicePrefs) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try { l(cache); } catch { /* ignore */ }
  }
}

export function loadVoicePrefsClient(): VoicePrefs {
  if (!hydrated && typeof window !== 'undefined') {
    // Lazy fetch on first access; subsequent reads use the cache.
    hydrated = true;
    void fetch('/api/agent-mcp/operator-voice-prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (p) { cache = p as VoicePrefs; notify(); } })
      .catch(() => {});
  }
  return cache;
}

export function setVoicePrefsClient(next: VoicePrefs): void {
  cache = next;
  notify();
}

export async function refreshVoicePrefsClient(): Promise<VoicePrefs> {
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (r.ok) {
      cache = (await r.json()) as VoicePrefs;
      notify();
    }
  } catch { /* keep last */ }
  return cache;
}

/**
 * Subscribe to prefs changes. Fires on hydrate, on setVoicePrefsClient,
 * and on refreshVoicePrefsClient. Returns an unsubscribe.
 *
 * Consumers that need live updates (e.g. the voice-card router's
 * cardAnsweringEnabled gate) should subscribe; passive readers can
 * stay on the synchronous loadVoicePrefsClient() snapshot.
 */
export function subscribeVoicePrefsClient(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
