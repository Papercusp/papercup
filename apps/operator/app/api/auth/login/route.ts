import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { login, SESSION_COOKIE, DEFAULT_SESSION_TTL_MS } from '@/lib/auth';
import {
  checkSoftPerIp,
  refundSoftPerIp,
  checkHardPerUser,
  burnHardPerUser,
  resetHardPerUser,
} from '@/lib/auth-rate-limit';
import { recordAuthEvent } from '@/lib/auth-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : null;
  const ttl_ms = typeof body?.ttl_ms === 'number' ? body.ttl_ms : DEFAULT_SESSION_TTL_MS;
  const h = await headers();
  const userAgent = h.get('user-agent') ?? undefined;
  const ip = h.get('x-forwarded-for') ?? '127.0.0.1';

  if (!username) {
    // Audit malformed attempts too — missing-username probes shouldn't
    // be invisible just because they error early.
    void recordAuthEvent({
      kind: 'login_failed',
      username: undefined,
      ip, userAgent, ok: false,
      errorCode: 'username_required',
    });
    return NextResponse.json({ error: 'username required' }, { status: 400 });
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
    return NextResponse.json(
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
    return NextResponse.json(
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
    const jar = await cookies();
    jar.set({
      name: SESSION_COOKIE,
      value: result.token,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: result.expires_at,
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
    return NextResponse.json({ ok: true, user: result.user });
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
    return NextResponse.json({ error: code }, { status });
  }
}
