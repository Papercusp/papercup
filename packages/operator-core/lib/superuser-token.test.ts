/**
 * Unit tests for the superuser-mode gatekeeper helpers.
 *
 * These two functions are the loopback + bearer guard for `?superuser=1`
 * (see callers in endpoint-route/routes/{transport,plugins,ui} and
 * lib/auth/principal/from-superuser-token.ts). They had ZERO coverage —
 * this file closes that gap and pins the fail-closed contract of
 * `isLoopbackRequest`, which previously failed OPEN on a non-loopback Host
 * with no x-forwarded-for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override only the two fs calls loadToken() makes; keep the rest of node:fs
// real so the vitest harness (reporters, shims) is unaffected.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(), statSync: vi.fn() };
});

import { readFileSync, statSync } from 'node:fs';
import { isLoopbackRequest, isValidSuperuserBearer } from './superuser-token';

const h = (init: Record<string, string> = {}): Headers => new Headers(init);

describe('isLoopbackRequest', () => {
  it('admits a loopback Host header', () => {
    expect(isLoopbackRequest(h({ host: '127.0.0.1:3070' }))).toBe(true);
    expect(isLoopbackRequest(h({ host: 'localhost:3055' }))).toBe(true);
    expect(isLoopbackRequest(h({ host: '[::1]:3070' }))).toBe(true);
    expect(isLoopbackRequest(h({ host: '::1' }))).toBe(true);
  });

  it('admits when every x-forwarded-for hop is loopback', () => {
    expect(isLoopbackRequest(h({ host: 'app.example.com', 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
    expect(isLoopbackRequest(h({ host: 'app.example.com', 'x-forwarded-for': '127.0.0.1, ::1' }))).toBe(true);
  });

  it('rejects when any x-forwarded-for hop is non-loopback', () => {
    expect(isLoopbackRequest(h({ host: 'app.example.com', 'x-forwarded-for': '203.0.113.5' }))).toBe(false);
    expect(
      isLoopbackRequest(h({ host: 'app.example.com', 'x-forwarded-for': '203.0.113.5, 127.0.0.1' })),
    ).toBe(false);
  });

  it('REGRESSION: fails closed on a non-loopback Host with no x-forwarded-for', () => {
    // Previously `return true` (fail-open) — a direct connection to a
    // non-loopback interface was treated as loopback. Must be rejected.
    expect(isLoopbackRequest(h({ host: 'evil.example.com' }))).toBe(false);
    expect(isLoopbackRequest(h({ host: '203.0.113.5:3070' }))).toBe(false);
  });

  it('fails closed when there is no Host and no x-forwarded-for', () => {
    expect(isLoopbackRequest(h())).toBe(false);
  });
});

describe('isValidSuperuserBearer', () => {
  let mtime = 0;

  beforeEach(() => {
    // Fresh mtime each call defeats loadToken's mtime cache so each test's
    // readFileSync stub is honored.
    vi.mocked(statSync).mockImplementation(() => ({ mtimeMs: ++mtime }) as ReturnType<typeof statSync>);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('rejects an empty/absent bearer outright', () => {
    vi.mocked(readFileSync).mockReturnValue('a-valid-superuser-token-1234');
    expect(isValidSuperuserBearer('')).toBe(false);
    expect(isValidSuperuserBearer(null)).toBe(false);
    expect(isValidSuperuserBearer(undefined)).toBe(false);
  });

  it('rejects when no token file is installed', () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isValidSuperuserBearer('a-valid-superuser-token-1234')).toBe(false);
  });

  it('rejects when the on-disk token is too short (<16 chars)', () => {
    vi.mocked(readFileSync).mockReturnValue('short');
    expect(isValidSuperuserBearer('short')).toBe(false);
  });

  it('accepts a bearer that exactly matches the on-disk token', () => {
    vi.mocked(readFileSync).mockReturnValue('a-valid-superuser-token-1234');
    expect(isValidSuperuserBearer('a-valid-superuser-token-1234')).toBe(true);
  });

  it('uses the scoped operator home and rejects the real-home bearer', () => {
    vi.stubEnv('PAPERCUSP_HOME', '/tmp/isolated-operator-home');
    vi.mocked(readFileSync).mockReturnValue('disposable-superuser-token-1234');
    expect(isValidSuperuserBearer('real-user-superuser-token-1234')).toBe(false);
    expect(isValidSuperuserBearer('disposable-superuser-token-1234')).toBe(true);
    expect(statSync).toHaveBeenCalledWith('/tmp/isolated-operator-home/superuser-token');
    expect(readFileSync).toHaveBeenCalledWith('/tmp/isolated-operator-home/superuser-token', 'utf8');
  });

  it('does not reuse a cached bearer after the scoped home changes', () => {
    vi.stubEnv('PAPERCUSP_HOME', '/tmp/operator-one');
    vi.mocked(readFileSync).mockReturnValue('first-operator-token-12345678');
    expect(isValidSuperuserBearer('first-operator-token-12345678')).toBe(true);
    vi.stubEnv('PAPERCUSP_HOME', '/tmp/operator-two');
    vi.mocked(readFileSync).mockReturnValue('second-operator-token-1234567');
    expect(isValidSuperuserBearer('first-operator-token-12345678')).toBe(false);
    expect(isValidSuperuserBearer('second-operator-token-1234567')).toBe(true);
  });

  it('rejects a same-length but non-matching bearer (constant-time compare)', () => {
    vi.mocked(readFileSync).mockReturnValue('a'.repeat(24));
    expect(isValidSuperuserBearer('b'.repeat(24))).toBe(false);
  });

  it('rejects a different-length bearer (length guard before timingSafeEqual)', () => {
    vi.mocked(readFileSync).mockReturnValue('a-valid-superuser-token-1234');
    expect(isValidSuperuserBearer('too-short-1234567')).toBe(false);
  });

  it('trims surrounding whitespace/newline from the on-disk token', () => {
    vi.mocked(readFileSync).mockReturnValue('  a-valid-superuser-token-1234\n');
    expect(isValidSuperuserBearer('a-valid-superuser-token-1234')).toBe(true);
  });
});
