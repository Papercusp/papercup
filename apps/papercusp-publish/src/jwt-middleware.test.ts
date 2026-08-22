/**
 * jwt-middleware.test.ts — auth-glue coverage for the publish worker
 * (Plan 2 Phase A, P-001).
 *
 * The publish worker is a live, externally-reachable signing surface that had
 * ZERO tests. The crypto primitives (parseJwt/verifyJwt/derivePublishKey) are
 * covered upstream in @papercusp/publish-auth; the untested part is the
 * middleware GLUE: tenant lookup, status gating, the **JTI replay consume**
 * (the anti-replay guard), and the audit-on-failure branches. This drives the
 * real `jwtMiddleware` in-process (Hono `app.request`) with publish-auth + the
 * D1 helpers mocked, so each branch is pinned without real crypto or a DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from './env.ts';
import type { JwtCtxVars } from './jwt-middleware.ts';

const h = vi.hoisted(() => ({
  parseJwt: vi.fn(),
  verifyJwt: vi.fn(),
  derivePublishKey: vi.fn(async () => new Uint8Array(32)),
  b64uDecode: vi.fn(() => new Uint8Array(8)),
  getTenant: vi.fn(),
  consumeJti: vi.fn(),
  touchTenant: vi.fn(async () => {}),
  audit: vi.fn(async () => {}),
  clientIp: vi.fn(() => '1.2.3.4'),
}));

vi.mock('@papercusp/publish-auth', () => ({
  parseJwt: h.parseJwt,
  verifyJwt: h.verifyJwt,
  derivePublishKey: h.derivePublishKey,
  b64uDecode: h.b64uDecode,
}));
vi.mock('./db.ts', () => ({
  audit: h.audit,
  clientIp: h.clientIp,
  consumeJti: h.consumeJti,
  getTenant: h.getTenant,
  touchTenant: h.touchTenant,
}));

import { jwtMiddleware } from './jwt-middleware.ts';

function appWithMw() {
  const app = new Hono<{ Bindings: Env; Variables: JwtCtxVars }>();
  app.use('*', jwtMiddleware({ audience: 'publish' }));
  app.get('/protected', (c) =>
    c.json({ ok: true, tenant: c.get('tenantId'), jti: (c.get('jwt') as { jti: string }).jti }),
  );
  return app;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = { DB: {} as any };
const req = (token?: string) =>
  appWithMw().request(
    '/protected',
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
    env,
  );
const outcomeOf = (callIndex = 0) => (h.audit.mock.calls as unknown[][])[callIndex]?.[2];

beforeEach(() => {
  vi.clearAllMocks();
  h.parseJwt.mockReturnValue({ claims: { sub: 'tenant-1' } });
  h.getTenant.mockResolvedValue({ id: 'tenant-1', status: 'active', secret_b64: 'AAAA' });
  h.verifyJwt.mockResolvedValue({ jti: 'jti-1', exp: 9_999_999_999, sub: 'tenant-1', aud: 'publish' });
  h.consumeJti.mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('publish jwtMiddleware', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await req();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing bearer token' });
  });

  it('rejects an unknown tenant and audits it', async () => {
    h.getTenant.mockResolvedValue(null);
    const res = await req('tok');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unknown tenant' });
    expect(outcomeOf()).toBe('unknown_tenant');
  });

  it('rejects a non-active tenant and audits the status', async () => {
    h.getTenant.mockResolvedValue({ id: 'tenant-1', status: 'suspended', secret_b64: 'AAAA' });
    const res = await req('tok');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'tenant not active' });
    expect(outcomeOf()).toBe('tenant_suspended');
  });

  it('REJECTS A JWT REPLAY (consumeJti=false) and audits it', async () => {
    h.consumeJti.mockResolvedValue(false);
    const res = await req('tok');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'jwt replay detected' });
    expect(outcomeOf()).toBe('jwt_replay');
    expect(h.consumeJti).toHaveBeenCalledWith(expect.anything(), 'jti-1', 9_999_999_999);
  });

  it('passes a valid token through, binding tenant + jwt onto the context', async () => {
    const res = await req('tok');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tenant: 'tenant-1', jti: 'jti-1' });
    expect(h.touchTenant).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('rejects an invalid JWT (verifyJwt throws) and audits invalid_jwt', async () => {
    h.verifyJwt.mockRejectedValue(new Error('bad signature'));
    const res = await req('tok');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'bad signature' });
    expect(outcomeOf()).toBe('invalid_jwt');
  });
});
