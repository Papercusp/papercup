/**
 * POST /api/agent-mcp/operator-stt — one-shot speech-to-text for non-browser
 * clients (the TUI's PTT path — voice-mode-tui-port-2026-06-05 D-006).
 *
 * Body: `{ audioBase64: string, format?: 'wav' | 'webm' }` → `{ ok, text }`.
 * The audio crosses the wire as base64 JSON because the TUI's IPC `sys:http`
 * bridge reassembles bodies as UTF-8 strings (binary-unsafe), and a remote
 * TUI can't reach this box's localhost voicemode service directly — the
 * operator proxies. Same upstream the browser PTT path POSTs WAV blobs to:
 * voicemode Whisper's OpenAI-compatible `/v1/audio/transcriptions`.
 * `auth: 'public'` like the sibling operator voice routes.
 */
import { defineTool } from '@papercusp/agent-mcp';

const VOICEMODE_URL = process.env.VOICEMODE_URL ?? 'http://localhost:2022';
/** PTT utterances are short; 25MB ≈ 13 min of 16k mono PCM16 — generous. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Smaller than a WAV header = nothing transcribable; reject early. */
const MIN_AUDIO_BYTES = 44;

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-stt',
  auth: 'public',
  async handler(req) {
    let body: { audioBase64?: unknown; format?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
      return Response.json({ ok: false, error: 'audioBase64 (string) required' }, { status: 400 });
    }
    const audio = Buffer.from(body.audioBase64, 'base64');
    if (audio.length < MIN_AUDIO_BYTES) {
      return Response.json({ ok: false, error: 'audio too short to transcribe' }, { status: 400 });
    }
    if (audio.length > MAX_AUDIO_BYTES) {
      return Response.json({ ok: false, error: 'audio exceeds the 25MB cap' }, { status: 413 });
    }
    const format = body.format === 'webm' ? 'webm' : 'wav';

    const fd = new FormData();
    fd.append(
      'file',
      new Blob([audio], { type: format === 'wav' ? 'audio/wav' : 'audio/webm' }),
      `audio.${format}`,
    );
    fd.append('model', 'whisper-1');

    let r: Response;
    try {
      r = await fetch(`${VOICEMODE_URL}/v1/audio/transcriptions`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      return Response.json(
        { ok: false, error: `whisper unreachable: ${(e as Error).message}` },
        { status: 502 },
      );
    }
    if (!r.ok) {
      return Response.json({ ok: false, error: `whisper ${r.status}` }, { status: 502 });
    }
    const out = (await r.json().catch(() => null)) as { text?: string } | null;
    return Response.json({ ok: true, text: (out?.text ?? '').trim() });
  },
});
