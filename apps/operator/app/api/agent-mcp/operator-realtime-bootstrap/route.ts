/**
 * Realtime full-agent bootstrap.
 *
 * Mints a short-lived ephemeral session token (POST /v1/realtime/sessions)
 * server-side using the user's stored OpenAI key, and returns ONLY the
 * ephemeral token (`client_secret.value`, ~1-minute TTL) to the browser.
 *
 * The Realtime SDK refuses to use a regular OpenAI API key over WebRTC
 * from a browser context — it requires an ephemeral key. Shipping the
 * raw key would also leak it to anyone with devtools open.
 *
 * Returns 404 (with a small json error body) instead of throwing so the
 * client-side fallback to Whisper still kicks in cleanly.
 */

import { readOpenAiKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

const REALTIME_MODEL = 'gpt-4o-realtime-preview';

export async function GET() {
  const prefs = loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'openai-realtime') {
    return Response.json({ error: 'not-enabled' }, { status: 404 });
  }
  const apiKey = readOpenAiKey();
  if (!apiKey) return Response.json({ error: 'no-openai-key' }, { status: 404 });

  // Mint an ephemeral session token. Realtime SDK accepts this as `apiKey`
  // for browser WebRTC. The token is single-use-ish and expires in ~60s,
  // so a fresh fetch is required for every voice-mode toggle.
  let sessionRes: Response;
  try {
    sessionRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({ model: REALTIME_MODEL }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    return Response.json(
      { error: 'session-mint-failed', detail: err?.message ?? String(err) },
      { status: 502 },
    );
  }

  if (!sessionRes.ok) {
    const detail = await sessionRes.text().catch(() => '');
    return Response.json(
      { error: 'session-mint-rejected', status: sessionRes.status, detail: detail.slice(0, 400) },
      { status: 502 },
    );
  }

  const data = await sessionRes.json().catch(() => ({} as any));
  const ephemeral = data?.client_secret?.value;
  const expiresAt = data?.client_secret?.expires_at ?? data?.expires_at ?? null;
  if (typeof ephemeral !== 'string' || !ephemeral.startsWith('ek_')) {
    return Response.json(
      { error: 'session-mint-shape', detail: 'no client_secret.value in response' },
      { status: 502 },
    );
  }

  return Response.json({
    apiKey: ephemeral,
    expiresAt,
    model: REALTIME_MODEL,
  });
}
