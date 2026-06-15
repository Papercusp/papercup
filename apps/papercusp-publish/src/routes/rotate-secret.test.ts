/**
 * rotate-secret.test.ts — POST /rotate-secret (the security-sensitive one).
 *
 * A tenant authenticated with a JWT signed by the CURRENT secret rotates to a
 * fresh secret, atomically invalidating the old one. The handler logic under
 * test: mint a fresh secret, call rotateTenantSecret(db, tenantId, fresh) with
 * the AUTHENTICATED tenant (never a body-supplied one), audit 'rotated' with the
 * tenant + client IP, and return { tenantSecret: <fresh> } exactly once. We also
 * pin (via the REAL jwtMiddleware) that the route is closed to an unauthenticated
 * caller — no secret may be minted without a valid bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  newTenantSecret: vi.fn(() => 'fresh-secret-xyz'),
  rotateTenantSecret: vi.fn(async () => {}),
  audit: vi.fn(async () => {}),
  clientIp: vi.fn(() => '9.9.9.9'),
}));

vi.mock('@papercusp/publish-auth', () => ({ tenantSecret: h.newTenantSecret }));
vi.mock('../db.ts', () => ({
  audit: h.audit,
  clientIp: h.clientIp,
  rotateTenantSecret: h.rotateTenantSecret,
}));
// Pass-through auth for the happy path: bind the authenticated tenant.
vi.mock('../jwt-middleware.ts', () => ({
  jwtMiddleware: () => async (c: any, next: any) => {
    c.set('tenantId', 'tenant-auth');
    c.set('jwt', { sub: 'tenant-auth' });
    await next();
  },
}));

import { rotateSecretRoute } from './rotate-secret.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {} };
const rotate = (init?: RequestInit) =>
  rotateSecretRoute().request('/rotate-secret', { method: 'POST', ...init }, env);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('POST /rotate-secret', () => {
  it('rotates the AUTHENTICATED tenant to a fresh secret and returns it once', async () => {
    const res = await rotate();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantSecret: 'fresh-secret-xyz' });
    expect(h.newTenantSecret).toHaveBeenCalledTimes(1);
    // Persisted against the authenticated tenant id, with the freshly-minted secret.
    expect(h.rotateTenantSecret).toHaveBeenCalledWith(expect.anything(), 'tenant-auth', 'fresh-secret-xyz');
  });

  it('audits the rotation with the tenant + client IP', async () => {
    await rotate();
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [, , kind, detail] = h.audit.mock.calls[0];
    expect(kind).toBe('rotated');
    expect(detail).toMatchObject({ tenantId: 'tenant-auth', ip: '9.9.9.9' });
  });

  it('persists the new secret BEFORE auditing (rotate then audit)', async () => {
    const order: string[] = [];
    h.rotateTenantSecret.mockImplementationOnce(async () => {
      order.push('rotate');
    });
    h.audit.mockImplementationOnce(async () => {
      order.push('audit');
    });
    await rotate();
    expect(order).toEqual(['rotate', 'audit']);
  });

  it('ignores any tenant supplied in the request body (uses only the JWT tenant)', async () => {
    const res = await rotate({
      body: JSON.stringify({ tenantId: 'attacker-controlled' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(h.rotateTenantSecret).toHaveBeenCalledWith(expect.anything(), 'tenant-auth', 'fresh-secret-xyz');
    expect(h.rotateTenantSecret).not.toHaveBeenCalledWith(expect.anything(), 'attacker-controlled', expect.anything());
  });
});

// A second app instance that exercises the REAL middleware, to pin that the
// route refuses an unauthenticated caller (no secret minted without a bearer).
describe('POST /rotate-secret — auth gating (real middleware)', () => {
  it('401s with no bearer and never mints/persists a secret', async () => {
    vi.resetModules();
    vi.doMock('@papercusp/publish-auth', () => ({ tenantSecret: h.newTenantSecret }));
    vi.doMock('../db.ts', () => ({
      audit: h.audit,
      clientIp: h.clientIp,
      rotateTenantSecret: h.rotateTenantSecret,
      // jwt-middleware also pulls these from db.ts:
      getTenant: vi.fn(async () => null),
      consumeJti: vi.fn(async () => true),
      touchTenant: vi.fn(async () => {}),
    }));
    vi.doUnmock('../jwt-middleware.ts');
    const { rotateSecretRoute: realRoute } = await import('./rotate-secret.ts');
    const res = await realRoute().request('/rotate-secret', { method: 'POST' }, env);
    expect(res.status).toBe(401);
    expect(h.newTenantSecret).not.toHaveBeenCalled();
    expect(h.rotateTenantSecret).not.toHaveBeenCalled();
    vi.resetModules();
  });
});
