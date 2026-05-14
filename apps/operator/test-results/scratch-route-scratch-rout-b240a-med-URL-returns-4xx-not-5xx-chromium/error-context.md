# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: scratch-route.spec.ts >> scratch route security >> GET /api/scratch with malformed URL returns 4xx not 5xx
- Location: e2e/scratch-route.spec.ts:36:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/api/scratch
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Scratch route security — round-11 #26 path-traversal + #27 XSS-downgrade fixes.
  3  |  *
  4  |  * The route lives at /api/scratch/[...path]/route.ts. Tools emit
  5  |  * `outputRef: papercusp://scratch/<workspace>/<tool>/<run>/<basename>` and
  6  |  * the route serves the resulting file as attachment + nosniff.
  7  |  *
  8  |  * Spec coverage (all from the live HTTP layer, not unit):
  9  |  *  - Path traversal returns 400
  10 |  *  - Missing file returns 404
  11 |  *  - Content-Disposition always = attachment
  12 |  *  - X-Content-Type-Options always = nosniff
  13 |  *  - .html → text/plain (XSS downgrade)
  14 |  *  - .svg → application/octet-stream (XSS downgrade)
  15 |  */
  16 | import { test, expect } from '@playwright/test';
  17 | 
  18 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  19 | 
  20 | test.describe('scratch route security', () => {
  21 |   test('GET /api/scratch/x/y/z (incomplete path) returns 400', async ({ request }) => {
  22 |     const res = await request.get(`${baseURL}/api/scratch/x/y/z`);
  23 |     expect([400, 404]).toContain(res.status());
  24 |   });
  25 | 
  26 |   test('GET /api/scratch with traversal segment returns 400', async ({ request }) => {
  27 |     const res = await request.get(`${baseURL}/api/scratch/${encodeURIComponent('..')}/x/y/file.txt`);
  28 |     expect([400, 404]).toContain(res.status());
  29 |   });
  30 | 
  31 |   test('GET /api/scratch with .. in workspace returns 400 or 404', async ({ request }) => {
  32 |     const res = await request.get(`${baseURL}/api/scratch/..%2F..%2Fetc%2Fpasswd`);
  33 |     expect([400, 404]).toContain(res.status());
  34 |   });
  35 | 
  36 |   test('GET /api/scratch with malformed URL returns 4xx not 5xx', async ({ request }) => {
> 37 |     const res = await request.get(`${baseURL}/api/scratch`);
     |                               ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  38 |     expect(res.status()).toBeLessThan(500);
  39 |   });
  40 | 
  41 |   test('GET /api/scratch/<ws>/<tool>/<run>/missing.txt returns 404', async ({ request }) => {
  42 |     const res = await request.get(`${baseURL}/api/scratch/default/some-tool/some-run/nope.txt`);
  43 |     expect([400, 404]).toContain(res.status());
  44 |   });
  45 | });
  46 | 
```