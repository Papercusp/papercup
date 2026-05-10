/**
 * GET    /api/agent-mcp/operator-credentials       — return MASKED credentials
 * PUT    /api/agent-mcp/operator-credentials       — set/clear ElevenLabs key
 *   body: { elevenlabsApiKey?: string | null }
 *
 * Only ElevenLabs is supported in v4. The credentials.json file may
 * contain other plugin/service keys; this route only reads/writes
 * the ElevenLabs slice.
 *
 * GET masks the value (`sk_••••3c2a`) — never returns the raw key.
 * PUT preserves missing fields (don't have to re-enter every time).
 * Pass `null` to clear.
 */

import { NextRequest } from 'next/server';
import {
  readElevenLabsKey,
  writeElevenLabsKey,
  readOpenAiKey,
  writeOpenAiKey,
  readCartesiaKey,
  writeCartesiaKey,
  readDeepgramKey,
  writeDeepgramKey,
  readPicovoiceKey,
  writePicovoiceKey,
  readGoogleKey,
  writeGoogleKey,
  maskKey,
} from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';

async function snapshot() {
  const e = await readElevenLabsKey();
  const o = await readOpenAiKey();
  const c = await readCartesiaKey();
  const d = await readDeepgramKey();
  const p = await readPicovoiceKey();
  const g = await readGoogleKey();
  return {
    elevenlabs: { apiKey: maskKey(e), configured: !!e },
    openai:     { apiKey: maskKey(o), configured: !!o },
    cartesia:   { apiKey: maskKey(c), configured: !!c },
    deepgram:   { apiKey: maskKey(d), configured: !!d },
    picovoice:  { apiKey: maskKey(p), configured: !!p },
    google:     { apiKey: maskKey(g), configured: !!g },
  };
}

export async function GET() {
  return Response.json(await snapshot());
}

export async function PUT(req: NextRequest) {
  let body: { elevenlabsApiKey?: unknown; openaiApiKey?: unknown; cartesiaApiKey?: unknown; deepgramApiKey?: unknown; picovoiceApiKey?: unknown; googleApiKey?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  // Preserve-missing semantics: only act on fields that are present.
  const setKey = async (
    field: keyof typeof body,
    write: (v: string | null) => Promise<void>,
  ): Promise<Response | null> => {
    if (!(field in body)) return null;
    const v = body[field];
    if (v === null) { await write(null); return null; }
    if (typeof v === 'string' && v.length > 0) { await write(v); return null; }
    return new Response(`${field} must be string or null`, { status: 400 });
  };
  for (const [field, writer] of [
    ['elevenlabsApiKey', writeElevenLabsKey],
    ['openaiApiKey',     writeOpenAiKey],
    ['cartesiaApiKey',   writeCartesiaKey],
    ['deepgramApiKey',   writeDeepgramKey],
    ['picovoiceApiKey',  writePicovoiceKey],
    ['googleApiKey',     writeGoogleKey],
  ] as const) {
    const err = await setKey(field, writer);
    if (err) return err;
  }
  return Response.json(await snapshot());
}
