# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: setup-wizard.spec.ts >> setup-wizard route surface >> setup-wizard-state PATCH persists step_status
- Location: e2e/setup-wizard.spec.ts:71:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → GET http://127.0.0.1:3055/api/desktop/setup-wizard-state
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | /**
  2  |  * Setup-wizard route surface + state API.
  3  |  *
  4  |  * Per the docs, the wizard surfaces are reachable on /setup (first-run) and
  5  |  * /settings/setup-wizard (re-entry). The state lives in PG keyed by a per-
  6  |  * install UUID and is loopback-gated at the API layer.
  7  |  *
  8  |  * What this spec covers:
  9  |  *  - /setup renders (Chromeless shell, no console errors)
  10 |  *  - /settings/setup-wizard renders
  11 |  *  - Wizard state API gates non-loopback hosts (loopback-only enforcement)
  12 |  *  - State GET is idempotent and seeds install_id on first call
  13 |  *
  14 |  * Out of scope (needs fresh-install context, not a running operator):
  15 |  *  - Stepping through every wizard step
  16 |  *  - First-run keys persistence
  17 |  *  - PostHog telemetry opt-in side effects
  18 |  *  These are flagged in deferred-followups-2026-05-14.md.
  19 |  */
  20 | import { test, expect } from '@playwright/test';
  21 | 
  22 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  23 | 
  24 | test.describe('setup-wizard route surface', () => {
  25 |   test('/setup renders without server error', async ({ page }) => {
  26 |     const response = await page.goto(`${baseURL}/setup`, { waitUntil: 'load' });
  27 |     expect(response?.status()).toBe(200);
  28 |   });
  29 | 
  30 |   test('/settings/setup-wizard renders without server error', async ({ page }) => {
  31 |     const response = await page.goto(`${baseURL}/settings/setup-wizard`, {
  32 |       waitUntil: 'load',
  33 |     });
  34 |     // Login redirect or 200 both acceptable; the route exists either way.
  35 |     expect([200, 302, 307]).toContain(response?.status() ?? 0);
  36 |   });
  37 | 
  38 |   test('setup-wizard-state GET on loopback returns shape', async ({ request }) => {
  39 |     const res = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  40 |     expect(res.status()).toBe(200);
  41 |     const body = await res.json();
  42 |     expect(body).toHaveProperty('step_status');
  43 |     expect(typeof body.step_status).toBe('object');
  44 |   });
  45 | 
  46 |   test('setup-wizard-state GET seeds install_id', async ({ request }) => {
  47 |     const res = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  48 |     expect(res.status()).toBe(200);
  49 |     const body = await res.json();
  50 |     expect(body.install_id).toBeTruthy();
  51 |     expect(typeof body.install_id).toBe('string');
  52 |     expect(body.install_id.length).toBeGreaterThanOrEqual(8);
  53 |   });
  54 | 
  55 |   test('setup-wizard-state install_id is stable across calls', async ({ request }) => {
  56 |     const r1 = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  57 |     const r2 = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  58 |     const b1 = await r1.json();
  59 |     const b2 = await r2.json();
  60 |     expect(b1.install_id).toBe(b2.install_id);
  61 |   });
  62 | 
  63 |   test('setup-wizard-state rejects non-loopback Host header', async ({ request }) => {
  64 |     // We can't easily fake the Host header with playwright's fetch, but we can
  65 |     // probe by hitting it from the loopback IP and confirming the loopback path
  66 |     // works (above) — the rejection branch is unit-tested in route.test.ts.
  67 |     const res = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  68 |     expect([200, 403]).toContain(res.status());
  69 |   });
  70 | 
  71 |   test('setup-wizard-state PATCH persists step_status', async ({ request }) => {
> 72 |     const probe = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
     |                                 ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3055
  73 |     const before = await probe.json();
  74 |     const installId = before.install_id;
  75 | 
  76 |     const res = await request.fetch(`${baseURL}/api/desktop/setup-wizard-state`, {
  77 |       method: 'PATCH',
  78 |       data: {
  79 |         step_status: { e2e_probe: 'completed' },
  80 |         last_visited_step: 'e2e_probe',
  81 |       },
  82 |       headers: { 'Content-Type': 'application/json' },
  83 |     });
  84 |     expect(res.status()).toBe(200);
  85 | 
  86 |     const after = await request.get(`${baseURL}/api/desktop/setup-wizard-state`);
  87 |     const body = await after.json();
  88 |     expect(body.install_id).toBe(installId);  // Stable across PATCH
  89 |     expect(body.step_status?.e2e_probe).toBe('completed');
  90 |   });
  91 | });
  92 | 
```