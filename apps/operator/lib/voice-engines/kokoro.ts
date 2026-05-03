/**
 * Kokoro TTS adapter (Voicemode local).
 *
 * Uses Voicemode's OpenAI-compatible `/v1/audio/speech` endpoint to
 * synthesize MP3 audio, decoded via the browser's `<audio>` element
 * with a blob URL. Voicemode runs the kokoro model server-side; we
 * just consume the audio.
 *
 * For Kokoro on a slow CPU (per v4 §1.2.8), the chrome times the first
 * `speak()` call's first-byte and surfaces a soft suggestion if it
 * exceeds 2000ms.
 */

import type { TtsEngine, SpeakOptions, VoiceListItem } from '../voice-engines';
import { awaitAbort } from './cancel-race';

const DEFAULT_VOICE = 'af_bella';

export function createKokoroTts(baseUrl: string): TtsEngine {
  let charsTotal = 0;
  let inflight: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;

  return {
    kind: 'kokoro',
    async health(): Promise<boolean> {
      try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch { return false; }
    },
    async voices(): Promise<VoiceListItem[]> {
      try {
        const r = await fetch(`${baseUrl}/v1/voices`);
        if (!r.ok) return [];
        const body = await r.json();
        // OpenAI-compatible: { data: [{ id, name, ... }] } or a bare array
        const list: any[] = Array.isArray(body) ? body : (body?.data ?? body?.voices ?? []);
        return list.map((v) => ({ id: v.id ?? v.name, name: v.name ?? v.id, lang: v.lang }));
      } catch { return []; }
    },
    async speak(text: string, opts?: SpeakOptions): Promise<void> {
      if (typeof window === 'undefined') return;
      // Cancel any in-flight speech first.
      await this.cancel();
      const controller = new AbortController();
      inflight = controller;
      try {
        const r = await fetch(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: text,
            voice: opts?.voice ?? DEFAULT_VOICE,
            response_format: 'mp3',
            speed: opts?.rate ?? 1,
          }),
          signal: controller.signal,
        });
        if (!r.ok || !r.body) return;
        // Buffer-then-play (kokoro returns the full clip in one response;
        // streaming MSE wiring isn't required for Voicemode's payload size).
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.addEventListener('ended', () => URL.revokeObjectURL(url));
        audio.addEventListener('error', () => URL.revokeObjectURL(url));
        await audio.play().catch(() => {});
        charsTotal += text.length;
      } catch {
        /* aborted or transient — caller's failure-counter handles repeated breakage */
      } finally {
        if (inflight === controller) inflight = null;
      }
    },
    async cancel(): Promise<void> {
      await awaitAbort(inflight);
      inflight = null;
      if (audio) {
        try { audio.pause(); } catch {}
        try { audio.src = ''; } catch {}
        audio = null;
      }
    },
    charsSpoken(): number {
      return charsTotal;
    },
  };
}
