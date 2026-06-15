/**
 * Unit tests for the device-route shared helpers (_shared.ts): the loopback-host
 * gate (mint-pair-token) and the device-principal narrowing guard.
 * (whole-app-test-coverage-breadth-2026-06-14.)
 */
import { describe, expect, it } from 'vitest';
import { DEVICE_AUTH, devicePrincipal, isLoopbackHost } from './_shared';

const reqHost = (host?: string) =>
  new Request('http://x/y', { headers: host !== undefined ? { host } : {} });

describe('isLoopbackHost', () => {
  it('matches loopback host names — with or without a port, case-insensitive', () => {
    expect(isLoopbackHost(reqHost('localhost'))).toBe(true);
    expect(isLoopbackHost(reqHost('localhost:3070'))).toBe(true);
    expect(isLoopbackHost(reqHost('127.0.0.1'))).toBe(true);
    expect(isLoopbackHost(reqHost('127.0.0.1:8080'))).toBe(true);
    expect(isLoopbackHost(reqHost('LOCALHOST'))).toBe(true);
  });

  it('rejects a non-loopback host, a look-alike, and a missing Host header', () => {
    expect(isLoopbackHost(reqHost('example.com'))).toBe(false);
    expect(isLoopbackHost(reqHost('example.com:443'))).toBe(false);
    expect(isLoopbackHost(reqHost('127.0.0.1.evil.com'))).toBe(false);
    expect(isLoopbackHost(reqHost())).toBe(false); // no Host header → ''
  });

  it('KNOWN LIMITATION: a bracketed-IPv6 loopback Host does NOT match today', () => {
    // LOOPBACK_HOSTS lists '::1'/'[::1]', but `host.split(':')[0]` yields '[' for '[::1]',
    // so the IPv6 forms never match. Documenting the REAL behavior (fail-closed → an IPv6
    // loopback simply can't mint a pair token), not asserting it as the desired end state.
    expect(isLoopbackHost(reqHost('[::1]'))).toBe(false);
    expect(isLoopbackHost(reqHost('[::1]:3070'))).toBe(false);
  });
});

describe('devicePrincipal', () => {
  it('returns the resolved principal', () => {
    const principal = { kind: 'device', slug: 'dev-1' } as never;
    expect(devicePrincipal({ principal } as never)).toBe(principal);
  });

  it('throws when the principal is missing (the route-stack guarantee was bypassed)', () => {
    expect(() => devicePrincipal({ principal: undefined } as never)).toThrow(/without a resolved principal/);
  });
});

describe('DEVICE_AUTH', () => {
  it('gates the route to device principals only', () => {
    expect(DEVICE_AUTH).toEqual({ kind: ['device'] });
  });
});
