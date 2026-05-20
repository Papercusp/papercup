/**
 * POST /api/agent-tokens/power-user/refresh
 *   headers: Authorization: Bearer <refresh_token>
 *   returns: { access_token, access_expires_at }
 *
 * Mints a fresh access token from a still-valid refresh token. The
 * refresh token itself is the credential — no operator session cookie
 * required (the OMP plugin runs in a terminal and has no cookie jar;
 * see docs/plans/omp-power-user-bundle-2026-05-20.md §4.3 step 6).
 *
 * Revocation: the refresh token's `auth_session_id` is checked against
 * harness_shared.power_user_sessions. A missing or revoked row → 401.
 * This is what makes session-bound revoke real.
 *
 * Refresh-token rotation is deferred to v2 (D-008): the same refresh
 * token stays usable for its full 24h TTL.
 */
import { NextRequest } from 'next/server';

import { isLoopbackRequest } from '@/lib/superuser-token';
import { verifyRefreshToken, mintAccessToken } from '@/lib/power-user-token';
import { getActivePowerUserSession } from '@/lib/power-user-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function bearerFrom(req: NextRequest): string | null {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isLoopbackRequest(req.headers)) {
    return Response.json({ error: 'loopback only' }, { status: 403 });
  }
  const refreshToken = bearerFrom(req);
  const claims = await verifyRefreshToken(refreshToken);
  if (!claims) {
    return Response.json({ error: 'invalid or expired refresh token' }, { status: 401 });
  }
  // The token's HMAC + expiry are valid — now confirm the session row
  // still exists and hasn't been revoked. getActivePowerUserSession
  // also bumps last_seen_at.
  const session = await getActivePowerUserSession(claims.authSessionId);
  if (!session) {
    return Response.json({ error: 'session revoked or unknown' }, { status: 401 });
  }
  try {
    const access = await mintAccessToken({
      workspaceId: session.workspaceId,
      userId: session.userId,
      authSessionId: session.authSessionId,
    });
    return Response.json({
      access_token: access.token,
      access_expires_at: new Date(access.exp * 1000).toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'refresh failed';
    return Response.json({ error: msg }, { status: 400 });
  }
}
