import { NextRequest, NextResponse } from 'next/server';
import { flushTelemetry } from '@/lib/telemetry-flush';

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

export async function POST(req: NextRequest) {
  if (!isLoopback(req)) return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  try {
    const result = await flushTelemetry();
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
