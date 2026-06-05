/**
 * Plugin install/enable/disable/uninstall — HTTP validation surface.
 *
 * The real plugin lifecycle shells out to the `papercusp` CLI (install +
 * uninstall) or writes through plugin-enables-pg (enable). Live CLI
 * invocations are out of scope for e2e; this spec covers the validation
 * layer and method handling, which is what callers most often hit wrong.
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('plugin enable route', () => {
  test('POST with empty body returns 400 with invalid-slug message', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/enable`, { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid plugin slug/);
  });

  test('POST with non-JSON body returns 400 invalid-json', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/enable`, {
      data: 'literal-garbage',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid json');
  });

  test('POST with control-char slug rejected (400)', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/enable`, {
      data: { slug: '!!!bad', harnesses: ['org'] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid plugin slug/);
  });

  test('POST without harnesses[] returns 400', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/enable`, {
      data: { slug: 'foo' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/harnesses\[\] required/);
  });

  test('POST with invalid harness slug returns 400', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/enable`, {
      data: { slug: 'foo', harnesses: ['!!!'] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid harness slug/);
  });

  test('GET returns 405', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/plugins/enable`);
    expect(res.status()).toBe(405);
  });
});

test.describe('plugin uninstall route', () => {
  test('POST with empty body returns 400', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/uninstall`, { data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid slug/);
  });

  test('POST with non-JSON returns 400 invalid-json', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/uninstall`, {
      data: 'not-json',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid json');
  });

  test('POST with invalid slug returns 400', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/uninstall`, {
      data: { slug: '!!bad-shape!!' },
    });
    expect(res.status()).toBe(400);
  });

  test('GET returns 405', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/plugins/uninstall`);
    expect(res.status()).toBe(405);
  });
});

// (The legacy `/api/marketplace/install-plugin` route was RETIRED with the
// :3057 marketplace — revive-cupboard-distribution D-004. Plugin install now
// flows through the ungated Cupboard: POST /api/cupboard/install-plugin, covered
// by packages/operator-core/lib/cupboard/install-plugin-core.test.ts.)

test.describe('plugin enabled (read) route', () => {
  test('GET returns { enabled: { <harness>: [slugs] } }', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/plugins/enabled`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('enabled');
    expect(typeof body.enabled).toBe('object');
    for (const [_harness, slugs] of Object.entries(body.enabled)) {
      expect(Array.isArray(slugs)).toBe(true);
    }
  });

  test('GET ?plugin=<slug> returns { plugin, byHarness: {<h>: boolean} }', async ({ request }) => {
    const res = await request.get(
      `${baseURL}/api/plugins/enabled?plugin=does-not-exist-zzz`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.plugin).toBe('does-not-exist-zzz');
    expect(typeof body.byHarness).toBe('object');
    for (const v of Object.values(body.byHarness)) {
      expect(typeof v).toBe('boolean');
    }
    // Filter by a nonexistent plugin should yield all-false:
    const anyTrue = Object.values(body.byHarness).some((v) => v === true);
    expect(anyTrue).toBe(false);
  });
});
