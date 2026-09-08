import { expect, test } from '@playwright/test';

// This is a live Portal acceptance case, not the operator Vite server started by
// the default E2E config. Set the explicit target and reuse-server mode to run it.
const portalUrl = process.env.PORTAL_DESKTOP_ACCEPTANCE_URL;
test.skip(!portalUrl, 'Live portal acceptance requires PORTAL_DESKTOP_ACCEPTANCE_URL');

test('Desktops sidebar opens option B directly, including its real disconnected state', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${portalUrl}/?app=home&accountsPane=false&chatPane=false`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Desktops', exact: true }).click();
  const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
  await expect(destination).toBeVisible();
  await expect(page.getByRole('list', { name: 'Managed workspace hosts' })).toHaveCount(0);
  const roster = destination.getByRole('complementary', { name: 'Workspace desktops and activity' });
  await expect(roster).toBeVisible();
  const screenArea = destination.locator('[class*="desktopWorkspaceMain"]');
  const viewerBounds = await screenArea.boundingBox();
  const rosterBounds = await roster.boundingBox();
  expect(viewerBounds).not.toBeNull();
  expect(rosterBounds).not.toBeNull();
  expect(rosterBounds!.x).toBeGreaterThan(viewerBounds!.x + viewerBounds!.width - 2);
  expect(viewerBounds!.width).toBeGreaterThan(rosterBounds!.width);
  await page.screenshot({ path: testInfo.outputPath('desktop-option-b-1440.png'), fullPage: true });

  // The actual canary's unavailable state must remain truthful. This test does
  // not provision, initialize, connect, or take control of a cloud desktop.
  if (await destination.getByText('Your desktop is not ready yet').isVisible()) {
    await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(roster).toBeVisible();
  await expect.poll(async () => {
    const main = await screenArea.boundingBox();
    const side = await roster.boundingBox();
    return Boolean(main && side && side.y >= main.y + main.height - 2);
  }).toBe(true);
  expect(await destination.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-option-b-390.png'), fullPage: true });
});

test('an invalid desktop deep link cannot open a different machine', async ({ page }) => {
  await page.goto(`${portalUrl}/?app=desktops&desktopHost=acceptance-missing-host&accountsPane=false&chatPane=false`, { waitUntil: 'domcontentloaded' });
  const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
  await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
  await expect(destination.getByRole('region', { name: /^Desktops for / })).toHaveCount(0);
  await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
});
