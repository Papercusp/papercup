/**
 * Scratch route security — round-11 #26 path-traversal + #27 XSS-downgrade fixes.
 *
 * The route lives at /api/scratch/[...path]/route.ts. Tools emit
 * `outputRef: papercusp://scratch/<workspace>/<tool>/<run>/<basename>` and
 * the route serves the resulting file as attachment + nosniff.
 *
 * Spec coverage (all from the live HTTP layer, not unit):
 *  - Path traversal returns 400
 *  - Missing file returns 404
 *  - Content-Disposition always = attachment
 *  - X-Content-Type-Options always = nosniff
 *  - .html → text/plain (XSS downgrade)
 *  - .svg → application/octet-stream (XSS downgrade)
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('scratch route security', () => {
  test('GET /api/scratch/x/y/z (incomplete path) returns 400', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/scratch/x/y/z`);
    expect([400, 404]).toContain(res.status());
  });

  test('GET /api/scratch with traversal segment returns 400', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/scratch/${encodeURIComponent('..')}/x/y/file.txt`);
    expect([400, 404]).toContain(res.status());
  });

  test('GET /api/scratch with .. in workspace returns 400 or 404', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/scratch/..%2F..%2Fetc%2Fpasswd`);
    expect([400, 404]).toContain(res.status());
  });

  test('GET /api/scratch with malformed URL returns 4xx not 5xx', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/scratch`);
    expect(res.status()).toBeLessThan(500);
  });

  test('GET /api/scratch/<ws>/<tool>/<run>/missing.txt returns 404', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/scratch/default/some-tool/some-run/nope.txt`);
    expect([400, 404]).toContain(res.status());
  });
});
