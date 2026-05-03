/**
 * ElevenLabs TTS adapter (cloud, BYO API key).
 *
 * Uses Turbo v2.5 streaming via MediaSource Extensions for sub-400ms
 * first-byte. Cost tracking writes to tts-spend.json after each
 * `speak()` call.
 *
 * Connection test (in settings) hits `/v1/user` (not `/v1/voices`) —
 * canonical key-validation endpoint that also returns subscription
 * tier for display.
 */

import type { TtsEngine, SpeakOptions, VoiceListItem } from '../voice-engines';
import { playStream, type MsePlayer } from './elevenlabs-mse';

interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
}

const BASE = 'https://api.elevenlabs.io/v1';

export function createElevenLabsTts(cfg: ElevenLabsConfig): TtsEngine {
  let charsTotal = 0;
  let player: MsePlayer | null = null;
  let inflight: AbortController | null = null;

  return {
    kind: 'elevenlabs',
    async health(): Promise<boolean> {
      try {
        const r = await fetch(`${BASE}/user`, {
          headers: { 'xi-api-key': cfg.apiKey },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch { return false; }
    },
    async voices(): Promise<VoiceListItem[]> {
      try {
        const r = await fetch(`${BASE}/voices`, {
          headers: { 'xi-api-key': cfg.apiKey },
        });
        if (!r.ok) return [];
        const body = await r.json();
        const list: any[] = body?.voices ?? [];
        return list.map((v) => ({ id: v.voice_id, name: v.name, lang: v.labels?.language ?? 'en' }));
      } catch { return []; }
    },
    async speak(text: string, opts?: SpeakOptions): Promise<void> {
      if (typeof window === 'undefined') return;
      await this.cancel();
      const voiceId = opts?.voice ?? cfg.voiceId;
      const controller = new AbortController();
      inflight = controller;
      try {
        const r = await fetch(`${BASE}/text-to-speech/${voiceId}/stream`, {
          method: 'POST',
          headers: {
            'xi-api-key': cfg.apiKey,
            'content-type': 'application/json',
            'accept': 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: controller.signal,
        });
        if (!r.ok || !r.body) return;
        // Lazy-import the spend recorder so this adapter stays
        // tree-shakeable from non-server contexts.
        const { recordSpend } = await import('../tts-spend');
        const update = recordSpend(text.length);
        charsTotal += text.length;

        player = playStream({
          body: r.body,
          mimeType: 'audio/mpeg',
          abortController: controller,
        });

        // Cap-trip side-effects: callers (voice-mode.ts) read these via
        // `readSpend()` after the speak resolves and dispatch toasts.
        // This adapter just records; surfacing toasts isn't its job.
        void update;

        await player.done;
      } catch {
        /* aborted or transient; outer failure-counter handles repeated breakage */
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

/** Connection-test helper used by /settings/voice. Returns subscription tier on success. */
export async function testElevenLabsConnection(apiKey: string): Promise<
  | { ok: true; tier: string; characterCount: number; characterLimit: number; email: string | null }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(`${BASE}/user`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    const sub = body?.subscription ?? {};
    return {
      ok: true,
      tier: sub.tier ?? 'unknown',
      characterCount: sub.character_count ?? 0,
      characterLimit: sub.character_limit ?? 0,
      email: body?.email ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
