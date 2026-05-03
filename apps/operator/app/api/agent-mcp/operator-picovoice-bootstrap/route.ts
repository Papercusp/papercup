/**
 * Picovoice access-key bootstrap.
 *
 * Hands the user's Picovoice key to the browser when porcupine or
 * koala is enabled. The Porcupine/Koala WASM workers run client-side
 * and need the access key to validate.
 */

import { readPicovoiceKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const prefs = loadVoicePrefs();
  const wantsPorcupine = prefs.wakeWordEngine === 'porcupine';
  const wantsKoala = prefs.noiseSuppressionEngine === 'koala';
  if (!wantsPorcupine && !wantsKoala) {
    return new Response('not-enabled', { status: 404 });
  }
  const apiKey = readPicovoiceKey();
  if (!apiKey) return new Response('no-key', { status: 404 });
  return Response.json({ apiKey });
}
