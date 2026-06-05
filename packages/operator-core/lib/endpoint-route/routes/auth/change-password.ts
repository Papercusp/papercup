/**
 * POST /api/auth/change-password — change the current user's password
 * and re-issue a session (changePassword invalidates all sessions).
 *
 * Ported from app/api/auth/change-password/route.ts. `auth: 'public'` —
 * the handler does its own session check via `getSessionUser` so it can
 * emit the `change_password_no_session` audit row on the no-session path.
 */
import { getSessionUser, changePassword, login, SESSION_COOKIE } from '../../../auth';
import { recordAuthEvent } from '../../../auth-audit';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';

export default defineTool({
  method: 'POST',
  path: '/auth/change-password',
  auth: 'public',
  async handler(req) {
    const userAgent = req.headers.get('user-agent') ?? undefined;
    const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';

    const user = await getSessionUser(req.headers);
    if (!user) {
      void recordAuthEvent({
        kind: 'change_password_no_session', ip, userAgent, ok: false,
        errorCode: 'unauthenticated',
      });
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    const current = typeof body?.current === 'string' ? body.current : null;
    const next = typeof body?.next === 'string' ? body.next : null;

    try {
      await changePassword(user.id, current, next);
      // changePassword invalidates all sessions for the user (including
      // the current cookie). Re-issue a session with the new password so
      // the user stays signed in — without this they'd silently fall to
      // an unauthenticated state on the next /api/auth/me poll.
      const session = await login(user.username, next, {
        user_agent: userAgent,
        remote_addr: ip,
      });
      void recordAuthEvent({
        kind: 'change_password_ok',
        username: user.username, ip, userAgent, ok: true,
        sessionToken: session.token,
      });
      return Response.json(
        { ok: true },
        {
          headers: {
            'set-cookie': serializeSetCookie(SESSION_COOKIE, session.token, {
              httpOnly: true,
              sameSite: 'Strict',
              path: '/',
              expires: session.expires_at,
            }),
          },
        },
      );
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'failed';
      void recordAuthEvent({
        // bad_password is the "wrong current pw" case; everything else
        // (invalid next, password too short, etc.) is a generic failure.
        kind: code === 'bad_password' ? 'change_password_bad_old' : 'change_password_failed',
        username: user.username, ip, userAgent, ok: false,
        errorCode: code,
      });
      return Response.json({ error: code }, { status: 400 });
    }
  },
});
