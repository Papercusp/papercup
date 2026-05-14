# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: home.spec.ts >> home page >> home page has no serious or critical a11y violations
- Location: e2e/home.spec.ts:28:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/
Call log:
  - navigating to "http://localhost:3055/", waiting until "load"

```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { expectNoA11yViolations } from './_axe';
  3  | 
  4  | test.describe('home page', () => {
  5  |   test('renders the wordmark and primary CTAs', async ({ page }) => {
  6  |     const consoleErrors: string[] = [];
  7  |     page.on('console', (msg) => {
  8  |       if (msg.type() === 'error') consoleErrors.push(msg.text());
  9  |     });
  10 | 
  11 |     await page.goto('/');
  12 | 
  13 |     await expect(page.locator('header.pc-header .brand img').first()).toBeVisible();
  14 | 
  15 |     const nav = page.locator('header.pc-header nav');
  16 |     await expect(nav.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', /\/marketplace/);
  17 |     await expect(nav.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support');
  18 | 
  19 |     expect(consoleErrors.filter((e) => !/chatwoot|chat\.papercupai|hydration/i.test(e))).toEqual([]);
  20 |   });
  21 | 
  22 |   test('marketplace link routes to the catalog', async ({ page }) => {
  23 |     await page.goto('/');
  24 |     await page.locator('header.pc-header nav').getByRole('link', { name: 'Marketplace' }).click();
  25 |     await expect(page).toHaveURL(/\/marketplace(\/?|\/templates|\/plugins|\/snapshots)?$/);
  26 |   });
  27 | 
  28 |   test('home page has no serious or critical a11y violations', async ({ page }) => {
> 29 |     await page.goto('/');
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/
  30 |     await expect(page.locator('header.pc-header').first()).toBeVisible();
  31 |     await expectNoA11yViolations(page);
  32 |   });
  33 | });
  34 | 
```