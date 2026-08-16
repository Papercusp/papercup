/**
 * Accessibility smoke for the operator's user-facing pages.
 *
 * Per testing-spec §1.4: zero serious/critical axe violations.
 *
 * Pages chosen for coverage:
 *  - /login (entry surface)
 *  - /settings/user (per-user settings hub)
 *  - /settings/voice (existing coverage extended)
 *
 * Other settings pages can be added if axe surfaces issues there;
 * this spec covers the most-trafficked entry points.
 */
import { test } from './_egress';
import { expectNoA11yViolations } from './_axe';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('a11y on key pages', () => {
  test('/login has no serious or critical a11y violations', async ({ page }) => {
    await page.goto(`${baseURL}/login`, { waitUntil: 'load' });
    await expectNoA11yViolations(page);
  });

  test('/login?switch=1 has no serious or critical a11y violations', async ({ page }) => {
    await page.goto(`${baseURL}/login?switch=1`, { waitUntil: 'load' });
    await expectNoA11yViolations(page);
  });

  test('/settings/user has no serious or critical a11y violations', async ({ page }) => {
    await page.goto(`${baseURL}/settings/user`, { waitUntil: 'load' });
    await expectNoA11yViolations(page);
  });

  test('/settings/profile has no serious or critical a11y violations', async ({ page }) => {
    await page.goto(`${baseURL}/settings/profile`, { waitUntil: 'load' });
    await expectNoA11yViolations(page);
  });
});
