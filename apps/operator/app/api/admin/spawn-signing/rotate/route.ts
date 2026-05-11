/**
 * POST /api/admin/spawn-signing/rotate
 *
 * Coarse revocation endpoint for the spawn-URL signing key. Loopback +
 * superuser-bearer gated. Rotates the PG-stored key AND bumps the
 * operator's in-process cache so the new key takes effect immediately
 * (rather than the 5-minute TTL on the lazy cache).
 *
 * Effect: every signed per-spawn URL in flight will fail its next MCP
 * call with `invalid_signature`. The orchestrator will need to re-spawn
 * affected workers. Use sparingly — for compromised-key or bad-batch
 * scenarios, not as a routine action.
 *
 * Returns: `{ ok: true, rotatedAt: <ISO> }` on success; standard 4xx
 * with body `{ error }` on auth failures.
 */
import { NextResponse } from 'next/server';
import { rotateSpawnSigningKey } from '@/lib/spawn-signing';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Loopback only: same envelope superuser-token uses everywhere else.
  // The doc model is "friction not enforcement" — anyone with the
  // bearer + loopback can rotate.
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!isValidSuperuserBearer(bearer)) {
    return NextResponse.json({ error: 'invalid_bearer' }, { status: 401 });
  }

  try {
    await rotateSpawnSigningKey();
    return NextResponse.json({ ok: true, rotatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: 'rotate_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
