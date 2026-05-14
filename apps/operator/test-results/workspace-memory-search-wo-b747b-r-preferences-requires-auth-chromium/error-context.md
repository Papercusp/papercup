# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-memory-search.spec.ts >> workspace registry + user surfaces >> GET /api/user/preferences requires auth
- Location: e2e/workspace-memory-search.spec.ts:42:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/api/user/preferences
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Workspace registry + user memory + user search route surface.
  3  |  *
  4  |  * Covers the public HTTP API for:
  5  |  *  - /api/workspaces (list + current)
  6  |  *  - /api/operator/state-snapshot (auth gate)
  7  |  *  - /api/user/preferences (auth gate)
  8  |  *  - /api/user/memory (auth gate)
  9  |  *  - /api/user/search (auth gate)
  10 |  */
  11 | import { test, expect } from '@playwright/test';
  12 | 
  13 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  14 | 
  15 | test.describe('workspace registry + user surfaces', () => {
  16 |   test('GET /api/workspaces returns current + workspaces array', async ({ request }) => {
  17 |     const res = await request.get(`${baseURL}/api/workspaces`);
  18 |     expect(res.status()).toBe(200);
  19 |     const body = await res.json();
  20 |     expect(body.current).toBeTruthy();
  21 |     expect(typeof body.current).toBe('string');
  22 |     expect(Array.isArray(body.workspaces)).toBe(true);
  23 |     if (body.workspaces.length > 0) {
  24 |       const ws = body.workspaces[0];
  25 |       expect(ws).toHaveProperty('id');
  26 |       expect(ws).toHaveProperty('name');
  27 |     }
  28 |   });
  29 | 
  30 |   test('GET /api/workspaces includes the default workspace', async ({ request }) => {
  31 |     const res = await request.get(`${baseURL}/api/workspaces`);
  32 |     const body = await res.json();
  33 |     const ids = body.workspaces.map((w: { id: string }) => w.id);
  34 |     expect(ids).toContain('default');
  35 |   });
  36 | 
  37 |   test('GET /api/operator/state-snapshot requires auth', async ({ request }) => {
  38 |     const res = await request.get(`${baseURL}/api/operator/state-snapshot`);
  39 |     expect([200, 401, 403]).toContain(res.status());
  40 |   });
  41 | 
  42 |   test('GET /api/user/preferences requires auth', async ({ request }) => {
> 43 |     const res = await request.get(`${baseURL}/api/user/preferences`);
     |                               ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  44 |     expect([200, 401, 403]).toContain(res.status());
  45 |   });
  46 | 
  47 |   test('GET /api/user/memory requires auth', async ({ request }) => {
  48 |     const res = await request.get(`${baseURL}/api/user/memory`);
  49 |     expect([200, 401, 403]).toContain(res.status());
  50 |   });
  51 | 
  52 |   test('GET /api/user/search?q=test requires auth', async ({ request }) => {
  53 |     const res = await request.get(`${baseURL}/api/user/search?q=test`);
  54 |     expect([200, 401, 403]).toContain(res.status());
  55 |   });
  56 | 
  57 |   test('POST /api/user/memory returns 405 (route is GET/PATCH/DELETE)', async ({ request }) => {
  58 |     const res = await request.post(`${baseURL}/api/user/memory`, {
  59 |       data: { content: 'test', kind: 'preference' },
  60 |       headers: { 'Content-Type': 'application/json' },
  61 |     });
  62 |     expect(res.status()).toBe(405);
  63 |   });
  64 | 
  65 |   test('PATCH /api/user/memory requires auth + body', async ({ request }) => {
  66 |     const res = await request.fetch(`${baseURL}/api/user/memory`, {
  67 |       method: 'PATCH',
  68 |       data: { id: 'test-id', text: 'updated' },
  69 |       headers: { 'Content-Type': 'application/json' },
  70 |     });
  71 |     // Either 401 (no auth) or 400 (bad shape) — both prove the route validates
  72 |     expect([400, 401, 403, 404, 500]).toContain(res.status());
  73 |   });
  74 | 
  75 |   test('DELETE /api/user/memory requires auth', async ({ request }) => {
  76 |     const res = await request.fetch(`${baseURL}/api/user/memory?id=test-id`, {
  77 |       method: 'DELETE',
  78 |     });
  79 |     expect([400, 401, 403, 404, 500]).toContain(res.status());
  80 |   });
  81 | });
  82 | 
```