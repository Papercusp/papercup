'use client';

/**
 * Voicemode whisper STT capture loop (final v4 wire-in).
 *
 * MediaRecorder-based loop that captures audio in fixed windows + POSTs
 * to Voicemode's `/v1/audio/transcriptions` (OpenAI-compatible). On
 * silence detection (RMS-based VAD), finalizes the chunk and emits a
 * transcript via the supplied callback.
 *
 * This is the local-only alternative to Web Speech. Per v4 §1.1, it's
 * the default STT engine when Voicemode whisper is reachable.
 *
 * Capture parameters (tuned for short utterances; v1.5 may make these
 * adaptive):
 *   - 16kHz mono webm/opus
 *   - VAD threshold: -45 dBFS
 *   - End-of-utterance silence: 700ms
 *   - Hard window cap: 30s (force-finalize to avoid runaway)
 */

import { transcribeChunk } from '../../../lib/voice-engines/whisper';

const VAD_THRESHOLD_DB = -45;
const SILENCE_END_MS = 700;
const HARD_WINDOW_MS = 30_000;

export interface WhisperListener {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
}

export interface WhisperCapture {
  /** Stop the loop + release the mic. Idempotent. */
  stop(): void;
}

/**
 * Start a Voicemode whisper capture loop. Resolves when permission is
 * granted + the loop is running. Throws if mic permission is denied or
 * MediaRecorder isn't available.
 */
export async function startWhisperCapture(
  baseUrl: string,
  listener: WhisperListener,
): Promise<WhisperCapture> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const timeData = new Uint8Array(analyser.fftSize);
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let lastVoiceAt = 0;
  let chunkStartedAt = 0;
  let stopped = false;
  let vadTimer: ReturnType<typeof setInterval> | null = null;

  const startChunk = () => {
    if (stopped) return;
    if (mediaRecorder?.state === 'recording') return;
    chunks = [];
    chunkStartedAt = Date.now();
    lastVoiceAt = chunkStartedAt;
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    } catch {
      // Fallback to default mime if the browser doesn't support our pick
      mediaRecorder = new MediaRecorder(stream);
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      if (chunks.length === 0) {
        startChunk();
        return;
      }
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType ?? 'audio/webm' });
      // Don't transcribe sub-second blobs (likely just noise).
      if (blob.size > 5_000) {
        try {
          const text = (await transcribeChunk(baseUrl, blob)).trim();
          if (text.length > 1) listener.onFinal(text);
        } catch {
          /* network blip or whisper down — skip this chunk */
        }
      }
      if (!stopped) startChunk();
    };
    mediaRecorder.start();
  };

  const tickVad = () => {
    if (stopped) return;
    if (mediaRecorder?.state !== 'recording') return;
    analyser.getByteTimeDomainData(timeData);
    // Compute RMS in dBFS.
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -100;
    const now = Date.now();
    if (dbfs > VAD_THRESHOLD_DB) {
      lastVoiceAt = now;
    } else if (now - lastVoiceAt > SILENCE_END_MS && now - chunkStartedAt > 1500) {
      // Finalize on silence (with a 1.5s minimum chunk floor to avoid
      // false-positive end-of-utterance from initial mic warmup).
      try { mediaRecorder.stop(); } catch { /* ignore */ }
      return;
    }
    if (now - chunkStartedAt > HARD_WINDOW_MS) {
      // Force-finalize on hard cap.
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
  };

  vadTimer = setInterval(tickVad, 100);
  startChunk();

  return {
    stop(): void {
      stopped = true;
      if (vadTimer) clearInterval(vadTimer);
      vadTimer = null;
      try { mediaRecorder?.stop(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { void ctx.close(); } catch { /* ignore */ }
    },
  };
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  // Voicemode/Whisper accepts webm/opus, mp4/aac, ogg/opus, wav.
  // Try webm/opus first (best Chrome/Firefox support), fall back.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return '';
}
