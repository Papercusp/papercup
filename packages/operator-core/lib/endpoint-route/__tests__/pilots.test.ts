/**
 * R1 pilot verification — the 3 real ported routes mounted on a
 * throwaway Hono app, exercised via `app.request()`. This is the proof
 * that `defineTool` serves the real endpoints identically to the Next
 * `route.ts` files they replaced — without a running operator.
 *
 *   GET  /desktop/version            — the GET + OPTIONS + CORS case
 *   POST /flags/webhook              — the public + self-authed case
 *
 * (The third pilot, POST /agent-mcp/operator-dismissed — the typed-input
 * case — was removed with the scanner card stream, unify-agent-launches
 * D-005. Typed-input route coverage now lives across the 100+ per-route
 * tests that migrated after R1.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Telemetry writes to PG — not under test here.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import desktopVersion from '../routes/desktop/version';
import flagsWebhook from '../routes/flags/webhook';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}

afterEach(() => vi.clearAllMocks());

describe('GET /desktop/version', () => {
  const app = appWith(desktopVersion as AnyRoute[]);

  it('returns the version payload as JSON', async () => {
    const res = await app.request('/desktop/version');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.appVersion).toBe('string');
    expect(typeof body.sidecarSha).toBe('string');
    expect(typeof body.sidecarStartedAtMs).toBe('number');
    expect(typeof body.nowMs).toBe('number');
    expect(typeof body.isDesktop).toBe('boolean');
  });

  it('sets permissive CORS headers', async () => {
    const res = await app.request('/desktop/version');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers the OPTIONS preflight with 204', async () => {
    const res = await app.request('/desktop/version', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});

describe('POST /flags/webhook', () => {
  const app = appWith(flagsWebhook as AnyRoute);

  it('rejects a request with no secret header (401)', async () => {
    const res = await app.request('/flags/webhook', {
      method: 'POST',
      body: JSON.stringify({ key: 'whatever' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
  });

  it('rejects a wrong secret (401)', async () => {
    const res = await app.request('/flags/webhook', {
      method: 'POST',
      body: JSON.stringify({ key: 'whatever' }),
      headers: {
        'content-type': 'application/json',
        'x-papercusp-webhook-secret': 'definitely-wrong',
      },
    });
    expect(res.status).toBe(401);
  });
});
