# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings-pages.spec.ts >> settings pages render >> /settings/shortcuts renders without 500
- Location: e2e/settings-pages.spec.ts:35:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/settings/shortcuts
Call log:
  - navigating to "http://127.0.0.1:3055/settings/shortcuts", waiting until "load"

```

# Test source

```ts
  1  | /**
  2  |  * Settings pages — render-without-crash smoke for the operator's settings surface.
  3  |  *
  4  |  * /settings/* hosts ~20 pages. This spec verifies each renders (HTTP 200 or
  5  |  * auth-redirect 30x). It does NOT click through forms — those are layer-2 work.
  6  |  */
  7  | import { test, expect } from '@playwright/test';
  8  | 
  9  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  10 | 
  11 | const SETTINGS_PAGES = [
  12 |   '/settings/profile',
  13 |   '/settings/backups',
  14 |   '/settings/voice',
  15 |   '/settings/oracle',
  16 |   '/settings/shortcuts',
  17 |   '/settings/personalization',
  18 |   '/settings/mobile',
  19 |   '/settings/agent',
  20 |   '/settings/plugins',
  21 |   '/settings/plugins/tools',
  22 |   '/settings/operator',
  23 |   '/settings/api-keys',
  24 |   '/settings/omp',
  25 |   '/settings/user',
  26 |   '/settings/user/search',
  27 |   '/settings/user/memory',
  28 |   '/settings/meridian',
  29 |   '/settings/publishing',
  30 |   '/settings/plugin-runtime',
  31 | ];
  32 | 
  33 | test.describe('settings pages render', () => {
  34 |   for (const path of SETTINGS_PAGES) {
  35 |     test(`${path} renders without 500`, async ({ page }) => {
> 36 |       const res = await page.goto(`${baseURL}${path}`, {
     |                              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/settings/shortcuts
  37 |         waitUntil: 'load',
  38 |         timeout: 30_000,
  39 |       });
  40 |       expect(res?.status() ?? 0).toBeLessThan(500);
  41 |       expect([200, 302, 307]).toContain(res?.status() ?? 0);
  42 |     });
  43 |   }
  44 | });
  45 | 
```