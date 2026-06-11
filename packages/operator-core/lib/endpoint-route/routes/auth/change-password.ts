/**
 * POST /api/auth/change-password — change the current user's password
 * and re-issue a session (changePassword invalidates all sessions).
 *
 * Ported from app/api/auth/change-password/route.ts. `auth: 'public'` —
 * resolves the user with the seeded-`default`-user fallback: the desktop
 * webview is cookie-less (EI-338), so a strict session check left the
 * change-password form permanently 401 on desktop installs. Safe because
 * `changePassword` independently verifies the CURRENT password before
 * changing it (bad_password path) — a caller without the old password
 * still can't take over the account.
 */
import { getSessionUserOrDefault, changePassword, login, SESSION_COOKIE } from '../../../auth';
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

    const user = await getSessionUserOrDefault(req.headers);
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
