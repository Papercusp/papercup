import { expect, test, type Page } from './_egress';

// This is a live Portal acceptance case, not the operator Vite server started by
// the default E2E config. Set the explicit target and reuse-server mode to run it.
const portalUrl = process.env.PORTAL_DESKTOP_ACCEPTANCE_URL;
test.skip(!portalUrl, 'Live portal acceptance requires PORTAL_DESKTOP_ACCEPTANCE_URL');

const missingHost = 'acceptance-missing-host';
const destinationFor = (page: Page) => page.getByRole('region', { name: 'Desktop workspace', exact: true });

function desktopLink(selection: Record<string, string> = {}) {
  const url = new URL('/', portalUrl);
  url.search = new URLSearchParams({ app: 'desktops', accountsPane: 'false', chatPane: 'false', ...selection }).toString();
  return url.href;
}

/** Discover a real workspace through the delivered shell; never mount or stub the component. */
async function selectWorkspace(page: Page) {
  await page.goto(desktopLink({ desktopHost: missingHost }), { waitUntil: 'domcontentloaded' });
  const destination = destinationFor(page);
  await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
  await destination.getByRole('combobox', { name: 'Desktop workspace', exact: true }).click();
  await page.getByRole('option').first().click();
  const workspace = destination.getByRole('region', { name: /^Desktops for / });
  await expect(workspace).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('desktopHost')).not.toBe(missingHost);
  const host = new URL(page.url()).searchParams.get('desktopHost');
  expect(host, 'the selector must persist its actual subject in the URL').toBeTruthy();
  const name = await workspace.getAttribute('aria-label');
  expect(name).toBeTruthy();
  return { host: host!, name: name!, url: page.url() };
}

async function expectSelectedWorkspace(page: Page, selected: { host: string; name: string }, parameter = 'desktopHost') {
  await expect(destinationFor(page).getByRole('region', { name: selected.name, exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Managed workspace hosts' })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('app')).toBe('desktops');
  await expect.poll(() => new URL(page.url()).searchParams.get(parameter)).toBe(selected.host);
}

// These stable scenario ids are the P-002 acceptance contract. Each is runnable
// independently against the original and repaired builds, with the same checks.
test('[desktop.entry.clean] Desktops sidebar opens option B directly, including its real disconnected state', async ({ page }, testInfo) => {
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
  await roster.scrollIntoViewIfNeeded();
  await expect(roster).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('desktop-option-b-390-roster.png'), fullPage: true });
});

for (const param of ['desktopHost', 'host']) {
  test(`an invalid ${param} deep link cannot open a different machine`, async ({ page }) => {
    await page.goto(`${portalUrl}/?app=desktops&${param}=acceptance-missing-host&accountsPane=false&chatPane=false`, { waitUntil: 'domcontentloaded' });
    const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
    await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
    await expect(destination.getByRole('region', { name: /^Desktops for / })).toHaveCount(0);
    await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get(param)).toBe('acceptance-missing-host');
  });
}

test('[desktop.entry.canonical] canonical link reaches its subject and takes precedence over a conflicting legacy subject', async ({ page }) => {
  const selected = await selectWorkspace(page);
  await page.goto('about:blank');
  await page.goto(desktopLink({ desktopHost: selected.host, host: missingHost }), { waitUntil: 'domcontentloaded' });
  await expectSelectedWorkspace(page, selected);
});

test('[desktop.entry.legacy] legacy link reaches its subject without a canonical selector', async ({ page }) => {
  const selected = await selectWorkspace(page);
  await page.goto('about:blank');
  await page.goto(desktopLink({ host: selected.host }), { waitUntil: 'domcontentloaded' });
  await expectSelectedWorkspace(page, selected, 'host');
  expect(new URL(page.url()).searchParams.get('desktopHost')).toBeNull();
});

test('[desktop.entry.persisted] a selected workspace URL opens the same subject in a fresh page', async ({ page, context }) => {
  const selected = await selectWorkspace(page);
  // A new page has no mounted component state. URL persistence is the product
  // contract; cross-destination sidebar switches intentionally clear selectors.
  const reopened = await context.newPage();
  try {
    await reopened.goto(selected.url, { waitUntil: 'domcontentloaded' });
    await expectSelectedWorkspace(reopened, selected);
  } finally {
    await reopened.close();
  }
});

test('[desktop.entry.reload] reloading preserves the selected workspace', async ({ page }) => {
  const selected = await selectWorkspace(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectSelectedWorkspace(page, selected);
});

test('[desktop.entry.history] back and forward restore both unavailable and selected subjects', async ({ page }) => {
  const selected = await selectWorkspace(page);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(destinationFor(page).getByText('Workspace unavailable', { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('desktopHost')).toBe(missingHost);
  await expect(destinationFor(page).getByRole('region', { name: selected.name, exact: true })).toHaveCount(0);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await expectSelectedWorkspace(page, selected);
});
