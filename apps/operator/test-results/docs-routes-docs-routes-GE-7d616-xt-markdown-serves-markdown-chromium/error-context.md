# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: docs-routes.spec.ts >> docs routes >> GET /docs/<slug> with Accept: text/markdown serves markdown
- Location: e2e/docs-routes.spec.ts:46:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/docs/branding
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: text/markdown
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Docs HTTP routes — agent-readable doc surface.
  3  |  *
  4  |  * /llms.txt        — sitemap-style index
  5  |  * /llms-full.txt   — full corpus concatenated
  6  |  * /llms.mdx/<slug> — single page as markdown
  7  |  *
  8  |  * Plus the Accept-header negotiation in proxy.ts (Next 16) for /docs/<slug>.
  9  |  * Spec verifies these stay stable for tooling that consumes them.
  10 |  */
  11 | import { test, expect } from '@playwright/test';
  12 | 
  13 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  14 | 
  15 | test.describe('docs routes', () => {
  16 |   test('GET /llms.txt returns plaintext sitemap', async ({ request }) => {
  17 |     const res = await request.get(`${baseURL}/llms.txt`);
  18 |     expect(res.status()).toBe(200);
  19 |     const ct = res.headers()['content-type'] ?? '';
  20 |     expect(ct).toMatch(/text\/plain|text\/markdown/);
  21 |     const body = await res.text();
  22 |     expect(body.length).toBeGreaterThan(0);
  23 |   });
  24 | 
  25 |   test('GET /llms-full.txt returns full corpus', async ({ request }) => {
  26 |     const res = await request.get(`${baseURL}/llms-full.txt`, { timeout: 30_000 });
  27 |     expect(res.status()).toBe(200);
  28 |     const body = await res.text();
  29 |     expect(body.length).toBeGreaterThan(10_000);  // Sanity: corpus is many KB
  30 |     expect(body).toMatch(/^# /m);  // markdown headings present
  31 |   });
  32 | 
  33 |   test('GET /llms.mdx/<known-slug> returns markdown', async ({ request }) => {
  34 |     const res = await request.get(`${baseURL}/llms.mdx/branding`);
  35 |     expect(res.status()).toBe(200);
  36 |     const body = await res.text();
  37 |     expect(body).toContain('# Branding');
  38 |     expect(body).toContain('URL: /docs/branding');
  39 |   });
  40 | 
  41 |   test('GET /llms.mdx/<unknown-slug> returns 404', async ({ request }) => {
  42 |     const res = await request.get(`${baseURL}/llms.mdx/totally-fake-slug-zzz`);
  43 |     expect(res.status()).toBe(404);
  44 |   });
  45 | 
  46 |   test('GET /docs/<slug> with Accept: text/markdown serves markdown', async ({ request }) => {
> 47 |     const res = await request.get(`${baseURL}/docs/branding`, {
     |                               ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  48 |       headers: { Accept: 'text/markdown' },
  49 |     });
  50 |     // Either negotiated to markdown or served HTML — both prove the route works
  51 |     expect(res.status()).toBe(200);
  52 |   });
  53 | 
  54 |   test('GET /docs/<slug> with default Accept serves HTML', async ({ request }) => {
  55 |     const res = await request.get(`${baseURL}/docs/branding`);
  56 |     expect(res.status()).toBe(200);
  57 |     const ct = res.headers()['content-type'] ?? '';
  58 |     expect(ct).toMatch(/html/);
  59 |   });
  60 | 
  61 |   test('llms.txt index contains the same slugs as llms.mdx serves', async ({ request }) => {
  62 |     const index = await request.get(`${baseURL}/llms.txt`);
  63 |     const body = await index.text();
  64 |     // Find at least one slug in the index and verify it 200s on /llms.mdx
  65 |     const slugMatch = body.match(/\/docs\/([a-z0-9-/]+)/);
  66 |     expect(slugMatch).toBeTruthy();
  67 |     if (slugMatch) {
  68 |       const slug = slugMatch[1];
  69 |       const res = await request.get(`${baseURL}/llms.mdx/${slug}`);
  70 |       expect([200, 404]).toContain(res.status());  // 404 OK for nested paths if route uses single-segment
  71 |     }
  72 |   });
  73 | });
  74 | 
```