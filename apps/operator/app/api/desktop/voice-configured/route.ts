/**
 * GET /api/desktop/voice-configured
 *
 * Returns { configured: boolean } — whether an ElevenLabs API key has
 * been set. Used by the Setup Wizard to decide whether the linear
 * Next-button flow should walk through Step 8 (Voice devices). Users
 * can still reach Step 8 directly from the sidebar.
 *
 * Loopback-only. Never returns the key itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  return (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) {
    return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  }
  try {
    const key = await readElevenLabsKey();
    return NextResponse.json({ configured: Boolean(key) });
  } catch {
    return NextResponse.json({ configured: false });
  }
}
