# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-switch.spec.ts >> workspace switch validation >> POST with empty body returns 400 id-required
- Location: e2e/workspace-switch.spec.ts:44:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/workspaces/switch
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 2

```

# Test source

```ts
  1   | /**
  2   |  * Workspace switch + registry surface — HTTP validation + idempotency.
  3   |  *
  4   |  * Real workspace switches dispatch a workspace-switch event that drops
  5   |  * replay buffers, card-correlator PENDING entries, and state-channel
  6   |  * snapshots for the leaving workspace. We don't exercise the full
  7   |  * lifecycle here (would mutate the shared registry); instead we verify:
  8   |  *   - GET shape
  9   |  *   - validation gates fire in the right order
  10  |  *   - idempotent same-workspace switch returns `alreadyCurrent` and
  11  |  *     does NOT mutate the registry
  12  |  *   - destructive ops (PATCH/DELETE) refuse before touching state
  13  |  */
  14  | import { test, expect } from '@playwright/test';
  15  | 
  16  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  17  | 
  18  | async function getRegistry(request: import('@playwright/test').APIRequestContext) {
  19  |   const r = await request.get(`${baseURL}/api/workspaces`);
  20  |   expect(r.status()).toBe(200);
  21  |   return (await r.json()) as {
  22  |     current: string;
  23  |     workspaces: { id: string; name: string; createdAt: number }[];
  24  |   };
  25  | }
  26  | 
  27  | test.describe('workspace registry list', () => {
  28  |   test('GET /api/workspaces returns { current, workspaces[] }', async ({ request }) => {
  29  |     const reg = await getRegistry(request);
  30  |     expect(typeof reg.current).toBe('string');
  31  |     expect(Array.isArray(reg.workspaces)).toBe(true);
  32  |     expect(reg.workspaces.length).toBeGreaterThan(0);
  33  |     for (const w of reg.workspaces) {
  34  |       expect(typeof w.id).toBe('string');
  35  |       expect(typeof w.name).toBe('string');
  36  |       expect(typeof w.createdAt).toBe('number');
  37  |     }
  38  |     // current must point at one of the listed workspaces
  39  |     expect(reg.workspaces.some((w) => w.id === reg.current)).toBe(true);
  40  |   });
  41  | });
  42  | 
  43  | test.describe('workspace switch validation', () => {
  44  |   test('POST with empty body returns 400 id-required', async ({ request }) => {
> 45  |     const res = await request.post(`${baseURL}/api/workspaces/switch`, { data: {} });
      |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  46  |     expect(res.status()).toBe(400);
  47  |     expect((await res.json()).error).toBe('id required');
  48  |   });
  49  | 
  50  |   test('POST with non-JSON returns 400 invalid-json', async ({ request }) => {
  51  |     const res = await request.post(`${baseURL}/api/workspaces/switch`, {
  52  |       data: 'not-json',
  53  |       headers: { 'Content-Type': 'text/plain' },
  54  |     });
  55  |     expect(res.status()).toBe(400);
  56  |     expect((await res.json()).error).toBe('invalid json');
  57  |   });
  58  | 
  59  |   test('POST with control-char id returns 400 invalid-id', async ({ request }) => {
  60  |     const res = await request.post(`${baseURL}/api/workspaces/switch`, {
  61  |       data: { id: '!!!bad' },
  62  |     });
  63  |     expect(res.status()).toBe(400);
  64  |     expect((await res.json()).error).toMatch(/invalid workspace id/);
  65  |   });
  66  | 
  67  |   test('POST with valid-but-unknown id returns 404', async ({ request }) => {
  68  |     const res = await request.post(`${baseURL}/api/workspaces/switch`, {
  69  |       data: { id: 'definitely-fake-zzzzz-spec' },
  70  |     });
  71  |     expect(res.status()).toBe(404);
  72  |     expect((await res.json()).error).toMatch(/unknown workspace/);
  73  |   });
  74  | 
  75  |   test('GET on /switch returns 405', async ({ request }) => {
  76  |     const res = await request.get(`${baseURL}/api/workspaces/switch`);
  77  |     expect(res.status()).toBe(405);
  78  |   });
  79  | });
  80  | 
  81  | test.describe('workspace switch idempotency (no-op safe)', () => {
  82  |   test('switching to current workspace returns alreadyCurrent and does not mutate', async ({
  83  |     request,
  84  |   }) => {
  85  |     const before = await getRegistry(request);
  86  |     const switchRes = await request.post(`${baseURL}/api/workspaces/switch`, {
  87  |       data: { id: before.current },
  88  |     });
  89  |     expect(switchRes.status()).toBe(200);
  90  |     const body = await switchRes.json();
  91  |     expect(body.ok).toBe(true);
  92  |     expect(body.id).toBe(before.current);
  93  |     expect(body.alreadyCurrent).toBe(true);
  94  | 
  95  |     const after = await getRegistry(request);
  96  |     expect(after.current).toBe(before.current);
  97  |     expect(after.workspaces.length).toBe(before.workspaces.length);
  98  |   });
  99  | });
  100 | 
  101 | test.describe('workspace mutate (PATCH/DELETE) validation', () => {
  102 |   test('PATCH on invalid id returns 400 before touching state', async ({ request }) => {
  103 |     const res = await request.patch(`${baseURL}/api/workspaces/!!!`, {
  104 |       data: { name: 'whatever' },
  105 |     });
  106 |     expect(res.status()).toBe(400);
  107 |     expect((await res.json()).error).toBe('invalid id');
  108 |   });
  109 | 
  110 |   test('PATCH with empty name returns 400 name-required', async ({ request }) => {
  111 |     // Use a clearly-fake but slug-valid id; route will resolve id first, then
  112 |     // validate body. If id check fires first the test still passes (400).
  113 |     const res = await request.patch(`${baseURL}/api/workspaces/totally-fake-zzz`, {
  114 |       data: { name: '' },
  115 |     });
  116 |     expect(res.status()).toBe(400);
  117 |   });
  118 | 
  119 |   test('PATCH on valid-but-unknown id returns 404 not-found', async ({ request }) => {
  120 |     const res = await request.patch(`${baseURL}/api/workspaces/totally-fake-zzz`, {
  121 |       data: { name: 'newname' },
  122 |     });
  123 |     expect(res.status()).toBe(404);
  124 |     expect((await res.json()).error).toBe('not found');
  125 |   });
  126 | 
  127 |   test('DELETE on invalid id returns 400', async ({ request }) => {
  128 |     const res = await request.delete(`${baseURL}/api/workspaces/!!!`);
  129 |     expect(res.status()).toBe(400);
  130 |   });
  131 | 
  132 |   test('DELETE on valid-but-unknown id returns 404', async ({ request }) => {
  133 |     const res = await request.delete(`${baseURL}/api/workspaces/totally-fake-zzz`);
  134 |     expect(res.status()).toBe(404);
  135 |     expect((await res.json()).error).toBe('not found');
  136 |   });
  137 | 
  138 |   test('DELETE on current workspace is refused with 400', async ({ request }) => {
  139 |     const reg = await getRegistry(request);
  140 |     const res = await request.delete(`${baseURL}/api/workspaces/${reg.current}`);
  141 |     expect(res.status()).toBe(400);
  142 |     expect((await res.json()).error).toMatch(/cannot delete the active workspace/);
  143 |     // Re-verify the workspace was NOT removed.
  144 |     const after = await getRegistry(request);
  145 |     expect(after.workspaces.some((w) => w.id === reg.current)).toBe(true);
```