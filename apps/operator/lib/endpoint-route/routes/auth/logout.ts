/**
 * POST /api/auth/logout — destroy the current session + clear the cookie.
 *
 * Ported from app/api/auth/logout/route.ts. `auth: 'public'` — logging
 * out is harmless without a session; the route just no-ops the cookie.
 */
import { logout, SESSION_COOKIE, getSessionUser } from '@/lib/auth';
import { recordAuthEvent } from '@/lib/auth-audit';
import { defineRoute } from '../../define-route';
import { readCookie, serializeDeleteCookie } from '../../cookies';

export default defineRoute({
  method: 'POST',
  path: '/auth/logout',
  auth: 'public',
  async handler(req) {
    const token = readCookie(req, SESSION_COOKIE);
    // Resolve username pre-delete so the audit row has it.
    const user = await getSessionUser(req.headers).catch(() => null);
    if (token) {
      await logout(token).catch(() => { /* best-effort */ });
    }
    void recordAuthEvent({
      kind: 'logout',
      username: user?.username,
      ip: req.headers.get('x-forwarded-for') ?? '127.0.0.1',
      userAgent: req.headers.get('user-agent') ?? undefined,
      ok: true,
      sessionToken: token,
    });
    return Response.json(
      { ok: true },
      { headers: { 'set-cookie': serializeDeleteCookie(SESSION_COOKIE) } },
    );
  },
});
