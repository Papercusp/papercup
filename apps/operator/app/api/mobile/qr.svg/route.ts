/**
 * GET /api/mobile/qr.svg?payload=<json>
 *
 * Renders an SVG QR for the pairing payload. Server-rendered so the settings
 * UI doesn't need a client-side QR lib.
 *
 * Auth: loopback-only via Host header (same gate as /api/mobile/desktop/*).
 * The payload itself contains a one-time pairToken with a 5-minute TTL.
 */
import { NextRequest, NextResponse } from 'next/server';
import { toString as qrToString } from 'qrcode';

export const dynamic = 'force-dynamic';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export async function GET(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return NextResponse.json({ error: 'loopback_only' }, { status: 403 });
  }
  const payload = req.nextUrl.searchParams.get('payload');
  if (!payload) {
    return NextResponse.json({ error: 'missing_payload' }, { status: 400 });
  }
  if (payload.length > 4096) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 400 });
  }
  try {
    const svg = await qrToString(payload, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0a0a0a', light: '#ffffff' },
    });
    return new NextResponse(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'render_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
