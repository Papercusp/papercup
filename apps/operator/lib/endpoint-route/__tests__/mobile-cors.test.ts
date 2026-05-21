/**
 * E3 tests (endpoint-unification-2026-05-21) — the `mobile: true` flag.
 *
 * Covers the two things the flag does:
 *   1. `registerRoute` mounts the shared `mobileCors` middleware, so the
 *      cross-origin phone client + its OPTIONS preflight are handled
 *      without a per-route CORS block.
 *   2. `defineTool` folds `'mobile'` into an explicit `auth.kind`
 *      allowlist so the device-JWT principal is admitted.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { registerRoute } from '../define-route';
import { mobileOrigin } from '../cors';

describe('mobile: true — auth.kind folding (E3)', () => {
  it('adds "mobile" to an explicit kind allowlist', () => {
    const def = defineTool({
      method: 'GET',
      path: '/mobile/fixture-a',
      auth: { kind: ['user'] },
      mobile: true,
      handler: () => new Response('ok'),
    });
    expect(def.auth).toEqual({ kind: ['user', 'mobile'] });
  });

  it('is idempotent — does not double-add when "mobile" already present', () => {
    const def = defineTool({
      method: 'GET',
      path: '/mobile/fixture-b',
      auth: { kind: ['mobile', 'user'] },
      mobile: true,
      handler: () => new Response('ok'),
    });
    expect((def.auth as { kind: string[] }).kind).toEqual(['mobile', 'user']);
  });

  it('leaves auth:"public" untouched (CORS-only opt-in)', () => {
    const def = defineTool({
      method: 'GET',
      path: '/mobile/fixture-c',
      auth: 'public',
      mobile: true,
      handler: () => new Response('ok'),
    });
    expect(def.auth).toBe('public');
  });

  it('leaves a kind-unrestricted gate untouched (mobile already allowed)', () => {
    const def = defineTool({
      method: 'GET',
      path: '/mobile/fixture-d',
      auth: { trust: ['verified'] },
      mobile: true,
      handler: () => new Response('ok'),
    });
    expect(def.auth).toEqual({ trust: ['verified'] });
  });
});

describe('mobileOrigin allowlist (E3)', () => {
  it('admits the desktop WebView + dev origins', () => {
    expect(mobileOrigin('http://tauri.localhost')).toBe('http://tauri.localhost');
    expect(mobileOrigin('https://tauri.localhost')).toBe('https://tauri.localhost');
    expect(mobileOrigin('http://localhost:1420')).toBe('http://localhost:1420');
    expect(mobileOrigin('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(mobileOrigin('http://10.0.2.2:3070')).toBe('http://10.0.2.2:3070');
  });

  it('refuses an unknown origin', () => {
    expect(mobileOrigin('https://evil.example.com')).toBe('');
    expect(mobileOrigin('http://papercuspai.com')).toBe('');
  });
});

describe('registerRoute — mobileCors middleware (E3)', () => {
  it('answers an OPTIONS preflight with CORS headers for a mobile route', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'POST',
        path: '/mobile/ping',
        auth: 'public',
        mobile: true,
        input: z.object({}),
        // sampleRate 0 — this is a CORS unit test with no DB; skip the
        // route-stack telemetry write (which would warn on a failed insert).
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const res = await app.request('http://x.test/api/mobile/ping', {
      method: 'OPTIONS',
      headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'POST' },
    });
    // cors() short-circuits the preflight with 204 + headers.
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('echoes the allowed origin on a real mobile request', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'GET',
        path: '/mobile/echo',
        auth: 'public',
        mobile: true,
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const res = await app.request('http://x.test/api/mobile/echo', {
      method: 'GET',
      headers: { Origin: 'http://10.0.2.2:3070' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://10.0.2.2:3070');
  });

  it('does NOT attach CORS to a non-mobile route', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'GET',
        path: '/desktop/plain',
        auth: 'public',
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const res = await app.request('http://x.test/api/desktop/plain', {
      method: 'GET',
      headers: { Origin: 'http://tauri.localhost' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
