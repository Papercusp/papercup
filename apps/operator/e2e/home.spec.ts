import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './_axe';

test.describe('home page', () => {
  test('renders the wordmark and primary CTAs', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');

    await expect(page.locator('header.pc-header .brand img').first()).toBeVisible();

    const nav = page.locator('header.pc-header nav');
    await expect(nav.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', /\/marketplace/);
    await expect(nav.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support');

    expect(consoleErrors.filter((e) => !/chatwoot|chat\.papercupai|hydration/i.test(e))).toEqual([]);
  });

  test('marketplace link routes to the catalog', async ({ page }) => {
    await page.goto('/');
    await page.locator('header.pc-header nav').getByRole('link', { name: 'Marketplace' }).click();
    await expect(page).toHaveURL(/\/marketplace(\/?|\/templates|\/plugins|\/snapshots)?$/);
  });

  test('home page has no serious or critical a11y violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header.pc-header').first()).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
