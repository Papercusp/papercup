# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: plugins-lifecycle.spec.ts >> plugin enable route >> POST without harnesses[] returns 400
- Location: e2e/plugins-lifecycle.spec.ts:40:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/plugins/enable
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 14

```

# Test source

```ts
  1   | /**
  2   |  * Plugin install/enable/disable/uninstall — HTTP validation surface.
  3   |  *
  4   |  * The real plugin lifecycle shells out to the `papercusp` CLI (install +
  5   |  * uninstall) or writes through plugin-enables-pg (enable). Live CLI
  6   |  * invocations are out of scope for e2e; this spec covers the validation
  7   |  * layer and method handling, which is what callers most often hit wrong.
  8   |  */
  9   | import { test, expect } from '@playwright/test';
  10  | 
  11  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  12  | 
  13  | test.describe('plugin enable route', () => {
  14  |   test('POST with empty body returns 400 with invalid-slug message', async ({ request }) => {
  15  |     const res = await request.post(`${baseURL}/api/plugins/enable`, { data: {} });
  16  |     expect(res.status()).toBe(400);
  17  |     const body = await res.json();
  18  |     expect(body.ok).toBe(false);
  19  |     expect(body.error).toMatch(/invalid plugin slug/);
  20  |   });
  21  | 
  22  |   test('POST with non-JSON body returns 400 invalid-json', async ({ request }) => {
  23  |     const res = await request.post(`${baseURL}/api/plugins/enable`, {
  24  |       data: 'literal-garbage',
  25  |       headers: { 'Content-Type': 'text/plain' },
  26  |     });
  27  |     expect(res.status()).toBe(400);
  28  |     const body = await res.json();
  29  |     expect(body.error).toBe('invalid json');
  30  |   });
  31  | 
  32  |   test('POST with control-char slug rejected (400)', async ({ request }) => {
  33  |     const res = await request.post(`${baseURL}/api/plugins/enable`, {
  34  |       data: { slug: '!!!bad', harnesses: ['org'] },
  35  |     });
  36  |     expect(res.status()).toBe(400);
  37  |     expect((await res.json()).error).toMatch(/invalid plugin slug/);
  38  |   });
  39  | 
  40  |   test('POST without harnesses[] returns 400', async ({ request }) => {
> 41  |     const res = await request.post(`${baseURL}/api/plugins/enable`, {
      |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  42  |       data: { slug: 'foo' },
  43  |     });
  44  |     expect(res.status()).toBe(400);
  45  |     expect((await res.json()).error).toMatch(/harnesses\[\] required/);
  46  |   });
  47  | 
  48  |   test('POST with invalid harness slug returns 400', async ({ request }) => {
  49  |     const res = await request.post(`${baseURL}/api/plugins/enable`, {
  50  |       data: { slug: 'foo', harnesses: ['!!!'] },
  51  |     });
  52  |     expect(res.status()).toBe(400);
  53  |     expect((await res.json()).error).toMatch(/invalid harness slug/);
  54  |   });
  55  | 
  56  |   test('GET returns 405', async ({ request }) => {
  57  |     const res = await request.get(`${baseURL}/api/plugins/enable`);
  58  |     expect(res.status()).toBe(405);
  59  |   });
  60  | });
  61  | 
  62  | test.describe('plugin uninstall route', () => {
  63  |   test('POST with empty body returns 400', async ({ request }) => {
  64  |     const res = await request.post(`${baseURL}/api/plugins/uninstall`, { data: {} });
  65  |     expect(res.status()).toBe(400);
  66  |     expect((await res.json()).error).toMatch(/invalid slug/);
  67  |   });
  68  | 
  69  |   test('POST with non-JSON returns 400 invalid-json', async ({ request }) => {
  70  |     const res = await request.post(`${baseURL}/api/plugins/uninstall`, {
  71  |       data: 'not-json',
  72  |       headers: { 'Content-Type': 'text/plain' },
  73  |     });
  74  |     expect(res.status()).toBe(400);
  75  |     expect((await res.json()).error).toBe('invalid json');
  76  |   });
  77  | 
  78  |   test('POST with invalid slug returns 400', async ({ request }) => {
  79  |     const res = await request.post(`${baseURL}/api/plugins/uninstall`, {
  80  |       data: { slug: '!!bad-shape!!' },
  81  |     });
  82  |     expect(res.status()).toBe(400);
  83  |   });
  84  | 
  85  |   test('GET returns 405', async ({ request }) => {
  86  |     const res = await request.get(`${baseURL}/api/plugins/uninstall`);
  87  |     expect(res.status()).toBe(405);
  88  |   });
  89  | });
  90  | 
  91  | test.describe('marketplace install-plugin route', () => {
  92  |   test('POST returns 404 with feature-disabled when MARKETPLACE flag off', async ({ request }) => {
  93  |     // The marketplace flag is off in dev by default; the gate fires before
  94  |     // body validation, so even garbage bodies surface the flag rejection.
  95  |     const res = await request.post(`${baseURL}/api/marketplace/install-plugin`, { data: {} });
  96  |     expect(res.status()).toBe(404);
  97  |     const body = await res.json();
  98  |     expect(body.ok).toBe(false);
  99  |     expect(body.reason).toBe('feature-disabled');
  100 |     expect(body.flag).toBeTruthy();
  101 |   });
  102 | 
  103 |   test('POST with invalid slug still surfaces feature-disabled (gate-first ordering)', async ({
  104 |     request,
  105 |   }) => {
  106 |     const res = await request.post(`${baseURL}/api/marketplace/install-plugin`, {
  107 |       data: { slug: '!!!' },
  108 |     });
  109 |     expect(res.status()).toBe(404);
  110 |     expect((await res.json()).reason).toBe('feature-disabled');
  111 |   });
  112 | 
  113 |   test('GET returns 405', async ({ request }) => {
  114 |     const res = await request.get(`${baseURL}/api/marketplace/install-plugin`);
  115 |     expect(res.status()).toBe(405);
  116 |   });
  117 | });
  118 | 
  119 | test.describe('plugin enabled (read) route', () => {
  120 |   test('GET returns { enabled: { <harness>: [slugs] } }', async ({ request }) => {
  121 |     const res = await request.get(`${baseURL}/api/plugins/enabled`);
  122 |     expect(res.status()).toBe(200);
  123 |     const body = await res.json();
  124 |     expect(body).toHaveProperty('enabled');
  125 |     expect(typeof body.enabled).toBe('object');
  126 |     for (const [_harness, slugs] of Object.entries(body.enabled)) {
  127 |       expect(Array.isArray(slugs)).toBe(true);
  128 |     }
  129 |   });
  130 | 
  131 |   test('GET ?plugin=<slug> returns { plugin, byHarness: {<h>: boolean} }', async ({ request }) => {
  132 |     const res = await request.get(
  133 |       `${baseURL}/api/plugins/enabled?plugin=does-not-exist-zzz`,
  134 |     );
  135 |     expect(res.status()).toBe(200);
  136 |     const body = await res.json();
  137 |     expect(body.plugin).toBe('does-not-exist-zzz');
  138 |     expect(typeof body.byHarness).toBe('object');
  139 |     for (const v of Object.values(body.byHarness)) {
  140 |       expect(typeof v).toBe('boolean');
  141 |     }
```