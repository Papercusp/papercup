/**
 * Cartesia TTS adapter (cloud, BYO API key).
 *
 * Sub-100ms first-byte via WebSocket streaming. Sonic and Sonic-2
 * models. ~$0.05/1k chars (between OpenAI tts-1 and ElevenLabs Creator).
 *
 * Settings exposes API key entry alongside ElevenLabs / OpenAI; cost
 * tracking shares the same `tts-spend.json` file with a configurable
 * per-1k-char rate.
 */

import type { TtsEngine, SpeakOptions, VoiceListItem } from '../voice-engines';
import { playStream, type MsePlayer } from './elevenlabs-mse';

interface CartesiaConfig {
  apiKey: string;
  voiceId: string;
  model: 'sonic' | 'sonic-2';
}

const BASE = 'https://api.cartesia.ai';
const VERSION = '2024-06-10';

export function createCartesiaTts(cfg: CartesiaConfig): TtsEngine {
  let charsTotal = 0;
  let player: MsePlayer | null = null;
  let inflight: AbortController | null = null;

  return {
    kind: 'cartesia' as any,
    async health(): Promise<boolean> {
      try {
        const r = await fetch(`${BASE}/voices`, {
          headers: { 'X-API-Key': cfg.apiKey, 'Cartesia-Version': VERSION },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch { return false; }
    },
    async voices(): Promise<VoiceListItem[]> {
      try {
        const r = await fetch(`${BASE}/voices`, {
          headers: { 'X-API-Key': cfg.apiKey, 'Cartesia-Version': VERSION },
        });
        if (!r.ok) return [];
        const list: any[] = await r.json();
        return (Array.isArray(list) ? list : []).map((v) => ({
          id: v.id,
          name: v.name ?? v.id,
          lang: v.language ?? 'en',
        }));
      } catch { return []; }
    },
    async speak(text: string, opts?: SpeakOptions): Promise<void> {
      if (typeof window === 'undefined') return;
      await this.cancel();
      const controller = new AbortController();
      inflight = controller;
      try {
        const r = await fetch(`${BASE}/tts/bytes`, {
          method: 'POST',
          headers: {
            'X-API-Key': cfg.apiKey,
            'Cartesia-Version': VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model_id: cfg.model,
            transcript: text,
            voice: { mode: 'id', id: opts?.voice ?? cfg.voiceId },
            output_format: {
              container: 'mp3',
              encoding: 'mp3',
              sample_rate: 44100,
            },
            language: 'en',
          }),
          signal: controller.signal,
        });
        if (!r.ok || !r.body) return;
        const { recordSpend } = await import('../tts-spend');
        await recordSpend(text.length);
        charsTotal += text.length;

        player = playStream({
          body: r.body,
          mimeType: 'audio/mpeg',
          abortController: controller,
        });
        await player.done;
      } catch {
        /* aborted or transient */
      } finally {
        if (inflight === controller) inflight = null;
        player = null;
      }
    },
    async cancel(): Promise<void> {
      if (player) {
        try { player.cancel(); } catch {}
        player = null;
      }
      if (inflight) {
        try { inflight.abort(); } catch {}
        inflight = null;
      }
    },
    charsSpoken(): number {
      return charsTotal;
    },
  };
}

/** Connection-test helper (settings UI). */
export async function testCartesiaConnection(apiKey: string): Promise<
  | { ok: true; voicesAvailable: number }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(`${BASE}/voices`, {
      headers: { 'X-API-Key': apiKey, 'Cartesia-Version': VERSION },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const list = await r.json();
    return { ok: true, voicesAvailable: Array.isArray(list) ? list.length : 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
