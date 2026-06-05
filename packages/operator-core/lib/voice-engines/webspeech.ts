/**
 * Web Speech API STT adapter (browser-native, off by default).
 *
 * Selecting this engine in /settings/voice requires confirming the
 * one-time leak warning (audio leaves the machine to Google/Microsoft).
 *
 * Phase 1c ships the engine surface; the actual SpeechRecognition wiring
 * lives in voice-mode.ts which consumes this engine's `health()` and
 * uses the browser's native SpeechRecognition / webkitSpeechRecognition.
 */

import type { SttEngine } from '../voice-engines';

export function createWebSpeechStt(): SttEngine {
  return {
    kind: 'webspeech',
    async health(): Promise<boolean> {
      if (typeof window === 'undefined') return false;
      const w = window as any;
      return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
    },
  };
}
