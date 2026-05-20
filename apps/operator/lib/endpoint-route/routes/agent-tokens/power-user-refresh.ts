/**
 * POST /api/agent-tokens/power-user/refresh
 *
 * Mints a fresh access token from a still-valid refresh token. The
 * refresh token (Authorization: Bearer) is the credential; the route
 * also resolves a principal (`auth: {}`) as the transport gate.
 *
 * Ported from app/api/agent-tokens/power-user/refresh/route.ts.
 */
import { verifyRefreshToken, mintAccessToken } from '@/lib/power-user-token';
import { getActivePowerUserSession } from '@/lib/power-user-sessions';
import { defineRoute } from '../../define-route';

function bearerFrom(req: Request): string | null {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

export default defineRoute({
  method: 'POST',
  path: '/agent-tokens/power-user/refresh',
  auth: {},
  async handler(req) {
    const refreshToken = bearerFrom(req);
    const claims = await verifyRefreshToken(refreshToken);
    if (!claims) {
      return Response.json({ error: 'invalid or expired refresh token' }, { status: 401 });
    }
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
  },
});
