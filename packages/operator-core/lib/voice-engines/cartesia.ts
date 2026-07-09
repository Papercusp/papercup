/**
 * Cartesia — settings connection-test helper.
 *
 * Server-side TTS synthesis for Cartesia lives in the shared registry
 * (endpoint-route/routes/agent-mcp/tts-synth.ts). This file keeps only the
 * key-validation probe used by /settings/voice. (The client `createCartesiaTts`
 * MSE adapter was part of the dead `detectEngines` framework — removed
 * 2026-07-09, WI-3448.)
 */

const BASE = 'https://api.cartesia.ai';
const VERSION = '2024-06-10';

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
