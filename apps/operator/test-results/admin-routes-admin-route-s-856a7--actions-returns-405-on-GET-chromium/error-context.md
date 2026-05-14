# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-routes.spec.ts >> admin route surface >> POST /api/admin/prune-executed-actions returns 405 on GET
- Location: e2e/admin-routes.spec.ts:96:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/api/admin/prune-executed-actions
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1   | /**
  2   |  * Admin route surface — auth/loopback gating + shape contracts.
  3   |  *
  4   |  * The /api/admin/* family is loopback-only OR requires the per-install
  5   |  * superuser bearer token. These specs verify:
  6   |  *
  7   |  *  - Routes are reachable from loopback (200 / shape OK)
  8   |  *  - Wrong HTTP verb returns 405
  9   |  *  - Bearer-required routes return 401 without bearer
  10  |  *  - Input validation rejects bad shapes
  11  |  *
  12  |  * Not covered (would mutate state):
  13  |  *  - Actually running a build command
  14  |  *  - Actually pruning executed actions
  15  |  *  - Actually rotating tokens
  16  |  *  - Actually executing a destructive admin action
  17  |  */
  18  | import { test, expect } from '@playwright/test';
  19  | 
  20  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  21  | 
  22  | test.describe('admin route surface', () => {
  23  |   test('GET /api/admin/tables returns table list', async ({ request }) => {
  24  |     const res = await request.get(`${baseURL}/api/admin/tables`);
  25  |     expect(res.status()).toBe(200);
  26  |     const body = await res.json();
  27  |     expect(Array.isArray(body.tables)).toBe(true);
  28  |     if (body.tables.length > 0) {
  29  |       expect(body.tables[0]).toHaveProperty('exportName');
  30  |       expect(body.tables[0]).toHaveProperty('label');
  31  |       expect(body.tables[0]).toHaveProperty('schema');
  32  |     }
  33  |   });
  34  | 
  35  |   test('GET /api/admin/commands returns command list with build/run sections', async ({ request }) => {
  36  |     const res = await request.get(`${baseURL}/api/admin/commands`);
  37  |     expect(res.status()).toBe(200);
  38  |     const body = await res.json();
  39  |     expect(Array.isArray(body.commands)).toBe(true);
  40  |     // Verify schema: each command has id, label, section, command, description
  41  |     const cmd = body.commands[0];
  42  |     expect(cmd).toHaveProperty('id');
  43  |     expect(cmd).toHaveProperty('label');
  44  |     expect(cmd).toHaveProperty('section');
  45  |     expect(cmd).toHaveProperty('command');
  46  |   });
  47  | 
  48  |   test('GET /api/admin/run without cmd param returns 400', async ({ request }) => {
  49  |     const res = await request.get(`${baseURL}/api/admin/run`);
  50  |     expect(res.status()).toBe(400);
  51  |   });
  52  | 
  53  |   test('GET /api/admin/run with unknown cmd returns error', async ({ request }) => {
  54  |     const res = await request.get(`${baseURL}/api/admin/run?cmd=totally-fake-cmd-id`);
  55  |     // 400 (unknown cmd) or 404 — either proves the route validates
  56  |     expect([400, 404]).toContain(res.status());
  57  |   });
  58  | 
  59  |   test('POST /api/admin/embed-backfill is gated', async ({ request }) => {
  60  |     const res = await request.post(`${baseURL}/api/admin/embed-backfill`, {
  61  |       data: {},
  62  |       headers: { 'Content-Type': 'application/json' },
  63  |     });
  64  |     // 200 (loopback authorized) or 401/403 (auth required)
  65  |     expect([200, 401, 403]).toContain(res.status());
  66  |   });
  67  | 
  68  |   test('GET /api/admin/embed-backfill returns 405 (POST only)', async ({ request }) => {
  69  |     const res = await request.get(`${baseURL}/api/admin/embed-backfill`);
  70  |     expect(res.status()).toBe(405);
  71  |   });
  72  | 
  73  |   test('GET /api/admin/spawn-signing/failures requires bearer', async ({ request }) => {
  74  |     const res = await request.get(`${baseURL}/api/admin/spawn-signing/failures`);
  75  |     expect(res.status()).toBe(401);
  76  |     const body = await res.json();
  77  |     expect(body.error).toMatch(/invalid_bearer|unauthorized/);
  78  |   });
  79  | 
  80  |   test('POST /api/admin/spawn-signing/rotate requires bearer', async ({ request }) => {
  81  |     const res = await request.post(`${baseURL}/api/admin/spawn-signing/rotate`, {
  82  |       data: {},
  83  |       headers: { 'Content-Type': 'application/json' },
  84  |     });
  85  |     expect([401, 403]).toContain(res.status());
  86  |   });
  87  | 
  88  |   test('POST /api/admin/rotate-token is bearer-gated', async ({ request }) => {
  89  |     const res = await request.post(`${baseURL}/api/admin/rotate-token`, {
  90  |       data: {},
  91  |       headers: { 'Content-Type': 'application/json' },
  92  |     });
  93  |     expect([200, 401, 403]).toContain(res.status());
  94  |   });
  95  | 
  96  |   test('POST /api/admin/prune-executed-actions returns 405 on GET', async ({ request }) => {
> 97  |     const res = await request.get(`${baseURL}/api/admin/prune-executed-actions`);
      |                               ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  98  |     expect(res.status()).toBe(405);
  99  |   });
  100 | 
  101 |   test('POST /api/admin/backup-orphan-cleanup is reachable', async ({ request }) => {
  102 |     const res = await request.post(`${baseURL}/api/admin/backup-orphan-cleanup`, {
  103 |       data: {},
  104 |       headers: { 'Content-Type': 'application/json' },
  105 |     });
  106 |     expect([200, 401, 403]).toContain(res.status());
  107 |   });
  108 | 
  109 |   test('GET /api/admin/tables/[exportName] returns table data for a known table', async ({ request }) => {
  110 |     // First fetch the list to get a known exportName.
  111 |     const list = await request.get(`${baseURL}/api/admin/tables`);
  112 |     const tables = (await list.json()).tables ?? [];
  113 |     if (tables.length === 0) {
  114 |       test.skip(true, 'No admin tables present');
  115 |     }
  116 |     const first = tables[0].exportName;
  117 |     const res = await request.get(`${baseURL}/api/admin/tables/${first}`);
  118 |     expect([200, 401]).toContain(res.status());
  119 |   });
  120 | });
  121 | 
```