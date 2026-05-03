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

function snapshot() {
  const e = readElevenLabsKey();
  const o = readOpenAiKey();
  const c = readCartesiaKey();
  const d = readDeepgramKey();
  const p = readPicovoiceKey();
  const g = readGoogleKey();
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
  return Response.json(snapshot());
}

export async function PUT(req: NextRequest) {
  let body: { elevenlabsApiKey?: unknown; openaiApiKey?: unknown; cartesiaApiKey?: unknown; deepgramApiKey?: unknown; picovoiceApiKey?: unknown; googleApiKey?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  // Preserve-missing semantics: only act on fields that are present.
  const setKey = (
    field: keyof typeof body,
    write: (v: string | null) => void,
  ): Response | null => {
    if (!(field in body)) return null;
    const v = body[field];
    if (v === null) { write(null); return null; }
    if (typeof v === 'string' && v.length > 0) { write(v); return null; }
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
    const err = setKey(field, writer);
    if (err) return err;
  }
  return Response.json(snapshot());
}
