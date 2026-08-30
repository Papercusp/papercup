'use client';

/**
 * Voicemode whisper STT capture loop — Silero VAD edition.
 *
 * Was: hand-rolled RMS+dBFS VAD with a 100ms timer, MediaRecorder
 * encoding opus chunks, false-positive-prone on keyboard/breathing/fan.
 *
 * Now: `@ricky0123/vad-web` Silero ONNX VAD. Speech detection uses an
 * actual neural model trained on speech vs. non-speech. `onSpeechEnd`
 * delivers the utterance audio as Float32Array @ 16kHz, which we wrap
 * as a WAV blob and ship to whisper.
 *
 * Wins:
 *   - 3-4× fewer false positives on background noise
 *   - Cleaner utterance boundaries (no truncated starts)
 *   - ~50 lines of code deleted from this file
 *   - Same `startWhisperCapture(baseUrl, listener)` interface — drop-in
 *     replacement for callers (voice-mode.ts).
 */

import { MicVAD } from '@ricky0123/vad-web';
import { transcribeChunk } from '@papercusp/operator-core/lib/voice-engines/whisper';
import { f32ToWav } from './f32-to-wav';
import { captureWindowEndingAt, type CaptureWindow } from './capture-window';

export interface WhisperListener {
  onPartial?: (text: string) => void;
  /**
   * `capture` is the WALL-CLOCK span the audio occupies — see capture-window.ts.
   * The self-echo guard (WI-954890) tests THIS, not the arrival time.
   */
  onFinal: (text: string, capture: CaptureWindow) => void;
}

// Silero VAD framing. vad-web picks the frame size from the model
// (real-time-vad.js: `model === 'v5' ? 512 : 1536` samples @16kHz), so the
// millisecond values below are DERIVED from the frame counts we configure
// rather than restated in a comment — the old "~500ms" / "~250ms" notes were
// left over from the 1536-sample v4 default and were both wrong by ~2×.
const VAD_MODEL = 'v5' as const;
const VAD_FRAME_SAMPLES = 512; // v5 @ 16kHz → 32ms per frame
const VAD_SAMPLE_RATE = 16_000;
const MS_PER_VAD_FRAME = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000; // 32ms
const MIN_SPEECH_FRAMES = 4; // 128ms minimum to count as speech
const REDEMPTION_FRAMES = 8; // 256ms of silence before ending
const REDEMPTION_MS = REDEMPTION_FRAMES * MS_PER_VAD_FRAME;

export interface WhisperCapture {
  /** Stop the loop + release the mic. Idempotent. */
  stop(): void;
}


export async function startWhisperCapture(
  baseUrl: string,
  listener: WhisperListener,
): Promise<WhisperCapture> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const vad = await MicVAD.new({
    model: VAD_MODEL,            // Silero v5 — more accurate than legacy
    // Pin asset paths to absolute origin URLs so the loader resolves the
    // ONNX model + worklet from /silero_vad_v5.onnx and /vad.worklet…
    // regardless of the current page's path. Default `./` resolution
    // breaks on nested routes like /settings/voice → /settings/silero…
    baseAssetPath: '/',
    // ORT wasm/mjs lives at /vad-runtime/ — under Vite, importing .mjs from
    // publicDir root throws "should not be imported from source code".
    // setup-vad-runtime.sh mirrors the files into public/vad-runtime/.
    onnxWASMBasePath: '/vad-runtime/',
    positiveSpeechThreshold: 0.6, // raise = stricter (fewer false positives)
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: MIN_SPEECH_FRAMES,
    redemptionFrames: REDEMPTION_FRAMES,
    onSpeechEnd: async (audio: Float32Array) => {
      // WALL-CLOCK SPAN OF THIS AUDIO (WI-954890), captured BEFORE the await —
      // whisper's own latency (measured floor ~827ms on the shipped local
      // server) must not leak into the window, which is the exact mistake the
      // old dispatch-time cooldown made. `onSpeechEnd` fires only after the
      // redemption silence, so step back over it; the sample count gives the
      // duration. Landing early is the safe direction.
      const capture = captureWindowEndingAt(
        Date.now() - REDEMPTION_MS,
        (audio.length / VAD_SAMPLE_RATE) * 1000,
      );
      try {
        const blob = f32ToWav(audio);
        if (blob.size < 5_000) return; // sub-second drop
        const text = (await transcribeChunk(baseUrl, blob)).trim();
        if (text.length > 1) listener.onFinal(text, capture);
      } catch {
        /* network blip or whisper down — drop this utterance */
      }
    },
    onVADMisfire: () => {
      /* speech started but was too short — silently drop */
    },
  });

  await vad.start();

  return {
    stop(): void {
      try { vad.pause(); } catch { /* ignore */ }
      try { vad.destroy(); } catch { /* ignore */ }
    },
  };
}
