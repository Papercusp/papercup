# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: a11y-key-pages.spec.ts >> a11y on key pages >> /settings/user has no serious or critical a11y violations
- Location: e2e/a11y-key-pages.spec.ts:30:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/settings/user
Call log:
  - navigating to "http://127.0.0.1:3055/settings/user", waiting until "load"

```

# Test source

```ts
  1  | /**
  2  |  * Accessibility smoke for the operator's user-facing pages.
  3  |  *
  4  |  * Per testing-spec §1.4: zero serious/critical axe violations.
  5  |  *
  6  |  * Pages chosen for coverage:
  7  |  *  - /login (entry surface)
  8  |  *  - /settings/user (per-user settings hub)
  9  |  *  - /settings/voice (existing coverage extended)
  10 |  *
  11 |  * Other settings pages can be added if axe surfaces issues there;
  12 |  * this spec covers the most-trafficked entry points.
  13 |  */
  14 | import { test } from '@playwright/test';
  15 | import { expectNoA11yViolations } from './_axe';
  16 | 
  17 | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  18 | 
  19 | test.describe('a11y on key pages', () => {
  20 |   test('/login has no serious or critical a11y violations', async ({ page }) => {
  21 |     await page.goto(`${baseURL}/login`, { waitUntil: 'load' });
  22 |     await expectNoA11yViolations(page);
  23 |   });
  24 | 
  25 |   test('/login?switch=1 has no serious or critical a11y violations', async ({ page }) => {
  26 |     await page.goto(`${baseURL}/login?switch=1`, { waitUntil: 'load' });
  27 |     await expectNoA11yViolations(page);
  28 |   });
  29 | 
  30 |   test('/settings/user has no serious or critical a11y violations', async ({ page }) => {
> 31 |     await page.goto(`${baseURL}/settings/user`, { waitUntil: 'load' });
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/settings/user
  32 |     await expectNoA11yViolations(page);
  33 |   });
  34 | 
  35 |   test('/settings/profile has no serious or critical a11y violations', async ({ page }) => {
  36 |     await page.goto(`${baseURL}/settings/profile`, { waitUntil: 'load' });
  37 |     await expectNoA11yViolations(page);
  38 |   });
  39 | });
  40 | 
```