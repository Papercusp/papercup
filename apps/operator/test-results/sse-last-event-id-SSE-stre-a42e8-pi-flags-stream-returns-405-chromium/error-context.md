# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sse-last-event-id.spec.ts >> SSE stream shape (zero-harness + flags) >> POST /api/flags/stream returns 405
- Location: e2e/sse-last-event-id.spec.ts:96:9

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/flags/stream
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 2

```

# Test source

```ts
  1   | /**
  2   |  * SSE stream-shape + Last-Event-ID handling.
  3   |  *
  4   |  * Wire-format byte-exactness is unit-tested in
  5   |  * libs/sse/src/wire-format-snapshot.test.ts. This e2e verifies the live
  6   |  * route obeys the contract:
  7   |  *   - 200 + text/event-stream + x-accel-buffering:no
  8   |  *   - initial heartbeat is sent immediately (within ~1s)
  9   |  *   - Last-Event-ID is parsed defensively (malformed/empty/negative all
  10  |  *     yield a fresh 200 stream, NOT a 4xx/5xx)
  11  |  *   - POST returns 405
  12  |  */
  13  | import { test, expect } from '@playwright/test';
  14  | 
  15  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  16  | 
  17  | const SSE_ROUTES = [
  18  |   '/api/zero-harness/sse',
  19  |   '/api/flags/stream',
  20  | ] as const;
  21  | 
  22  | interface FirstChunk {
  23  |   status: number;
  24  |   ct: string;
  25  |   xAccel: string;
  26  |   body: string;
  27  |   error?: string;
  28  | }
  29  | 
  30  | async function readFirstChunk(
  31  |   page: import('@playwright/test').Page,
  32  |   url: string,
  33  |   headers: Record<string, string> = {},
  34  |   opts: { readBody?: boolean } = { readBody: true },
  35  | ): Promise<FirstChunk> {
  36  |   return page.evaluate(
  37  |     async ({ u, h, readBody }) => {
  38  |       const ctrl = new AbortController();
  39  |       // Hard deadline — covers both `fetch()` cold-compile latency and
  40  |       // the body read. SSE servers never close cleanly, so the abort IS
  41  |       // how we end the request.
  42  |       const timer = setTimeout(() => ctrl.abort(), 8000);
  43  |       try {
  44  |         const res = await fetch(u, {
  45  |           headers: { Accept: 'text/event-stream', ...h },
  46  |           signal: ctrl.signal,
  47  |         });
  48  |         const status = res.status;
  49  |         const ct = res.headers.get('content-type') ?? '';
  50  |         const xAccel = res.headers.get('x-accel-buffering') ?? '';
  51  |         let body = '';
  52  |         if (readBody && res.body) {
  53  |           const reader = res.body.getReader();
  54  |           const dec = new TextDecoder();
  55  |           try {
  56  |             while (body.length < 512) {
  57  |               const { value, done } = await reader.read();
  58  |               if (done) break;
  59  |               body += dec.decode(value, { stream: true });
  60  |               if (body.includes('event:')) break;
  61  |             }
  62  |           } catch {
  63  |             // AbortError on body is fine — we already have headers.
  64  |           } finally {
  65  |             try { await reader.cancel(); } catch { /* noop */ }
  66  |           }
  67  |         }
  68  |         // Always close the connection, even on the headers-only path,
  69  |         // so we don't stack open SSE connections against `next dev`.
  70  |         ctrl.abort();
  71  |         clearTimeout(timer);
  72  |         return { status, ct, xAccel, body };
  73  |       } catch (e) {
  74  |         clearTimeout(timer);
  75  |         return { status: 0, ct: '', xAccel: '', body: '', error: String(e) };
  76  |       }
  77  |     },
  78  |     { u: url, h: headers, readBody: opts.readBody !== false },
  79  |   );
  80  | }
  81  | 
  82  | test.describe('SSE stream shape (zero-harness + flags)', () => {
  83  |   for (const path of SSE_ROUTES) {
  84  |     test(`GET ${path} returns 200 text/event-stream with initial heartbeat`, async ({ page }) => {
  85  |       const r = await readFirstChunk(page, `${baseURL}${path}`);
  86  |       expect(r.status).toBe(200);
  87  |       expect(r.ct).toMatch(/text\/event-stream/);
  88  |       expect(r.body).toMatch(/event: heartbeat/);
  89  |       expect(r.body).toMatch(/"tsMs":\d+/);
  90  |       // Note: x-accel-buffering:no IS sent by the route (verified via
  91  |       // curl + libs/sse wire-format-snapshot test) but Chromium filters
  92  |       // it from cross-origin/CORS fetch responses, so we can't assert
  93  |       // it from page.evaluate here.
  94  |     });
  95  | 
  96  |     test(`POST ${path} returns 405`, async ({ request }) => {
> 97  |       const res = await request.post(`${baseURL}${path}`, { data: {} });
      |                                 ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  98  |       expect(res.status()).toBe(405);
  99  |     });
  100 |   }
  101 | });
  102 | 
  103 | test.describe('SSE Last-Event-ID defensive parsing', () => {
  104 |   // Sequential rather than per-case parallel — each case opens a streaming
  105 |   // connection to `next dev` (single compile pipeline), and 7+ in flight
  106 |   // at once oversubscribes its event loop and produces spurious aborts.
  107 |   test('all malformed/edge Last-Event-ID values yield 200 + heartbeat', async ({ page }) => {
  108 |     const cases: Array<{ name: string; header: string }> = [
  109 |       { name: 'valid positive int', header: '1000000' },
  110 |       { name: 'zero', header: '0' },
  111 |       { name: 'negative', header: '-5' },
  112 |       { name: 'empty string', header: '' },
  113 |       { name: 'non-numeric', header: 'not-a-number' },
  114 |       { name: 'whitespace', header: '   ' },
  115 |       { name: 'very large', header: String(Number.MAX_SAFE_INTEGER) },
  116 |     ];
  117 |     // Headers-only — the defensive contract is "doesn't 4xx/5xx", not
  118 |     // "first byte of body". Reading the body for 7 sequential streams
  119 |     // oversubscribes `next dev` and produces spurious aborts.
  120 |     for (const { name, header } of cases) {
  121 |       const r = await readFirstChunk(
  122 |         page,
  123 |         `${baseURL}/api/zero-harness/sse`,
  124 |         { 'Last-Event-ID': header },
  125 |         { readBody: false },
  126 |       );
  127 |       expect(r.status, `case "${name}" status`).toBe(200);
  128 |       expect(r.ct, `case "${name}" content-type`).toMatch(/text\/event-stream/);
  129 |     }
  130 |   });
  131 | });
  132 | 
```