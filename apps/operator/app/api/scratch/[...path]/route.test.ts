/**
 * Tests for the /api/scratch/[...path] route's response headers.
 *
 * Round-11 fixed bug #27 (XSS via tool-authored content) by:
 *   - Always setting Content-Disposition: attachment
 *   - Always setting X-Content-Type-Options: nosniff
 *   - Downgrading html/svg/markdown content-types
 *
 * Round-13 E2E couldn't reach the live route (PG cache hang). These
 * tests lock the contract by calling GET directly with a synthetic
 * NextRequest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
}));

const ROOT = '/tmp/e2e-scratch-route-test';
const WS = 'default';
const TOOL = 'demo.export';
const RUN = '12345678-1234-1234-1234-123456789012';

describe('GET /api/scratch/[...path] — round-11 bug #27 headers', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_SCRATCH_ROOT = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, WS, TOOL, RUN), { recursive: true });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  async function get(basename: string, content: string): Promise<Response> {
    writeFileSync(join(ROOT, WS, TOOL, RUN, basename), content);
    const { GET } = await import('./route');
    const url = `http://localhost:3055/api/scratch/${WS}/${TOOL}/${RUN}/${basename}`;
    return GET({ url } as never);
  }

  it('responds 200 + Content-Disposition: attachment for a normal CSV', async () => {
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

  it('serves .svg as application/octet-stream (NOT image/svg+xml) — XSS downgrade', async () => {
    const resp = await get('vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    expect(resp.headers.get('content-type')).toBe('application/octet-stream');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves .md as text/plain (NOT text/markdown) — XSS downgrade', async () => {
    const resp = await get('notes.md', '# Title\n');
    expect(resp.headers.get('content-type')).toBe('text/plain');
  });

  it('PATH TRAVERSAL: workspace=".." → 400 (caught by parseScratchUri)', async () => {
    const { GET } = await import('./route');
    const url = `http://localhost:3055/api/scratch/..%2F..%2F..%2Fetc%2Fpasswd/${TOOL}/${RUN}/x.txt`;
    const resp = await GET({ url } as never);
    expect(resp.status).toBe(400);
  });

  it('cross-workspace request → 403', async () => {
    writeFileSync(join(ROOT, WS, TOOL, RUN, 'safe.txt'), 'ok');
    const { GET } = await import('./route');
    const url = `http://localhost:3055/api/scratch/other-workspace/${TOOL}/${RUN}/safe.txt`;
    const resp = await GET({ url } as never);
    expect(resp.status).toBe(403);
  });

  it('not-found → 404', async () => {
    const { GET } = await import('./route');
    const url = `http://localhost:3055/api/scratch/${WS}/${TOOL}/${RUN}/nope.txt`;
    const resp = await GET({ url } as never);
    expect(resp.status).toBe(404);
  });
});
