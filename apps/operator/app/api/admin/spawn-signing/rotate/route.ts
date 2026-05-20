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
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Admin: require trusted principal. The doc model stays "friction
  // not enforcement" — anyone with the superuser bearer can rotate.
  try {
    await requirePrincipal(req.headers, { trust: ['trusted'] });
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
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
