/**
 * OpenAI TTS adapter (cloud, BYO API key).
 *
 * 6 preset voices: alloy, echo, fable, onyx, nova, shimmer.
 * Models: tts-1 (faster, cheaper) / tts-1-hd (better quality).
 *
 * Pricing (as of v4 plan): tts-1 ≈ $15/1M chars, tts-1-hd ≈ $30/1M chars.
 * Settings page exposes a per-1k-char rate (default $0.015 for tts-1)
 * via the same tts-spend.json schema ElevenLabs uses.
 *
 * Streaming: OpenAI's `/v1/audio/speech` returns the full clip in one
 * response (no chunked streaming endpoint as of model `tts-1`). We
 * buffer-then-play via `<audio>+blob`. First-byte latency is dominated
 * by network round-trip + model inference (~300-500ms).
 */

import type { TtsEngine, SpeakOptions, VoiceListItem } from '../voice-engines';
import { awaitAbort } from './cancel-race';

interface OpenAiConfig {
  apiKey: string;
  voice: string;       // alloy | echo | fable | onyx | nova | shimmer
  model: 'tts-1' | 'tts-1-hd';
}

const DEFAULT_VOICE = 'nova';
const VOICES: VoiceListItem[] = [
  { id: 'alloy',   name: 'Alloy',   lang: 'en' },
  { id: 'echo',    name: 'Echo',    lang: 'en' },
  { id: 'fable',   name: 'Fable',   lang: 'en' },
  { id: 'onyx',    name: 'Onyx',    lang: 'en' },
  { id: 'nova',    name: 'Nova',    lang: 'en' },
  { id: 'shimmer', name: 'Shimmer', lang: 'en' },
];

const BASE = 'https://api.openai.com/v1';

export function createOpenAiTts(cfg: OpenAiConfig): TtsEngine {
  let charsTotal = 0;
  let inflight: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;

  return {
    kind: 'openai' as any,        // engine kind enum stays kokoro|browser|elevenlabs|openai (extended below)
    async health(): Promise<boolean> {
      try {
        const r = await fetch(`${BASE}/models/${cfg.model}`, {
          headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch { return false; }
    },
    async voices(): Promise<VoiceListItem[]> {
      // OpenAI's voices are a fixed preset list, not exposed via API.
      return VOICES;
    },
    async speak(text: string, opts?: SpeakOptions): Promise<void> {
      if (typeof window === 'undefined') return;
      await this.cancel();
      const controller = new AbortController();
      inflight = controller;
      const voice = opts?.voice ?? cfg.voice ?? DEFAULT_VOICE;
      try {
        const r = await fetch(`${BASE}/audio/speech`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.apiKey}`,
            'content-type': 'application/json',
            'accept': 'audio/mpeg',
          },
          body: JSON.stringify({
            model: cfg.model,
            input: text,
            voice,
            speed: opts?.rate ?? 1,
            response_format: 'mp3',
          }),
          signal: controller.signal,
        });
        if (!r.ok) return;

        const { recordSpend } = await import('../tts-spend');
        await recordSpend(text.length);
        charsTotal += text.length;

        const blob = await r.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.addEventListener('ended', () => URL.revokeObjectURL(url));
        audio.addEventListener('error', () => URL.revokeObjectURL(url));
        await audio.play().catch(() => {});
      } catch {
        /* aborted or transient */
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

/** Connection-test helper. Returns model availability + raw key validity. */
export async function testOpenAiConnection(apiKey: string): Promise<
  | { ok: true; models: string[] }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    const ids: string[] = (body?.data ?? []).map((m: any) => m.id).filter(Boolean);
    return { ok: true, models: ids.filter((id) => id.startsWith('tts-')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
