# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-pages.spec.ts >> admin pages >> /admin/features renders without 500
- Location: e2e/admin-pages.spec.ts:19:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/admin/features
Call log:
  - navigating to "http://127.0.0.1:3055/admin/features", waiting until "load"

```

# Test source

```ts
  1  | /**
  2  |  * Admin pages — render-without-crash smoke for the operator's admin surface.
  3  |  */
  4  | import { test, expect } from '@playwright/test';
  5  | 
  6  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  7  | 
  8  | test.describe('admin pages', () => {
  9  |   test('/admin renders without 500', async ({ page }) => {
  10 |     const res = await page.goto(`${baseURL}/admin`, { waitUntil: 'load' });
  11 |     expect([200, 302, 307]).toContain(res?.status() ?? 0);
  12 |   });
  13 | 
  14 |   test('/admin/run renders without 500', async ({ page }) => {
  15 |     const res = await page.goto(`${baseURL}/admin/run`, { waitUntil: 'load' });
  16 |     expect([200, 302, 307]).toContain(res?.status() ?? 0);
  17 |   });
  18 | 
  19 |   test('/admin/features renders without 500', async ({ page }) => {
> 20 |     const res = await page.goto(`${baseURL}/admin/features`, { waitUntil: 'load' });
     |                            ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/admin/features
  21 |     expect([200, 302, 307]).toContain(res?.status() ?? 0);
  22 |   });
  23 | 
  24 |   test('/admin/tables renders without 500', async ({ page }) => {
  25 |     const res = await page.goto(`${baseURL}/admin/tables`, { waitUntil: 'load' });
  26 |     expect([200, 302, 307]).toContain(res?.status() ?? 0);
  27 |   });
  28 | });
  29 | 
```