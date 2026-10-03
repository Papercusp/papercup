import { expect, test } from './_egress';

// Uses the owning Playwright profile. For exact production proof, set
// OPERATOR_E2E_BASE_URL and OPERATOR_E2E_REUSE_SERVER=1; do not silently
// substitute a development server for the cloud destination.
test.use({ channel: 'chrome' });

const guides = [
  ['quickstart', 'Your first successful task'],
  ['plans-and-work', 'Plans and work'],
  ['agent-modes-and-fleets', 'Agent modes and fleets'],
  ['accounts-and-billing', 'Accounts and billing'],
  ['voice', 'Talking to an agent'],
] as const;

for (const [slug, title] of guides) {
  test(`new public guide is reachable, reloadable and readable on mobile: ${slug}`, async ({ page }) => {
    await page.goto('/docs');
    await page.getByRole('link', { name: title, exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(page.url()).toContain(`/docs/${slug}`);
  });
}

test('a new guide is present in the actual Pagefind search index', async ({ page }) => {
  await page.goto('/docs');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').first().fill('fleets');
  const result = dialog.locator('.pagefind-ui__result-link')
    .filter({ hasText: 'Agent modes and fleets' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent modes and fleets' })).toBeVisible();
});
