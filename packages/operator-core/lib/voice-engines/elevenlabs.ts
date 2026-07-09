/**
 * ElevenLabs — settings connection-test helper.
 *
 * Server-side TTS synthesis for ElevenLabs lives in the shared registry
 * (endpoint-route/routes/agent-mcp/tts-synth.ts). This file keeps only the
 * key-validation probe used by /settings/voice. (The client `createElevenLabsTts`
 * MSE adapter was part of the dead `detectEngines` framework — removed
 * 2026-07-09, WI-3448.)
 *
 * The test hits `/v1/user` (not `/v1/voices`) — the canonical key-validation
 * endpoint, which also returns subscription tier + character usage for display.
 */

const BASE = 'https://api.elevenlabs.io/v1';

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
