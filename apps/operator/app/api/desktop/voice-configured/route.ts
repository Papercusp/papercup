/**
 * GET /api/desktop/voice-configured
 *
 * Returns:
 *   - configured: ElevenLabs API key is set
 *   - intent: user opted into voice in Step 6 (Keys) before getting
 *     the key set up
 *
 * The Setup Wizard's linear flow walks Step 8 (Voice devices) when
 * EITHER is true. configured-only would miss users who plan to set
 * up voice next; intent-only would miss users who already configured
 * it. The union catches both.
 *
 * Loopback-only. Never returns the key itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { readOperatorState } from '@/lib/operator-state-pg';

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
    const [key, state] = await Promise.all([
      readElevenLabsKey(),
      readOperatorState<{ voice_intent?: boolean }>('setup_wizard_state'),
    ]);
    const configured = Boolean(key);
    const intent = Boolean(state?.voice_intent);
    return NextResponse.json({ configured, intent });
  } catch {
    return NextResponse.json({ configured: false, intent: false });
  }
}
