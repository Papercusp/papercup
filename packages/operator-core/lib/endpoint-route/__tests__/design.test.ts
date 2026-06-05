/**
 * Smoke tests for the ported `design` family — validation branches +
 * flag-gate plumbing. PG paths are mocked at the boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../require-flag', () => ({ gateApiRoute: vi.fn(async () => null) }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { DESIGN: 'design' } }));
vi.mock('@papercusp/db-org', async (orig) => ({
  // Keep real `generated`/`schemaOf`/`withWorkspace` (side-effect-free schema
  // defs) so route modules that read `generated.<table>` at import don't crash
  // vitest's strict named-export check; only the connection is stubbed.
  ...((await orig()) as object),
  getOrgPg: vi.fn(() => ({
    sql: Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
      { begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        unsafe: vi.fn(async () => {}),
      })) },
    ),
  })),
}));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import designFeatures from '../routes/design/features';
import designRegressions from '../routes/design/regressions';
import designRegressionFile from '../routes/design/regression-file';
import designSketches from '../routes/design/sketches';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('design family ports', () => {
  it('GET /design/features rejects missing harness with 400', async () => {
    const res = await appWith(designFeatures as AnyRoute).request('/design/features');
    expect(res.status).toBe(400);
  });

  it('GET /design/regressions returns counts + items', async () => {
    const res = await appWith(designRegressions as AnyRoute).request('/design/regressions');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('GET /design/regressions/:bucket/:file rejects unknown bucket with 400', async () => {
    const res = await appWith(designRegressionFile as AnyRoute)
      .request('/design/regressions/nope/file.png');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown bucket');
  });

  it('GET /design/regressions/baseline/:file rejects bad filename with 400', async () => {
    const res = await appWith(designRegressionFile as AnyRoute)
      .request('/design/regressions/baseline/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('GET /design/sketches rejects missing harness/feature with 400', async () => {
    const res = await appWith(designSketches as AnyRoute[]).request('/design/sketches');
    expect(res.status).toBe(400);
  });

  it('POST /design/sketches rejects invalid JSON with 400', async () => {
    const res = await appWith(designSketches as AnyRoute[]).request('/design/sketches', {
      method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /design/sketches rejects non-data-URL png with 400', async () => {
    const res = await appWith(designSketches as AnyRoute[]).request(
      '/design/sketches', post({ harness: 'h', feature: 'f', png: 'not-a-data-url' }),
    );
    expect(res.status).toBe(400);
  });
});
