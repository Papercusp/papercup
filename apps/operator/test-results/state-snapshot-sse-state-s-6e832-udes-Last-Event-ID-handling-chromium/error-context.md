# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: state-snapshot-sse.spec.ts >> state-snapshot SSE >> GET /api/operator/state-snapshot includes Last-Event-ID handling
- Location: e2e/state-snapshot-sse.spec.ts:38:7

# Error details

```
Error: expect(received).toMatch(expected)

Expected pattern: /abort/i
Received string:  "TypeError: Failed to fetch"
```

# Test source

```ts
  1  | /**
  2  |  * State-snapshot SSE — the bespoke-card system's state channel.
  3  |  *
  4  |  * /api/operator/state-snapshot publishes (cards, tool-states, etc.) as
  5  |  * SSE events keyed on workspace. Spec verifies the stream shape; the
  6  |  * full card-correlator + workspace-lifecycle behavior is unit-tested.
  7  |  */
  8  | import { test, expect } from '@playwright/test';
  9  | 
  10 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  11 | 
  12 | test.describe('state-snapshot SSE', () => {
  13 |   test('GET /api/operator/state-snapshot is SSE-shaped or auth-gated', async ({ page }) => {
  14 |     const result = await page.evaluate(async (url) => {
  15 |       const controller = new AbortController();
  16 |       setTimeout(() => controller.abort(), 600);
  17 |       try {
  18 |         const res = await fetch(url, { signal: controller.signal });
  19 |         return {
  20 |           status: res.status,
  21 |           contentType: res.headers.get('content-type') ?? '',
  22 |         };
  23 |       } catch (e) {
  24 |         return { error: String(e) };
  25 |       }
  26 |     }, `${baseURL}/api/operator/state-snapshot`);
  27 | 
  28 |     if ('error' in result) {
  29 |       expect(result.error).toMatch(/abort/i);
  30 |     } else {
  31 |       expect([200, 401, 403]).toContain(result.status);
  32 |       if (result.status === 200) {
  33 |         expect(result.contentType).toMatch(/event-stream/);
  34 |       }
  35 |     }
  36 |   });
  37 | 
  38 |   test('GET /api/operator/state-snapshot includes Last-Event-ID handling', async ({ page }) => {
  39 |     // Probe with Last-Event-ID header — the route should accept it for resumption.
  40 |     const result = await page.evaluate(async (url) => {
  41 |       const controller = new AbortController();
  42 |       setTimeout(() => controller.abort(), 400);
  43 |       try {
  44 |         const res = await fetch(url, {
  45 |           signal: controller.signal,
  46 |           headers: { 'Last-Event-ID': 'test-resume-id' },
  47 |         });
  48 |         return { status: res.status };
  49 |       } catch (e) {
  50 |         return { error: String(e) };
  51 |       }
  52 |     }, `${baseURL}/api/operator/state-snapshot`);
  53 | 
  54 |     if ('error' in result) {
> 55 |       expect(result.error).toMatch(/abort/i);
     |                            ^ Error: expect(received).toMatch(expected)
  56 |     } else {
  57 |       // The route should still respond (200 or auth-reject), not 500
  58 |       expect(result.status).toBeLessThan(500);
  59 |     }
  60 |   });
  61 | });
  62 | 
```