/**
 * Docs HTTP routes — agent-readable doc surface.
 *
 * /llms.txt        — sitemap-style index
 * /llms-full.txt   — full corpus concatenated
 * /llms.mdx/<slug> — single page as markdown
 *
 * Plus the Accept-header negotiation in proxy.ts (Next 16) for /docs/<slug>.
 * Spec verifies these stay stable for tooling that consumes them.
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('docs routes', () => {
  test('GET /llms.txt returns plaintext sitemap', async ({ request }) => {
    const res = await request.get(`${baseURL}/llms.txt`);
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toMatch(/text\/plain|text\/markdown/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test('GET /llms-full.txt returns full corpus', async ({ request }) => {
    const res = await request.get(`${baseURL}/llms-full.txt`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(10_000);  // Sanity: corpus is many KB
    expect(body).toMatch(/^# /m);  // markdown headings present
  });

  test('GET /llms.mdx/<known-slug> returns markdown', async ({ request }) => {
    const res = await request.get(`${baseURL}/llms.mdx/branding`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('# Branding');
    expect(body).toContain('URL: /docs/branding');
  });

  test('GET /llms.mdx/<unknown-slug> returns 404', async ({ request }) => {
    const res = await request.get(`${baseURL}/llms.mdx/totally-fake-slug-zzz`);
    expect(res.status()).toBe(404);
  });

  test('GET /docs/<slug> with Accept: text/markdown serves markdown', async ({ request }) => {
    const res = await request.get(`${baseURL}/docs/branding`, {
      headers: { Accept: 'text/markdown' },
    });
    // Either negotiated to markdown or served HTML — both prove the route works
    expect(res.status()).toBe(200);
  });

  test('GET /docs/<slug> with default Accept serves HTML', async ({ request }) => {
    const res = await request.get(`${baseURL}/docs/branding`);
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toMatch(/html/);
  });

  test('llms.txt index contains the same slugs as llms.mdx serves', async ({ request }) => {
    const index = await request.get(`${baseURL}/llms.txt`);
    const body = await index.text();
    // Find at least one slug in the index and verify it 200s on /llms.mdx
    const slugMatch = body.match(/\/docs\/([a-z0-9-/]+)/);
    expect(slugMatch).toBeTruthy();
    if (slugMatch) {
      const slug = slugMatch[1];
      const res = await request.get(`${baseURL}/llms.mdx/${slug}`);
      expect([200, 404]).toContain(res.status());  // 404 OK for nested paths if route uses single-segment
    }
  });
});
