/**
 * POST /api/auth/signup — create a local account, optionally auto-login.
 *
 * Ported from app/api/auth/signup/route.ts. `auth: 'public'` — account
 * creation is pre-auth.
 */
import { signup, login, SESSION_COOKIE } from '../../../auth';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';

export default defineTool({
  method: 'POST',
  path: '/auth/signup',
  auth: 'public',
  async handler(req) {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username : '';
    const display_name = typeof body?.display_name === 'string' ? body.display_name : '';
    const password = typeof body?.password === 'string' ? body.password : null;
    const autoLogin = body?.auto_login !== false;
    if (!username || !display_name) {
      return Response.json({ error: 'username + display_name required' }, { status: 400 });
    }

    try {
      const user = await signup(username, display_name, password);
      const headers: Record<string, string> = {};
      if (autoLogin) {
        const session = await login(user.username, password, {
          user_agent: req.headers.get('user-agent') ?? undefined,
          remote_addr: req.headers.get('x-forwarded-for') ?? undefined,
        });
        headers['set-cookie'] = serializeSetCookie(SESSION_COOKIE, session.token, {
          httpOnly: true,
          sameSite: 'Strict',
          path: '/',
          expires: session.expires_at,
        });
      }
      return Response.json({ ok: true, user }, { headers });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      const code = (e as { code?: string }).code;
      if (/duplicate|unique/i.test(msg)) {
        return Response.json({ error: 'username_taken' }, { status: 409 });
      }
      return Response.json({ error: code ?? 'signup_failed' }, { status: 400 });
    }
  },
});
