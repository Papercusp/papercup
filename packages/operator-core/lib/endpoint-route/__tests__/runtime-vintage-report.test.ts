/**
 * POST /internal/runtime-vintage — the dependency-free watchdog self-report
 * sink (fleet-reliability-verification-2026-07-10 P-008).
 *
 * `runtime-vintage`'s store is mocked so this stays PG-free; the point is to
 * pin the route's own contract (loopback-only, validates the body, always
 * 200s even on a store failure — never a hard error to a fire-and-forget
 * watchdog POST).
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  reportRuntimeVintage: vi.fn(async () => {}),
}));

vi.mock('../../runtime-vintage', () => ({ reportRuntimeVintage: h.reportRuntimeVintage }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import runtimeVintageReport from '../routes/misc/runtime-vintage-report';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(): Hono {
  const app = new Hono();
  registerRoute(app, runtimeVintageReport as AnyRoute);
  return app;
}

const post = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

describe('POST /internal/runtime-vintage', () => {
  it('accepts a minimal valid report and forwards it to reportRuntimeVintage', async () => {
    const resp = await appWith().request('/internal/runtime-vintage', post({ unit: 'bghost-watchdog' }));
    expect(resp.status).toBe(200);
    expect((await resp.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(h.reportRuntimeVintage).toHaveBeenCalledWith(expect.objectContaining({ unit: 'bghost-watchdog' }));
  });

  it('rejects a body missing the required `unit` field', async () => {
    const resp = await appWith().request('/internal/runtime-vintage', post({ host: 'tower' }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it('rejects invalid JSON', async () => {
    const resp = await appWith().request('/internal/runtime-vintage', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(resp.status).toBe(400);
  });

  it('a store failure still answers 200 ok:false — never a hard error to a fire-and-forget caller', async () => {
    h.reportRuntimeVintage.mockRejectedValueOnce(new Error('pg unreachable'));
    const resp = await appWith().request('/internal/runtime-vintage', post({ unit: 'gateway' }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/pg unreachable/);
  });

  it('forwards the full optional field set through', async () => {
    const resp = await appWith().request(
      '/internal/runtime-vintage',
      post({
        unit: 'inference-gateway-watchdog',
        host: 'tower',
        treeSha: 'abc1234',
        buildTime: '2026-07-10T00:00:00.000Z',
        bundleVersion: '1.2.3',
        pid: 999,
        extra: { platform: 'linux' },
      }),
    );
    expect(resp.status).toBe(200);
    expect(h.reportRuntimeVintage).toHaveBeenCalledWith(
      expect.objectContaining({
        unit: 'inference-gateway-watchdog',
        host: 'tower',
        treeSha: 'abc1234',
        bundleVersion: '1.2.3',
        pid: 999,
        extra: { platform: 'linux' },
      }),
    );
  });
});
