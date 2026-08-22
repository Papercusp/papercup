/**
 * register.test.ts — POST /register-tenant (Plan 2 Phase A, P-A).
 *
 * Anonymous tenant onboarding: mint id + secret, persist as active/free, and
 * (the abuse gate) a per-IP register-hourly rate limit. Covers the happy path
 * (returns id+secret once, inserts active/free, audits 'registered') and the
 * rate-limited 429 (no tenant inserted, audits 'rate_limited').
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class RateLimitError extends Error {
    constructor(public bucket: string, public retryAfterSec: number) {
      super(bucket);
    }
  }
  return {
    RateLimitError,
    checkIpRegisterHourly: vi.fn(),
    insertTenant: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    clientIp: vi.fn(() => '1.2.3.4'),
    newTenantId: vi.fn(() => 'tenant-xyz'),
    newTenantSecret: vi.fn(() => 'secret-abc'),
  };
});

vi.mock('../ratelimit.ts', () => ({
  checkIpRegisterHourly: h.checkIpRegisterHourly,
  RateLimitError: h.RateLimitError,
}));
vi.mock('../db.ts', () => ({ audit: h.audit, clientIp: h.clientIp, insertTenant: h.insertTenant }));
vi.mock('@papercusp/publish-auth', () => ({ tenantId: h.newTenantId, tenantSecret: h.newTenantSecret }));

import { registerRoute } from './register.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {} };
const register = () => registerRoute().request('/register-tenant', { method: 'POST' }, env);
const auditOutcome = () => (h.audit.mock.calls as unknown[][])[0]?.[2];

beforeEach(() => {
  vi.clearAllMocks();
  h.checkIpRegisterHourly.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('POST /register-tenant', () => {
  it('registers a tenant and returns the id + secret once', async () => {
    const res = await register();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: 'tenant-xyz', tenantSecret: 'secret-abc' });
    expect(h.insertTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'tenant-xyz', status: 'active', tier: 'free' }),
    );
    expect(auditOutcome()).toBe('registered');
  });

  it('rate-limits register spam with 429 and does NOT create a tenant', async () => {
    h.checkIpRegisterHourly.mockRejectedValue(
      new h.RateLimitError('ratelimit:ip-register-hourly:1.2.3.4', 3600),
    );
    const res = await register();
    expect(res.status).toBe(429);
    expect(h.insertTenant).not.toHaveBeenCalled();
    expect(auditOutcome()).toBe('rate_limited');
  });
});
