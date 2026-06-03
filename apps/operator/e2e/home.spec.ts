import { expect, test } from '@playwright/test';

/**
 * Root route (`/`) behavior.
 *
 * The standalone marketing home (wordmark + Marketplace/Support nav) was
 * RETIRED — `/` is now a pure redirect gateway (operator-vite
 * `src/routes/index.tsx`): it reads the setup-wizard state and throws a
 * TanStack-Router redirect to `/adv?tab=harnesses` once setup is finished,
 * or `/setup` otherwise. These specs assert that current behavior — landing
 * on a real app surface with no console errors — instead of the dead
 * marketing page.
 */
test.describe('root route', () => {
  test('/ redirects to the primary surface (/adv) or the setup wizard', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/(adv|setup)\b/);
  });

  test('/ lands without app console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/(adv|setup)\b/);
    // Flag only genuine app errors. Ignore: third-party / hydration noise, and
    // failed-resource 401/403 — the landed app surface fetches authed data, and
    // a raw e2e browser has no verified session, so those are expected here.
    expect(
      consoleErrors.filter(
        (e) =>
          !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
          !/Failed to load resource.*\b(401|403)\b/i.test(e) &&
          !/\b(401|403)\b.*(Unauthorized|Forbidden)/i.test(e),
      ),
    ).toEqual([]);
  });
});
