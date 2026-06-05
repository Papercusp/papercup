/**
 * Locks the round-11 bug #27 contract for the ported scratch route:
 *   - Always sets Content-Disposition: attachment
 *   - Always sets X-Content-Type-Options: nosniff
 *   - Downgrades html/svg/markdown content-types
 *   - Rejects path traversal at the URI layer
 *   - Rejects cross-workspace access
 *
 * Carried over from app/api/scratch/[...path]/route.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import miscScratch from '../routes/misc/scratch';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

const ROOT = '/tmp/e2e-scratch-route-test';
const WS = 'default';
const TOOL = 'demo.export';
const RUN = '12345678-1234-1234-1234-123456789012';

function appWith(): Hono {
  const app = new Hono();
  registerRoute(app, miscScratch as AnyRoute);
  return app;
}

describe('GET /scratch/:path{.+} — round-11 bug #27 headers', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_SCRATCH_ROOT = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, WS, TOOL, RUN), { recursive: true });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  async function get(basename: string, content: string): Promise<Response> {
    writeFileSync(join(ROOT, WS, TOOL, RUN, basename), content);
    return appWith().request(`/scratch/${WS}/${TOOL}/${RUN}/${basename}`);
  }

  it('200 + Content-Disposition: attachment for a normal CSV', async () => {
    const resp = await get('out.csv', 'id,name\n1,Alice\n');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')).toBe('attachment; filename="out.csv"');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resp.headers.get('content-type')).toBe('text/csv');
  });

  it('serves .html as text/plain (NOT text/html) — XSS downgrade', async () => {
    const resp = await get('payload.html', '<script>alert(1)</script>');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/plain');
    expect(resp.headers.get('content-disposition')).toBe('attachment; filename="payload.html"');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves .svg as application/octet-stream — XSS downgrade', async () => {
    const resp = await get('vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    expect(resp.headers.get('content-type')).toBe('application/octet-stream');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves .md as text/plain (NOT text/markdown) — XSS downgrade', async () => {
    const resp = await get('notes.md', '# Title\n');
    expect(resp.headers.get('content-type')).toBe('text/plain');
  });

  it('PATH TRAVERSAL: workspace=".." → 400 (parseScratchUri rejection)', async () => {
    const resp = await appWith().request(`/scratch/..%2F..%2F..%2Fetc%2Fpasswd/${TOOL}/${RUN}/x.txt`);
    expect(resp.status).toBe(400);
  });

  it('cross-workspace request → 403', async () => {
    writeFileSync(join(ROOT, WS, TOOL, RUN, 'safe.txt'), 'ok');
    const resp = await appWith().request(`/scratch/other-workspace/${TOOL}/${RUN}/safe.txt`);
    expect(resp.status).toBe(403);
  });

  it('not-found → 404', async () => {
    const resp = await appWith().request(`/scratch/${WS}/${TOOL}/${RUN}/nope.txt`);
    expect(resp.status).toBe(404);
  });
});
