/**
 * Voicemode Whisper STT adapter.
 *
 * Voicemode exposes an OpenAI-compatible /v1/audio/transcriptions
 * endpoint. The chrome's voice-mode.ts captures audio frames via the
 * Web Audio API and POSTs them here for transcription.
 *
 * Phase 1c ships the engine surface; the streaming implementation
 * (audio capture loop, VAD chunks) lives in voice-mode.ts and consumes
 * this engine via the `health()` probe + a transcribe helper.
 */

import type { SttEngine } from '../voice-engines';

export function createVoicemodeWhisper(baseUrl: string): SttEngine {
  return {
    kind: 'voicemode',
    async health(): Promise<boolean> {
      try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch { return false; }
    },
    // Streaming transcription: caller drives audio frames via voice-mode.ts.
    // The actual capture loop lives there; this engine is the URL the
    // POSTs target.
  };
}

/** One-shot transcription helper. Called by voice-mode.ts on each finalized audio chunk. */
export async function transcribeChunk(baseUrl: string, audio: Blob): Promise<string> {
  const fd = new FormData();
  fd.append('file', audio, 'audio.webm');
  fd.append('model', 'whisper-1');
  const r = await fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: fd });
  if (!r.ok) return '';
  const body = await r.json();
  return body?.text ?? '';
}
