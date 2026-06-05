# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/operator/e2e/home.spec.ts >> root route >> / lands without app console errors
- Location: apps/operator/e2e/home.spec.ts:20:7

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "domcontentloaded"

```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Root route (`/`) behavior.
  5  |  *
  6  |  * The standalone marketing home (wordmark + Marketplace/Support nav) was
  7  |  * RETIRED — `/` is now a pure redirect gateway (operator-vite
  8  |  * `src/routes/index.tsx`): it reads the setup-wizard state and throws a
  9  |  * TanStack-Router redirect to `/adv?tab=harnesses` once setup is finished,
  10 |  * or `/setup` otherwise. These specs assert that current behavior — landing
  11 |  * on a real app surface with no console errors — instead of the dead
  12 |  * marketing page.
  13 |  */
  14 | test.describe('root route', () => {
  15 |   test('/ redirects to the primary surface (/adv) or the setup wizard', async ({ page }) => {
  16 |     await page.goto('/', { waitUntil: 'domcontentloaded' });
  17 |     await expect(page).toHaveURL(/\/(adv|setup)\b/);
  18 |   });
  19 | 
  20 |   test('/ lands without app console errors', async ({ page }) => {
  21 |     const consoleErrors: string[] = [];
  22 |     page.on('console', (msg) => {
  23 |       if (msg.type() === 'error') consoleErrors.push(msg.text());
  24 |     });
> 25 |     await page.goto('/', { waitUntil: 'domcontentloaded' });
     |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  26 |     await expect(page).toHaveURL(/\/(adv|setup)\b/);
  27 |     // Flag only genuine app errors. Ignore: third-party / hydration noise, and
  28 |     // failed-resource 401/403 — the landed app surface fetches authed data, and
  29 |     // a raw e2e browser has no verified session, so those are expected here.
  30 |     expect(
  31 |       consoleErrors.filter(
  32 |         (e) =>
  33 |           !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
  34 |           !/Failed to load resource.*\b(401|403)\b/i.test(e) &&
  35 |           !/\b(401|403)\b.*(Unauthorized|Forbidden)/i.test(e),
  36 |       ),
  37 |     ).toEqual([]);
  38 |   });
  39 | });
  40 | 
```