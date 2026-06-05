/**
 * POST /api/auth/login — authenticate username + optional password and
 * issue a session cookie. Soft per-IP + hard per-(IP,user) rate gates.
 *
 * Ported from app/api/auth/login/route.ts. `auth: 'public'` — this is
 * the pre-auth endpoint; it establishes the session everything else
 * gates on. Cookie writes are `Set-Cookie` headers (no Next `cookies()`
 * jar); request headers come from `req.headers` (no `next/headers`).
 */
import { login, SESSION_COOKIE, DEFAULT_SESSION_TTL_MS } from '../../../auth';
import {
  checkSoftPerIp,
  refundSoftPerIp,
  checkHardPerUser,
  burnHardPerUser,
  resetHardPerUser,
} from '../../../auth-rate-limit';
import { recordAuthEvent } from '../../../auth-audit';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeSetCookie } from '../../cookies';

export default defineTool({
  method: 'POST',
  path: '/auth/login',
  auth: 'public',
  async handler(req) {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : null;
    const ttl_ms = typeof body?.ttl_ms === 'number' ? body.ttl_ms : DEFAULT_SESSION_TTL_MS;
    const userAgent = req.headers.get('user-agent') ?? undefined;
    const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';

    if (!username) {
      // Audit malformed attempts too — missing-username probes shouldn't
      // be invisible just because they error early.
      void recordAuthEvent({
        kind: 'login_failed',
        username: undefined,
        ip, userAgent, ok: false,
        errorCode: 'username_required',
      });
      return Response.json({ error: 'username required' }, { status: 400 });
    }

    // (1) Soft per-IP gate. Loopback-exempt so single-user desktop installs
    //     never lock themselves out via typos on their own machine.
    const softResult = await checkSoftPerIp(ip).catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!softResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'soft_rate_limited',
        metadata: { retry_after_s: softResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: softResult.retryAfterS ?? 60 },
        { status: 429 },
      );
    }

    // (2) Hard per-(IP, username) gate. Applies even on loopback —
    //     username-scoped so one bad-actor account can't block the whole
    //     install.
    const hardResult = await checkHardPerUser(ip, username).catch(() => ({ ok: true, retryAfterS: undefined as number | undefined }));
    if (!hardResult.ok) {
      void recordAuthEvent({
        kind: 'login_rate_limited',
        username, ip, userAgent, ok: false,
        errorCode: 'hard_locked_out',
        metadata: { retry_after_s: hardResult.retryAfterS },
      });
      return Response.json(
        { error: 'rate_limited', retry_after_s: hardResult.retryAfterS ?? 300 },
        { status: 429 },
      );
    }

    try {
      const result = await login(username, password, {
        user_agent: userAgent,
        remote_addr: ip,
        ttl_ms,
      });
      // Refund the soft bucket so an earlier-failed typo isn't held
      // against the legitimate user. Reset the hard bucket so the
      // 5-strike counter clears on success.
      await refundSoftPerIp(ip).catch(() => { /* best-effort */ });
      await resetHardPerUser(ip, username).catch(() => { /* best-effort */ });
      void recordAuthEvent({
        kind: 'login_ok',
        username, ip, userAgent, ok: true,
        sessionToken: result.token,
      });
      return Response.json(
        { ok: true, user: result.user },
        {
          headers: {
            'set-cookie': serializeSetCookie(SESSION_COOKIE, result.token, {
              httpOnly: true,
              sameSite: 'Strict',
              path: '/',
              expires: result.expires_at,
            }),
          },
        },
      );
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'login_failed';
      const status = code === 'unknown_user' || code === 'bad_password' ? 401 : 400;
      if (status >= 500) console.error('[auth/login]', code, (e as Error).stack);
      // Failure burns the hard counter. (Soft bucket is already burned
      // by checkSoftPerIp.)
      await burnHardPerUser(ip, username).catch(() => { /* best-effort */ });
      void recordAuthEvent({
        kind: code === 'bad_password' ? 'login_bad_password' :
              code === 'unknown_user' ? 'login_unknown_user' :
              'login_failed',
        username, ip, userAgent, ok: false,
        errorCode: code,
      });
      return Response.json({ error: code }, { status });
    }
  },
});
