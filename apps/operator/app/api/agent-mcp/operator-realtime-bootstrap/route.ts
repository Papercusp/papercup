/**
 * Realtime full-agent bootstrap.
 *
 * Mints a short-lived ephemeral session token server-side using the
 * user's stored OpenAI API key, and returns ONLY the ephemeral token
 * (`ek_…`, ~1-minute TTL) to the browser.
 *
 * IMPORTANT: this hits the **GA** endpoint POST /v1/realtime/client_secrets
 * (NOT the beta /v1/realtime/sessions). The @openai/agents-realtime SDK's
 * WebRTC transport POSTs the SDP offer to /v1/realtime/calls (also GA),
 * which rejects beta-minted tokens with:
 *   "API version mismatch. You cannot start a Realtime GA session with a
 *    beta client secret. … please create a client secret using the
 *    /v1/realtime/client_secrets endpoint."
 * If you see that error, the bootstrap is the wrong shape.
 *
 * Default model `gpt-realtime-1.5` matches the SDK's
 * DEFAULT_OPENAI_REALTIME_MODEL constant — change it here AND in the
 * SDK's session.connect() options if you want a different one.
 *
 * Returns json error bodies (not throws) so the client-side fallback to
 * Whisper still kicks in cleanly when the mint fails.
 */

import { readOpenAiKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

const REALTIME_MODEL = 'gpt-realtime-1.5';

export async function GET() {
  const prefs = await loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'openai-realtime') {
    return Response.json({ error: 'not-enabled' }, { status: 404 });
  }
  const apiKey = await readOpenAiKey();
  if (!apiKey) return Response.json({ error: 'no-openai-key' }, { status: 404 });

  let mintRes: Response;
  try {
    mintRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: { type: 'realtime', model: REALTIME_MODEL },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    return Response.json(
      { error: 'client-secret-mint-failed', detail: err?.message ?? String(err) },
      { status: 502 },
    );
  }

  if (!mintRes.ok) {
    const detail = await mintRes.text().catch(() => '');
    return Response.json(
      { error: 'client-secret-mint-rejected', status: mintRes.status, detail: detail.slice(0, 400) },
      { status: 502 },
    );
  }

  const data = await mintRes.json().catch(() => ({} as any));
  // GA shape: { value: 'ek_…', expires_at: <unix>, session: {...} }
  const ephemeral = data?.value;
  const expiresAt = data?.expires_at ?? null;
  if (typeof ephemeral !== 'string' || !ephemeral.startsWith('ek_')) {
    return Response.json(
      { error: 'client-secret-mint-shape', detail: 'no top-level value in response' },
      { status: 502 },
    );
  }

  return Response.json({
    apiKey: ephemeral,
    expiresAt,
    model: REALTIME_MODEL,
  });
}
