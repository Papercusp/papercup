/**
 * Browser TTS adapter (Web Speech API).
 *
 * Default fallback when Voicemode kokoro isn't reachable. Voice quality
 * varies by OS (mac good, win acceptable, linux rough). Zero-config,
 * zero-cost, instant first-byte.
 *
 * Chromium quirk: `getVoices()` returns `[]` on first call before
 * voices load. We listen for `voiceschanged` and re-fetch — settings
 * UI shows "Loading voices…" until the second call returns non-empty.
 */

import type { TtsEngine, SpeakOptions, VoiceListItem } from '../voice-engines';
import { flushBrowserSpeechSynthesis } from './cancel-race';

export function createBrowserTts(): TtsEngine {
  let charsTotal = 0;

  return {
    kind: 'browser',
    async health(): Promise<boolean> {
      return typeof window !== 'undefined' && !!window.speechSynthesis;
    },
    async voices(): Promise<VoiceListItem[]> {
      if (typeof window === 'undefined' || !window.speechSynthesis) return [];
      let list = window.speechSynthesis.getVoices();
      if (list.length === 0) {
        // Chromium async voice load — wait for the event once.
        await new Promise<void>((res) => {
          const handler = () => {
            window.speechSynthesis.removeEventListener('voiceschanged', handler);
            res();
          };
          window.speechSynthesis.addEventListener('voiceschanged', handler);
          // Safety cap — some browsers never fire.
          setTimeout(() => {
            window.speechSynthesis.removeEventListener('voiceschanged', handler);
            res();
          }, 1500);
        });
        list = window.speechSynthesis.getVoices();
      }
      return list.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
    },
    async speak(text: string, opts?: SpeakOptions): Promise<void> {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(text);
      if (opts?.rate !== undefined) u.rate = opts.rate;
      if (opts?.voice) {
        const voices = window.speechSynthesis.getVoices();
        const match = voices.find((v) => v.voiceURI === opts.voice || v.name === opts.voice);
        if (match) u.voice = match;
      }
      charsTotal += text.length;
      window.speechSynthesis.speak(u);
    },
    async cancel(): Promise<void> {
      await flushBrowserSpeechSynthesis();
    },
    charsSpoken(): number {
      return charsTotal;
    },
  };
}
