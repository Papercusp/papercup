# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-pair.spec.ts >> mobile pairing route surface >> /api/mobile/pair endpoint is reachable (no 404)
- Location: e2e/mobile-pair.spec.ts:55:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/mobile/pair
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - Content-Type: application/json
    - content-length: 17

```

# Test source

```ts
  1  | /**
  2  |  * Mobile pairing route surface — E2E through the Hono shim.
  3  |  *
  4  |  * Scope: the contract phone clients depend on. Token redemption, deviceAuth
  5  |  * gate, malformed body rejection, expired/invalid token paths.
  6  |  *
  7  |  * NOT covered here (out of scope per project_mobile_pair_setup memory):
  8  |  * - Cloudflare Tunnel routing
  9  |  * - Defguard mesh enrollment
  10 |  * - WireGuard handshake
  11 |  *
  12 |  * These live in infra and need their own test surfaces. This spec exercises
  13 |  * only what the operator binary itself owns.
  14 |  */
  15 | import { test, expect } from '@playwright/test';
  16 | 
  17 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  18 | 
  19 | test.describe('mobile pairing route surface', () => {
  20 |   test('/api/mobile/pair rejects missing body', async ({ request }) => {
  21 |     const res = await request.post(`${baseURL}/api/mobile/pair`, {
  22 |       data: {},
  23 |       headers: { 'Content-Type': 'application/json' },
  24 |     });
  25 |     expect([400, 401]).toContain(res.status());
  26 |   });
  27 | 
  28 |   test('/api/mobile/pair rejects invalid pairToken', async ({ request }) => {
  29 |     const res = await request.post(`${baseURL}/api/mobile/pair`, {
  30 |       data: { pairToken: 'not-a-real-token-zzz' },
  31 |       headers: { 'Content-Type': 'application/json' },
  32 |     });
  33 |     expect(res.status()).toBe(401);
  34 |     const body = await res.json();
  35 |     expect(body.error).toMatch(/invalid_or_expired/);
  36 |   });
  37 | 
  38 |   test('/api/mobile/workspace/switch requires bearer token', async ({ request }) => {
  39 |     const res = await request.post(`${baseURL}/api/mobile/workspace/switch`, {
  40 |       data: { workspaceId: 'default' },
  41 |       headers: { 'Content-Type': 'application/json' },
  42 |     });
  43 |     // 401 (no bearer) confirms deviceAuth() middleware gates this endpoint
  44 |     expect(res.status()).toBe(401);
  45 |   });
  46 | 
  47 |   test('/api/mobile/rest-query requires bearer token', async ({ request }) => {
  48 |     const res = await request.post(`${baseURL}/api/mobile/rest-query`, {
  49 |       data: { name: 'workspaces.list', args: {} },
  50 |       headers: { 'Content-Type': 'application/json' },
  51 |     });
  52 |     expect(res.status()).toBe(401);
  53 |   });
  54 | 
  55 |   test('/api/mobile/pair endpoint is reachable (no 404)', async ({ request }) => {
  56 |     // Negative confirmation: routing is correct, only auth/validation is left.
> 57 |     const res = await request.post(`${baseURL}/api/mobile/pair`, {
     |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  58 |       data: { pairToken: 'x' },
  59 |       headers: { 'Content-Type': 'application/json' },
  60 |     });
  61 |     expect(res.status()).not.toBe(404);
  62 |   });
  63 | });
  64 | 
```