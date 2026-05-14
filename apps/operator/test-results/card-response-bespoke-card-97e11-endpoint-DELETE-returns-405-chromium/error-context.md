# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: card-response.spec.ts >> bespoke-card response endpoint >> DELETE returns 405
- Location: e2e/card-response.spec.ts:56:7

# Error details

```
Error: apiRequestContext.delete: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → DELETE http://127.0.0.1:3055/api/operator/conversations/spec-fixture-id/card-response
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Bespoke-card response endpoint — HTTP surface.
  3  |  *
  4  |  * Unit-test coverage (route.test.ts) exercises submit/decline/cancel
  5  |  * happy-paths, Zod validation, cross-workspace defense-in-depth, and
  6  |  * the 30 RPS per-user rate limit. This spec covers the parts that
  7  |  * only show up against the live server: method handling, auth gate
  8  |  * ordering, malformed payloads, and Content-Type handling.
  9  |  *
  10 |  * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.5
  11 |  */
  12 | import { test, expect } from '@playwright/test';
  13 | 
  14 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  15 | const path = '/api/operator/conversations/spec-fixture-id/card-response';
  16 | 
  17 | test.describe('bespoke-card response endpoint', () => {
  18 |   test('POST without session returns 401', async ({ request }) => {
  19 |     const res = await request.post(`${baseURL}${path}`, {
  20 |       data: { correlationId: 'x', action: 'cancel', workspaceId: 'w' },
  21 |     });
  22 |     expect(res.status()).toBe(401);
  23 |     const body = await res.json();
  24 |     expect(body.error).toBe('unauthorized');
  25 |   });
  26 | 
  27 |   test('POST without session 401s BEFORE body validation (auth gate first)', async ({
  28 |     request,
  29 |   }) => {
  30 |     // Send obviously invalid body; if auth gate ordered correctly we still get 401, not 400.
  31 |     const res = await request.post(`${baseURL}${path}`, {
  32 |       data: { garbage: true },
  33 |     });
  34 |     expect(res.status()).toBe(401);
  35 |   });
  36 | 
  37 |   test('POST with non-JSON Content-Type still 401s without session', async ({ request }) => {
  38 |     const res = await request.post(`${baseURL}${path}`, {
  39 |       data: 'not-json-at-all',
  40 |       headers: { 'Content-Type': 'text/plain' },
  41 |     });
  42 |     // Either auth-gates first (401) or rejects parsing (400). Must not 500.
  43 |     expect([400, 401, 415]).toContain(res.status());
  44 |   });
  45 | 
  46 |   test('GET returns 405 (POST-only route)', async ({ request }) => {
  47 |     const res = await request.get(`${baseURL}${path}`);
  48 |     expect(res.status()).toBe(405);
  49 |   });
  50 | 
  51 |   test('PUT returns 405', async ({ request }) => {
  52 |     const res = await request.put(`${baseURL}${path}`, { data: {} });
  53 |     expect(res.status()).toBe(405);
  54 |   });
  55 | 
  56 |   test('DELETE returns 405', async ({ request }) => {
> 57 |     const res = await request.delete(`${baseURL}${path}`);
     |                                     ^ Error: apiRequestContext.delete: connect ECONNREFUSED 127.0.0.1:3055
  58 |     expect(res.status()).toBe(405);
  59 |   });
  60 | 
  61 |   test('PATCH returns 405', async ({ request }) => {
  62 |     const res = await request.patch(`${baseURL}${path}`, { data: {} });
  63 |     expect(res.status()).toBe(405);
  64 |   });
  65 | 
  66 |   test('dynamic [id] segment accepts any string without 500', async ({ request }) => {
  67 |     // Path param is opaque (route ignores it; cards are looked up by correlationId)
  68 |     // — try a few suspicious shapes and confirm none crash the server.
  69 |     const ids = [
  70 |       'normal-id',
  71 |       encodeURIComponent('with spaces'),
  72 |       encodeURIComponent('with/slash'),
  73 |       encodeURIComponent('../../etc/passwd'),
  74 |       encodeURIComponent('special&chars?=foo'),
  75 |     ];
  76 |     for (const id of ids) {
  77 |       const res = await request.post(
  78 |         `${baseURL}/api/operator/conversations/${id}/card-response`,
  79 |         { data: { correlationId: 'x', action: 'cancel', workspaceId: 'w' } },
  80 |       );
  81 |       expect(res.status()).toBeLessThan(500);
  82 |     }
  83 |   });
  84 | 
  85 |   test('oversized body does not 500', async ({ request }) => {
  86 |     const huge = 'x'.repeat(2 * 1024 * 1024); // 2MB
  87 |     const res = await request.post(`${baseURL}${path}`, {
  88 |       data: { correlationId: 'x', action: 'cancel', workspaceId: 'w', payload: { blob: huge } },
  89 |     });
  90 |     // Either auth-gates (401) or rejects size (413) — never crash.
  91 |     expect(res.status()).toBeLessThan(500);
  92 |   });
  93 | });
  94 | 
```