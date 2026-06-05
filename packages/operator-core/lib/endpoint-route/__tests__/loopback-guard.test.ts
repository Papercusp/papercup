/**
 * loopback-guard.test.ts — D-009 (production-readiness-test-coverage).
 *
 * Unit coverage for the shared loopback detection + the 403 guard used by the
 * destructive `auth: 'public'` routes. The host is derived from `req.url`
 * (what @hono/node-server builds from the Host header), so these tests drive
 * full URLs rather than fighting the Fetch spec's forbidden `Host` header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackHost, requireLoopbackOr403 } from '../loopback-guard';

describe('isLoopbackHost', () => {
  it('accepts loopback names — bare, with port, ipv6-bracketed, case-insensitive', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '::1',
      '10.0.2.2',
      'tauri.localhost',
      'localhost:3070',
      '127.0.0.1:3055',
      '[::1]:3070',
      'LOCALHOST',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects non-loopback hosts + null/empty', () => {
    for (const h of [
      'evil.com',
      '192.168.1.5',
      'example.com:3070',
      '10.0.0.5',
      '0.0.0.0',
      null,
      '',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('requireLoopbackOr403', () => {
  const req = (url: string) => new Request(url, { method: 'POST' });
  afterEach(() => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });

  it('returns null (proceed) for a loopback-origin request', () => {
    expect(requireLoopbackOr403(req('http://localhost/backups/restore'))).toBeNull();
    expect(requireLoopbackOr403(req('http://127.0.0.1:3070/flags/set'))).toBeNull();
  });

  it('returns a 403 for a non-loopback-origin request', async () => {
    const res = requireLoopbackOr403(req('http://192.168.1.50:3070/backups/restore'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: 'loopback_only' });
  });

  it('PAPERCUSP_ALLOW_REMOTE_ADMIN=1 opts a non-loopback request through', () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    expect(requireLoopbackOr403(req('http://evil.example.com/flags/set'))).toBeNull();
  });
});
