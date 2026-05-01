/**
 * GET  /api/provision/host-check
 *   → { decision: 'allow' | 'allow-acked' | 'gate', signals }
 *
 * POST /api/provision/host-check
 *   body: { acknowledge: true }
 *   → records the user's acknowledgement for the current host signature
 *
 * Plus a sandbox smoke test:
 *
 * GET /api/provision/host-check?smokeTest=1
 *   → { ok, driver, error? }
 *
 * Spec: /docs/snapshots/build-scripts#single-user-host-detection.
 */

import { NextResponse } from 'next/server';
import { decideGate, detectSharedHost, writeAcknowledgement } from '@/lib/provision/single-user';
import { smokeTestSandbox } from '@/lib/provision/sandbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('smokeTest') === '1') {
    const result = await smokeTestSandbox();
    return NextResponse.json({ ok: true, smokeTest: result });
  }
  const r = await decideGate();
  return NextResponse.json({ ok: true, ...r });
}

export async function POST(req: Request) {
  let body: { acknowledge?: boolean };
  try {
    body = (await req.json()) as { acknowledge?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!body.acknowledge) {
    return NextResponse.json({ ok: false, error: 'acknowledge: true required' }, { status: 400 });
  }
  const signals = await detectSharedHost();
  await writeAcknowledgement(signals);
  return NextResponse.json({ ok: true });
}
