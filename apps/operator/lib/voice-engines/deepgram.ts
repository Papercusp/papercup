/**
 * Deepgram STT adapter (cloud, BYO API key).
 *
 * Streaming WebSocket-based recognition. Sub-300ms first-byte; supports
 * word-level interim results. Pricing: ~$0.0043/minute (Nova-2).
 *
 * Used as an alternative to Web Speech for users who want a real cloud
 * STT without going through browser-vendor speech APIs. The Voicemode
 * Whisper local path remains the privacy-default; Deepgram is opt-in
 * with the same one-time leak warning gate as Web Speech.
 *
 * v4 adds Deepgram as a SECOND cloud STT option (Web Speech remains
 * available). The settings UI surfaces both.
 */

import type { SttEngine } from '../voice-engines';

const STREAM_URL = 'wss://api.deepgram.com/v1/listen';
const HEALTH_URL = 'https://api.deepgram.com/v1/projects';

export interface DeepgramConfig {
  apiKey: string;
  /** Model. Defaults to nova-2 (fast + accurate balance). */
  model?: 'nova-2' | 'nova-3' | 'enhanced' | 'base';
  /** Language. Defaults to 'en'. */
  language?: string;
}

export function createDeepgramStt(cfg: DeepgramConfig): SttEngine {
  return {
    kind: 'deepgram',
    async health(): Promise<boolean> {
      try {
        const r = await fetch(HEALTH_URL, {
          headers: { 'Authorization': `Token ${cfg.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch { return false; }
    },
  };
}

export interface DeepgramStreamOptions {
  apiKey: string;
  model?: string;
  language?: string;
  /** Called with each partial transcript chunk. */
  onPartial?: (text: string) => void;
  /** Called when a final (utterance-end) transcript is available. */
  onFinal: (text: string) => void;
  /** Soft-cap crossed (called at most once per UTC day per process). */
  onSoftCap?: (todayUsd: number) => void;
  /** Hard-cap crossed — stream auto-stops; caller should surface a toast. */
  onHardCap?: (todayUsd: number) => void;
}

export interface DeepgramStream {
  /** Stop the stream + close the mic. Idempotent. */
  stop(): void;
}

/**
 * Open a Deepgram streaming connection + start sending audio frames
 * from the user's mic. Returns a `stop()` handle.
 *
 * Implementation mirrors stt-voicemode.ts: MediaRecorder captures audio
 * in 250ms chunks and ships them over a WebSocket. Deepgram emits
 * `is_final: true` markers for end-of-utterance transcripts.
 */
export async function startDeepgramStream(opts: DeepgramStreamOptions): Promise<DeepgramStream> {
  if (typeof window === 'undefined') throw new Error('not in browser');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000 },
  });

  // Build query string explicitly (URLSearchParams doesn't escape '+' the way DG wants for nested params).
  const url = new URL(STREAM_URL);
  url.searchParams.set('model', opts.model ?? 'nova-2');
  url.searchParams.set('language', opts.language ?? 'en');
  url.searchParams.set('encoding', 'opus');
  url.searchParams.set('sample_rate', '16000');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '700');         // ms of silence → utterance end
  url.searchParams.set('utterance_end_ms', '1000');
  // Authorization is sent via Sec-WebSocket-Protocol per Deepgram convention.
  const ws = new WebSocket(url.toString(), ['token', opts.apiKey]);

  let stopped = false;
  let recorder: MediaRecorder | null = null;
  let lastFlushedAt = Date.now();

  // Heartbeat-flush minutes used every 60s so a long-running mic still
  // reports incrementally + we hit cap-trip before the user stops.
  const heartbeat = window.setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const minutes = (now - lastFlushedAt) / 60000;
    if (minutes < 0.05) return;
    lastFlushedAt = now;
    void postSttSpend(minutes);
  }, 60000);

  async function postSttSpend(minutes: number): Promise<void> {
    try {
      const r = await fetch('/api/agent-mcp/operator-stt-spend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      if (!r.ok) return;
      const sig = await r.json() as { todayUsd?: number; fireSoftCap?: boolean; hardCapTripped?: boolean };
      if (sig.fireSoftCap) opts.onSoftCap?.(sig.todayUsd ?? 0);
      if (sig.hardCapTripped) {
        opts.onHardCap?.(sig.todayUsd ?? 0);
        // Self-stop: no further audio billed.
        try { window.clearInterval(heartbeat); } catch {}
        stopped = true;
        try { recorder?.stop(); } catch {}
        try { ws.close(1000, 'hard-cap'); } catch {}
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      }
    } catch { /* network-flaky; we lose this slice but the next heartbeat catches up */ }
  }

  ws.addEventListener('open', () => {
    if (stopped) return;
    try {
      recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = async (e) => {
      if (stopped || !e.data || e.data.size === 0) return;
      try {
        const buf = await e.data.arrayBuffer();
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      } catch { /* socket closed */ }
    };
    recorder.start(250);
  });

  ws.addEventListener('message', (ev) => {
    if (stopped) return;
    try {
      const msg = JSON.parse(ev.data as string);
      const alt = msg?.channel?.alternatives?.[0];
      const text: string = alt?.transcript ?? '';
      if (!text) return;
      if (msg.is_final) opts.onFinal(text);
      else opts.onPartial?.(text);
    } catch { /* ignore non-JSON keepalives */ }
  });

  ws.addEventListener('error', () => { /* surface upstream via close */ });

  return {
    stop(): void {
      stopped = true;
      try { window.clearInterval(heartbeat); } catch {}
      const tailMinutes = (Date.now() - lastFlushedAt) / 60000;
      if (tailMinutes >= 0.01) void postSttSpend(tailMinutes);
      try { recorder?.stop(); } catch {}
      try { ws.close(1000, 'client-stop'); } catch {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    },
  };
}

/** Connection-test helper (settings UI). Returns project count on success. */
export async function testDeepgramConnection(apiKey: string): Promise<
  | { ok: true; projects: number }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(HEALTH_URL, {
      headers: { 'Authorization': `Token ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    return { ok: true, projects: (body?.projects ?? []).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
