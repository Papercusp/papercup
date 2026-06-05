/**
 * CORS tests (endpoint-unification-2026-05-21) — the general `cors` route
 * field.
 *
 * `registerRoute` mounts the shared CORS middleware for `cors`-enabled
 * routes, so the cross-origin client + its OPTIONS preflight are handled
 * without a per-route CORS block. `cors` is orthogonal to auth — a route
 * declares its own `auth` separately.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { registerRoute } from '../define-route';
import { defaultCorsOrigin } from '../cors';

describe('defaultCorsOrigin allowlist', () => {
  it('admits the desktop WebView + dev origins', () => {
    expect(defaultCorsOrigin('http://tauri.localhost')).toBe('http://tauri.localhost');
    expect(defaultCorsOrigin('https://tauri.localhost')).toBe('https://tauri.localhost');
    expect(defaultCorsOrigin('http://localhost:1420')).toBe('http://localhost:1420');
    expect(defaultCorsOrigin('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(defaultCorsOrigin('http://10.0.2.2:3070')).toBe('http://10.0.2.2:3070');
  });

  it('refuses an unknown origin', () => {
    expect(defaultCorsOrigin('https://evil.example.com')).toBe('');
    expect(defaultCorsOrigin('http://papercuspai.com')).toBe('');
  });
});

describe('registerRoute — CORS middleware', () => {
  it('answers an OPTIONS preflight with CORS headers for a cors route', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'POST',
        path: '/device/ping',
        auth: 'public',
        cors: true,
        input: z.object({}),
        // sampleRate 0 — CORS unit test with no DB; skip the route-stack
        // telemetry write (which would warn on a failed insert).
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const res = await app.request('http://x.test/api/device/ping', {
      method: 'OPTIONS',
      headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'POST' },
    });
    // cors() short-circuits the preflight with 204 + headers.
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('echoes the allowed origin on a real cross-origin request', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'GET',
        path: '/device/echo',
        auth: 'public',
        cors: true,
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const res = await app.request('http://x.test/api/device/echo', {
      method: 'GET',
      headers: { Origin: 'http://10.0.2.2:3070' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://10.0.2.2:3070');
  });

  it('does NOT attach CORS to a route without `cors`', async () => {
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

  it('honours an explicit `cors: { origins }` override', async () => {
    const app = new Hono().basePath('/api');
    registerRoute(
      app,
      defineTool({
        method: 'GET',
        path: '/device/custom-origin',
        auth: 'public',
        cors: { origins: ['https://allowed.example.com'] },
        sampleRate: 0,
        handler: () => Response.json({ ok: true }),
      }),
    );

    const ok = await app.request('http://x.test/api/device/custom-origin', {
      headers: { Origin: 'https://allowed.example.com' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');

    const denied = await app.request('http://x.test/api/device/custom-origin', {
      headers: { Origin: 'http://tauri.localhost' },
    });
    // tauri.localhost is in the *default* allowlist but not this route's override.
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
