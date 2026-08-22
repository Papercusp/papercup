import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRemoteAuthReady,
  configuredRemoteOrigins,
  isConfiguredRemoteOrigin,
  requestNeedsSecureCookie,
} from './remote-auth-policy';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('remote auth listener policy', () => {
  it('keeps loopback and SSH-forward binds zero-config', () => {
    expect(assertRemoteAuthReady('127.0.0.1')).toEqual({ remote: false, origins: [] });
    expect(assertRemoteAuthReady('localhost')).toEqual({ remote: false, origins: [] });
  });

  it('refuses an off-loopback listener without both opt-in and exact origins', () => {
    expect(() => assertRemoteAuthReady('0.0.0.0', {})).toThrow(/ALLOW_REMOTE_ADMIN/);
    expect(() => assertRemoteAuthReady('0.0.0.0', { PAPERCUSP_ALLOW_REMOTE_ADMIN: '1' })).toThrow(/REMOTE_ORIGINS/);
  });

  it('accepts, canonicalizes, and exact-matches HTTPS origins', () => {
    const env = {
      PAPERCUSP_ALLOW_REMOTE_ADMIN: '1',
      PAPERCUSP_REMOTE_ORIGINS: 'https://app.example.com, https://ops.example.com:8443',
    };
    expect(assertRemoteAuthReady('0.0.0.0', env)).toEqual({
      remote: true,
      origins: ['https://app.example.com', 'https://ops.example.com:8443'],
    });
    expect(configuredRemoteOrigins(env)).toHaveLength(2);
    expect(isConfiguredRemoteOrigin('https://app.example.com', env)).toBe(true);
    expect(isConfiguredRemoteOrigin('https://app.example.com.evil.test', env)).toBe(false);
  });

  it('rejects HTTP and origin values with path/query ambiguity', () => {
    expect(() => configuredRemoteOrigins({ PAPERCUSP_REMOTE_ORIGINS: 'http://app.example.com' })).toThrow(/HTTPS/);
    expect(() => configuredRemoteOrigins({ PAPERCUSP_REMOTE_ORIGINS: 'https://app.example.com/path' })).toThrow(/exact HTTPS/);
  });

  it('marks direct-remote and forwarded-HTTPS cookies Secure', () => {
    expect(requestNeedsSecureCookie(new Request('http://127.0.0.1/auth/login'))).toBe(false);
    expect(requestNeedsSecureCookie(new Request('https://app.example.com/auth/login'))).toBe(true);
    expect(requestNeedsSecureCookie(new Request('http://127.0.0.1/auth/login', {
      headers: { 'x-forwarded-proto': 'https' },
    }))).toBe(true);
  });
});
