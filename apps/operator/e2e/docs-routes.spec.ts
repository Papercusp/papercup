/**
 * Docs HTTP routes — the agent-readable internal-docs surface.
 *
 * After the fumadocs → Starlight cutover, the engineering docs are
 * Starlight static output (apps/operator-docs) copied into
 * apps/operator/public/internal/docs/ and served by Next as static
 * assets under `/internal/docs`. next.config.js rewrites bare slugs to
 * their `.html` twin; proxy.ts gates the surface to loopback hosts.
 *
 *   /internal/docs                       — docs home (index.html)
 *   /internal/docs/<slug>                — page (rewritten to <slug>.html)
 *   /internal/docs/<section>/<slug>      — nested page
 *   /internal/docs/llms.txt              — sitemap-style index
 *   /internal/docs/llms-full.txt         — full corpus concatenated
 *   /internal/docs/llms-small.txt        — abridged corpus
 *
 * The spec runs against a loopback baseURL, so proxy.ts's loopback gate
 * permits every request. Per-page `Accept: text/markdown` negotiation
 * was dropped at the cutover (starlight-llms-txt emits no `.md` twins);
 * agents use the `docs:*` MCP tools or the llms-*.txt surfaces instead.
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('docs routes', () => {
  test('GET /internal/docs serves the docs home', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('GET /internal/docs/<slug> serves a rendered page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/agent-policies`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('Papercusp Internal'); // Starlight site title in <title>
  });

  test('GET /internal/docs/<slug>.html (explicit extension) serves the page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/agent-policies.html`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('GET /internal/docs/<section>/<slug> serves a nested page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/endpoint-system/overview`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('GET /internal/docs/<unknown-slug> returns 404', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/totally-fake-slug-zzz`);
    expect(res.status()).toBe(404);
  });

  test('GET /internal/docs/llms.txt returns a plaintext index', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms.txt`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/text\/plain|text\/markdown/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/^# /m); // markdown headings present
  });

  test('GET /internal/docs/llms-full.txt returns the full corpus', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms-full.txt`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(10_000); // sanity: corpus is many KB
    expect(body).toMatch(/^# /m);
  });

  test('GET /internal/docs/llms-small.txt returns the abridged corpus', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms-small.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
