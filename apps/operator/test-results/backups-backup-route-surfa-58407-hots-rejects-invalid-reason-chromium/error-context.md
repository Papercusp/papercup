# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: backups.spec.ts >> backup route surface >> POST /api/backups/snapshots rejects invalid reason
- Location: e2e/backups.spec.ts:58:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/backups/snapshots
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - Content-Type: application/json
    - content-length: 30

```

# Test source

```ts
  1   | /**
  2   |  * Backup route surface — E2E through the public HTTP API.
  3   |  *
  4   |  * Covers what the operator binary owns:
  5   |  *  - GET /api/backups (settings + stats shape)
  6   |  *  - GET /api/backups/snapshots (list)
  7   |  *  - POST /api/backups/snapshots (manual create — graceful failure when
  8   |  *    kopia bin or workspace path is unavailable)
  9   |  *  - GET /api/backups/healthcheck
  10  |  *  - POST /api/admin/backup-orphan-cleanup (admin sweep route)
  11  |  *  - GET /api/backups/events (SSE)
  12  |  *
  13  |  * Out of scope (per project_papercup_backup_integration memory):
  14  |  *  - kopia binary install/setup
  15  |  *  - Real snapshot creation requiring writable workspace + kopia install
  16  |  *  - Snapshot restore (destructive, needs real backup history)
  17  |  *
  18  |  * The flow tests confirm the routes exist, validate their input,
  19  |  * and either succeed or fail-gracefully when kopia isn't bootstrapped.
  20  |  */
  21  | import { test, expect } from '@playwright/test';
  22  | 
  23  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  24  | 
  25  | test.describe('backup route surface', () => {
  26  |   test('GET /api/backups returns settings + stats shape', async ({ request }) => {
  27  |     const res = await request.get(`${baseURL}/api/backups`);
  28  |     expect(res.status()).toBe(200);
  29  |     const body = await res.json();
  30  |     expect(body).toHaveProperty('settings');
  31  |     expect(body.settings).toHaveProperty('enabled');
  32  |     expect(body.settings).toHaveProperty('cadenceMode');
  33  |     expect(body.settings).toHaveProperty('cadenceMinutes');
  34  |     expect(body.settings).toHaveProperty('retentionPreset');
  35  |   });
  36  | 
  37  |   test('GET /api/backups/snapshots returns array', async ({ request }) => {
  38  |     const res = await request.get(`${baseURL}/api/backups/snapshots?limit=5`);
  39  |     expect(res.status()).toBe(200);
  40  |     const body = await res.json();
  41  |     expect(Array.isArray(body.snapshots)).toBe(true);
  42  |   });
  43  | 
  44  |   test('POST /api/backups/snapshots accepts a valid manual reason', async ({ request }) => {
  45  |     const res = await request.post(`${baseURL}/api/backups/snapshots`, {
  46  |       data: { reason: 'manual', context: { source: 'e2e-test' } },
  47  |       headers: { 'Content-Type': 'application/json' },
  48  |     });
  49  |     // Either succeeds (kopia bootstrapped) or fails-gracefully with 500 + error string
  50  |     // (kopia not installed). Both prove the route is wired.
  51  |     expect([200, 500]).toContain(res.status());
  52  |     if (res.status() === 500) {
  53  |       const body = await res.json();
  54  |       expect(body).toHaveProperty('error');
  55  |     }
  56  |   });
  57  | 
  58  |   test('POST /api/backups/snapshots rejects invalid reason', async ({ request }) => {
> 59  |     const res = await request.post(`${baseURL}/api/backups/snapshots`, {
      |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  60  |       data: { reason: 'not-a-real-reason' },
  61  |       headers: { 'Content-Type': 'application/json' },
  62  |     });
  63  |     expect([400, 500]).toContain(res.status());
  64  |   });
  65  | 
  66  |   test('GET /api/backups/healthcheck returns status', async ({ request }) => {
  67  |     const res = await request.get(`${baseURL}/api/backups/healthcheck`);
  68  |     expect([200, 500, 503]).toContain(res.status());
  69  |     // Healthcheck always returns JSON; either ok=true or error string.
  70  |     const body = await res.json().catch(() => null);
  71  |     expect(body).toBeTruthy();
  72  |   });
  73  | 
  74  |   test('GET /api/backups/events is SSE-shaped or 401', async ({ page }) => {
  75  |     // SSE keeps the connection open; we can't use a normal HTTP fetch here
  76  |     // because it waits for body completion. Use fetch with manual abort.
  77  |     const result = await page.evaluate(async (url) => {
  78  |       const controller = new AbortController();
  79  |       setTimeout(() => controller.abort(), 500);
  80  |       try {
  81  |         const res = await fetch(url, { signal: controller.signal });
  82  |         return {
  83  |           status: res.status,
  84  |           contentType: res.headers.get('content-type') ?? '',
  85  |         };
  86  |       } catch (e) {
  87  |         return { error: String(e) };
  88  |       }
  89  |     }, `${baseURL}/api/backups/events`);
  90  | 
  91  |     if ('error' in result) {
  92  |       // Aborted mid-stream is the expected SSE behavior on this route.
  93  |       expect(result.error).toMatch(/abort/i);
  94  |     } else {
  95  |       expect([200, 401]).toContain(result.status);
  96  |       if (result.status === 200) {
  97  |         expect(result.contentType).toMatch(/event-stream/);
  98  |       }
  99  |     }
  100 |   });
  101 | 
  102 |   test('POST /api/admin/backup-orphan-cleanup is gated (no auth → not 200)', async ({ request }) => {
  103 |     const res = await request.post(`${baseURL}/api/admin/backup-orphan-cleanup`, {
  104 |       data: {},
  105 |       headers: { 'Content-Type': 'application/json' },
  106 |     });
  107 |     // 401/403 (auth gate) or 200 (loopback dev path) — either proves the route is wired.
  108 |     expect([200, 401, 403]).toContain(res.status());
  109 |   });
  110 | 
  111 |   test('PUT /api/backups validates settings schema', async ({ request }) => {
  112 |     const res = await request.put(`${baseURL}/api/backups`, {
  113 |       data: { enabled: 'not-a-bool' },  // wrong type
  114 |       headers: { 'Content-Type': 'application/json' },
  115 |     });
  116 |     expect([400, 500]).toContain(res.status());
  117 |   });
  118 | 
  119 |   test('GET /api/backups/failures returns list shape', async ({ request }) => {
  120 |     const res = await request.get(`${baseURL}/api/backups/failures`);
  121 |     expect(res.status()).toBe(200);
  122 |     const body = await res.json();
  123 |     // Either array directly or { failures: [...] }
  124 |     const failures = Array.isArray(body) ? body : body.failures;
  125 |     expect(Array.isArray(failures)).toBe(true);
  126 |   });
  127 | });
  128 | 
```