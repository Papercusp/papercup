import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';

// Set a deterministic secret before importing — module reads it at load time.
beforeAll(() => {
  process.env.MOBILE_JWT_SECRET = 'test-secret-padding-padding-padding-padding';
});

const mod = await import('./device-jwt');
const {
  signDeviceToken,
  verifyDeviceToken,
  mobileJwtSecretStatus,
  assertMobileJwtSecretDurableForCluster,
  warnIfMobileJwtSecretNotDurable,
  __resetDeviceJwtForTest,
} = mod;

describe('device-jwt sign/verify', () => {
  const claims = {
    sub: 'device-1',
    workspace_id: 'ws-A',
    device_kind: 'mobile' as const,
    user_email: 'test@example.com',
  };

  it('round-trips a freshly signed token', () => {
    const token = signDeviceToken(claims);
    const decoded = verifyDeviceToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('device-1');
    expect(decoded?.workspace_id).toBe('ws-A');
    expect(decoded?.device_kind).toBe('mobile');
    expect(decoded?.user_email).toBe('test@example.com');
  });

  it('rejects garbage', () => {
    expect(verifyDeviceToken('not-a-token')).toBeNull();
    expect(verifyDeviceToken('')).toBeNull();
    expect(verifyDeviceToken('a.b.c')).toBeNull();
  });

  it('rejects a token with a tampered payload', () => {
    const token = signDeviceToken(claims);
    const [h, p, s] = token.split('.');
    void p;
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claims, workspace_id: 'ws-B', iat: 1, exp: 2 ** 31 }),
    ).toString('base64url');
    const tampered = `${h}.${tamperedPayload}.${s}`;
    expect(verifyDeviceToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signDeviceToken(claims);
    const [h, p, s] = token.split('.');
    const decoded = JSON.parse(Buffer.from(p, 'base64url').toString());
    const expired = {
      ...decoded,
      exp: Math.floor(Date.now() / 1000) - 60,
    };
    const expiredPayload = Buffer.from(JSON.stringify(expired)).toString('base64url');
    void s;
    // We need to re-sign this payload to test expiry alone (vs sig failure).
    // Easier: directly call verifyDeviceToken with a re-built signed expired token.
    // Use the same secret + HMAC as the module.
    const { createHmac } = require('node:crypto');
    const secret = process.env.MOBILE_JWT_SECRET!;
    const sig = createHmac('sha256', secret).update(`${h}.${expiredPayload}`).digest('base64url');
    const token2 = `${h}.${expiredPayload}.${sig}`;
    expect(verifyDeviceToken(token2)).toBeNull();
  });

  it('rejects a token with non-mobile device_kind', () => {
    // Sign an artisan token with a non-mobile claim and verify it's rejected.
    const { createHmac } = require('node:crypto');
    const secret = process.env.MOBILE_JWT_SECRET!;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      sub: 'device-x',
      workspace_id: 'ws-A',
      device_kind: 'desktop',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');
    const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    const desktopToken = `${header}.${payload}.${sig}`;
    expect(verifyDeviceToken(desktopToken)).toBeNull();
  });

  it('verifies different claim subjects independently', () => {
    const a = signDeviceToken({ ...claims, sub: 'device-A' });
    const b = signDeviceToken({ ...claims, sub: 'device-B' });
    expect(verifyDeviceToken(a)?.sub).toBe('device-A');
    expect(verifyDeviceToken(b)?.sub).toBe('device-B');
  });
});

// P-001 (mobile-apps-revival-v2): the signing secret must be DURABLE across
// operator restarts/deploys or paired phones silently stop working. These
// exercise the inspector the boot warning + the phone connection-health route
// (P-010) both read, and the warn-once behaviour.
describe('device-jwt secret durability (P-001)', () => {
  const savedSecret = process.env.MOBILE_JWT_SECRET;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.MOBILE_JWT_SECRET;
    else process.env.MOBILE_JWT_SECRET = savedSecret;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    __resetDeviceJwtForTest();
    vi.restoreAllMocks();
  });

  it('reports durable:env when a >=32-char secret is set (the ship state)', () => {
    process.env.MOBILE_JWT_SECRET = 'x'.repeat(40);
    expect(mobileJwtSecretStatus()).toEqual({ durable: true, source: 'env' });
  });

  it('reports ephemeral in dev when the secret is unset — tokens will not survive a restart', () => {
    delete process.env.MOBILE_JWT_SECRET;
    process.env.NODE_ENV = 'development';
    const status = mobileJwtSecretStatus();
    expect(status.durable).toBe(false);
    expect(status.source).toBe('ephemeral');
  });

  it('reports unset-production when the secret is unset in production (signing would throw)', () => {
    delete process.env.MOBILE_JWT_SECRET;
    process.env.NODE_ENV = 'production';
    const status = mobileJwtSecretStatus();
    expect(status.durable).toBe(false);
    expect(status.source).toBe('unset-production');
  });

  it('treats a too-short (<32-char) secret as not durable', () => {
    process.env.MOBILE_JWT_SECRET = 'short';
    process.env.NODE_ENV = 'development';
    expect(mobileJwtSecretStatus().source).toBe('ephemeral');
  });

  it('warns exactly once for an ephemeral secret (boot-time / first-use warning)', () => {
    delete process.env.MOBILE_JWT_SECRET;
    process.env.NODE_ENV = 'development';
    __resetDeviceJwtForTest();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnIfMobileJwtSecretNotDurable();
    warnIfMobileJwtSecretNotDurable();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('MOBILE_JWT_SECRET');
  });

  it('stays silent when the secret is durable', () => {
    process.env.MOBILE_JWT_SECRET = 'y'.repeat(40);
    __resetDeviceJwtForTest();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const status = warnIfMobileJwtSecretNotDurable();
    expect(warn).not.toHaveBeenCalled();
    expect(status).toEqual({ durable: true, source: 'env' });
  });

  it('refuses a clustered host when the secret would be process-local', () => {
    delete process.env.MOBILE_JWT_SECRET;
    process.env.NODE_ENV = 'development';
    expect(() => assertMobileJwtSecretDurableForCluster(16)).toThrow(
      /Refusing to start 16-worker host.*intermittently invalid across workers/,
    );
  });

  it('allows a single-process dev host to retain the explicit ephemeral fallback', () => {
    delete process.env.MOBILE_JWT_SECRET;
    process.env.NODE_ENV = 'development';
    expect(() => assertMobileJwtSecretDurableForCluster(1)).not.toThrow();
  });

  it('allows a clustered host when all workers inherit a durable secret', () => {
    process.env.MOBILE_JWT_SECRET = 'z'.repeat(40);
    expect(() => assertMobileJwtSecretDurableForCluster(16)).not.toThrow();
  });
});
