# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: harness-routes.spec.ts >> harness route surface >> GET /api/harness/search without q returns 400 or empty array
- Location: e2e/harness-routes.spec.ts:27:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/api/harness/search
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Harness-facing route surface — operator's harness query + KPI endpoints.
  3  |  *
  4  |  * These specs verify the shape contracts the harness UI depends on. They
  5  |  * are read-only and don't mutate harness state.
  6  |  */
  7  | import { test, expect } from '@playwright/test';
  8  | 
  9  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  10 | 
  11 | test.describe('harness route surface', () => {
  12 |   test('GET /api/harness/all/kpis returns KPI shape', async ({ request }) => {
  13 |     const res = await request.get(`${baseURL}/api/harness/all/kpis`);
  14 |     expect(res.status()).toBe(200);
  15 |     const body = await res.json();
  16 |     expect(typeof body).toBe('object');
  17 |   });
  18 | 
  19 |   test('GET /api/harness/search?q=test returns results array', async ({ request }) => {
  20 |     const res = await request.get(`${baseURL}/api/harness/search?q=test`);
  21 |     expect(res.status()).toBe(200);
  22 |     const body = await res.json();
  23 |     // Either { results: [...] } or { rows: [...] } or array directly
  24 |     expect(typeof body).toBe('object');
  25 |   });
  26 | 
  27 |   test('GET /api/harness/search without q returns 400 or empty array', async ({ request }) => {
> 28 |     const res = await request.get(`${baseURL}/api/harness/search`);
     |                               ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  29 |     expect([200, 400]).toContain(res.status());
  30 |   });
  31 | 
  32 |   test('POST /api/zero-harness/rest-query without body returns 4xx', async ({ request }) => {
  33 |     const res = await request.post(`${baseURL}/api/zero-harness/rest-query`, {
  34 |       data: {},
  35 |       headers: { 'Content-Type': 'application/json' },
  36 |     });
  37 |     // 400 (missing name), 405 (wrong verb), or 200 if it accepts empty
  38 |     expect([200, 400, 401, 405, 500]).toContain(res.status());
  39 |   });
  40 | 
  41 |   test('GET /api/zero-harness/sse is SSE-shaped or 401', async ({ page }) => {
  42 |     const result = await page.evaluate(async (url) => {
  43 |       const controller = new AbortController();
  44 |       setTimeout(() => controller.abort(), 500);
  45 |       try {
  46 |         const res = await fetch(url, { signal: controller.signal });
  47 |         return {
  48 |           status: res.status,
  49 |           contentType: res.headers.get('content-type') ?? '',
  50 |         };
  51 |       } catch (e) {
  52 |         return { error: String(e) };
  53 |       }
  54 |     }, `${baseURL}/api/zero-harness/sse`);
  55 | 
  56 |     if ('error' in result) {
  57 |       expect(result.error).toMatch(/abort/i);
  58 |     } else {
  59 |       expect([200, 401]).toContain(result.status);
  60 |     }
  61 |   });
  62 | });
  63 | 
```