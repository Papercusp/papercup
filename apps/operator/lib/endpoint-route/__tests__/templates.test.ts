/**
 * Smoke tests for the ported `templates` family — validation branches
 * (slug/version/path/allowlist regexes) and the marketplace-token
 * pre-flight. FS reads are mocked at the boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@/lib/require-flag', () => ({ gateApiRoute: vi.fn(async () => null) }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { TEMPLATES: 'templates' } }));
vi.mock('@/lib/papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => '/tmp/papercusp/' + parts.join('/'),
}));
vi.mock('@/lib/marketplace-token', () => ({ readFirstServiceToken: vi.fn(async () => null) }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import templatesIndex from '../routes/templates/index';
import templatesVersion from '../routes/templates/version';
import templatesFile from '../routes/templates/file';
import templatesInstall from '../routes/templates/install';
import templatesPublish from '../routes/templates/publish';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object | string) => ({
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('templates family ports', () => {
  it('GET /templates returns empty list when root missing', async () => {
    const res = await appWith(templatesIndex as AnyRoute).request('/templates');
    expect(res.status).toBe(200);
    expect((await res.json()).templates).toEqual([]);
  });

  it('GET /templates/:slug/:version rejects bad slug with 400', async () => {
    const res = await appWith(templatesVersion as AnyRoute[]).request('/templates/!bad/v1');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid slug');
  });

  it('GET /templates/:slug/:version rejects bad version with 400', async () => {
    const res = await appWith(templatesVersion as AnyRoute[]).request('/templates/good/!bad');
    expect(res.status).toBe(400);
  });

  it('GET /templates/:slug/:version returns 404 for missing manifest', async () => {
    const res = await appWith(templatesVersion as AnyRoute[]).request('/templates/good/v1');
    expect(res.status).toBe(404);
  });

  it('DELETE /templates/:slug/:version rejects bad slug with 400', async () => {
    const res = await appWith(templatesVersion as AnyRoute[]).request('/templates/!bad/v1', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('GET /templates/:slug/:version/file rejects missing path with 400', async () => {
    const res = await appWith(templatesFile as AnyRoute[]).request('/templates/good/v1/file');
    expect(res.status).toBe(400);
  });

  it('PUT /templates/:slug/:version/file rejects invalid JSON', async () => {
    const res = await appWith(templatesFile as AnyRoute[]).request('/templates/good/v1/file', {
      method: 'PUT', body: 'not json', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /templates/:slug/:version/install rejects bad slug with 400', async () => {
    const res = await appWith(templatesInstall as AnyRoute).request('/templates/!bad/v1/install', post({}));
    expect(res.status).toBe(400);
  });

  it('POST /templates/:slug/:version/install rejects bad projectSlug with 400', async () => {
    const res = await appWith(templatesInstall as AnyRoute).request('/templates/good/v1/install', post({ projectSlug: '!Bad' }));
    expect(res.status).toBe(400);
  });

  it('POST /templates/:slug/:version/publish returns 404 when template missing', async () => {
    const res = await appWith(templatesPublish as AnyRoute).request('/templates/missing/v1/publish', post({}));
    expect(res.status).toBe(404);
  });
});
