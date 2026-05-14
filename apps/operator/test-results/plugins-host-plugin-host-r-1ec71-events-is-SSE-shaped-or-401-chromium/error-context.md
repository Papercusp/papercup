# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: plugins-host.spec.ts >> plugin host routes >> GET /api/plugins/host/events is SSE-shaped or 401
- Location: e2e/plugins-host.spec.ts:51:7

# Error details

```
Error: expect(received).toMatch(expected)

Expected pattern: /abort/i
Received string:  "TypeError: Failed to fetch"
```

# Test source

```ts
  1  | /**
  2  |  * Plugin host route surface — the runtime/registry plane.
  3  |  *
  4  |  * /api/plugins/host/* are the operator-side endpoints the plugin runtime calls
  5  |  * to query state, invoke handlers, and stream events. These are different
  6  |  * from /api/plugins/[...path]/route.ts which is the per-plugin agent-tool
  7  |  * surface.
  8  |  *
  9  |  * Spec coverage:
  10 |  *  - runtime-status returns plugin list
  11 |  *  - query/invoke validate input shape
  12 |  *  - events SSE is shape-correct
  13 |  */
  14 | import { test, expect } from '@playwright/test';
  15 | 
  16 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  17 | 
  18 | test.describe('plugin host routes', () => {
  19 |   test('GET /api/plugins/host/runtime-status returns rows array', async ({ request }) => {
  20 |     const res = await request.get(`${baseURL}/api/plugins/host/runtime-status`);
  21 |     expect(res.status()).toBe(200);
  22 |     const body = await res.json();
  23 |     expect(body).toHaveProperty('rows');
  24 |     expect(Array.isArray(body.rows)).toBe(true);
  25 |   });
  26 | 
  27 |   test('POST /api/plugins/host/query rejects empty body', async ({ request }) => {
  28 |     const res = await request.post(`${baseURL}/api/plugins/host/query`, {
  29 |       data: {},
  30 |       headers: { 'Content-Type': 'application/json' },
  31 |     });
  32 |     expect([400, 422]).toContain(res.status());
  33 |   });
  34 | 
  35 |   test('POST /api/plugins/host/query rejects unknown query name', async ({ request }) => {
  36 |     const res = await request.post(`${baseURL}/api/plugins/host/query`, {
  37 |       data: { name: 'totally.fake.query', args: {} },
  38 |       headers: { 'Content-Type': 'application/json' },
  39 |     });
  40 |     expect([400, 500]).toContain(res.status());
  41 |   });
  42 | 
  43 |   test('POST /api/plugins/host/invoke rejects empty body', async ({ request }) => {
  44 |     const res = await request.post(`${baseURL}/api/plugins/host/invoke`, {
  45 |       data: {},
  46 |       headers: { 'Content-Type': 'application/json' },
  47 |     });
  48 |     expect([400, 422]).toContain(res.status());
  49 |   });
  50 | 
  51 |   test('GET /api/plugins/host/events is SSE-shaped or 401', async ({ page }) => {
  52 |     const result = await page.evaluate(async (url) => {
  53 |       const controller = new AbortController();
  54 |       setTimeout(() => controller.abort(), 500);
  55 |       try {
  56 |         const res = await fetch(url, { signal: controller.signal });
  57 |         return {
  58 |           status: res.status,
  59 |           contentType: res.headers.get('content-type') ?? '',
  60 |         };
  61 |       } catch (e) {
  62 |         return { error: String(e) };
  63 |       }
  64 |     }, `${baseURL}/api/plugins/host/events`);
  65 | 
  66 |     if ('error' in result) {
> 67 |       expect(result.error).toMatch(/abort/i);
     |                            ^ Error: expect(received).toMatch(expected)
  68 |     } else {
  69 |       expect([200, 401]).toContain(result.status);
  70 |     }
  71 |   });
  72 | 
  73 |   test('GET /api/plugins/host/runtime-status uses GET method (POST returns 405)', async ({ request }) => {
  74 |     const res = await request.post(`${baseURL}/api/plugins/host/runtime-status`, {
  75 |       data: {},
  76 |       headers: { 'Content-Type': 'application/json' },
  77 |     });
  78 |     expect([405, 200]).toContain(res.status());
  79 |   });
  80 | });
  81 | 
```