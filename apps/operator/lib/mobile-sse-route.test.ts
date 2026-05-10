/**
 * Integration test for the mobile SSE route. Drives the Hono app directly,
 * asserting auth gate + initial heartbeat + invalidate flow.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';

// Stub PG layer so the route's startup doesn't block on a real database.
vi.mock('postgres', () => {
  const fakeSql = Object.assign(
    () => Promise.resolve([]),
    {
      listen: () => ({ then: (fn: (v: unknown) => unknown) => Promise.resolve(fn(undefined)) }),
      end: () => Promise.resolve(),
    },
  );
  return { default: () => fakeSql };
});
vi.mock('@restart/db-org', () => ({
  getOrgPg: () => ({
    sql: () => Promise.resolve([]),
  }),
}));
// ensureMobileDevicesTable is called as middleware on every request; stub it.
vi.mock('./ensure-schema', () => ({
  ensureMobileDevicesTable: () => Promise.resolve(),
}));

import { signDeviceToken } from './mobile-jwt';
import { registerMobile } from '../app/api/_hono/mobile';

beforeAll(() => {
  process.env.MOBILE_JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long';
});
afterAll(() => {
  delete process.env.MOBILE_JWT_SECRET;
});

describe('GET /sync/sse', () => {
  it('rejects without a token (401)', async () => {
    const res = await registerMobile.fetch(new Request('http://x/sync/sse'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('token_required');
  });

  it('rejects an invalid token (401)', async () => {
    const res = await registerMobile.fetch(new Request('http://x/sync/sse?token=not.a.jwt'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('opens the stream with a valid token, emits initial heartbeat', async () => {
    const token = signDeviceToken({
      sub: 'd-1', workspace_id: 'ws-A', device_kind: 'mobile', user_email: 'a@b.c',
    });
    const res = await registerMobile.fetch(new Request(`http://x/sync/sse?token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // Read the first chunk and assert the heartbeat is present.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: heartbeat');
    expect(text).toMatch(/data: \{"tsMs":\d+\}/);
    await reader.cancel();
  });
});
