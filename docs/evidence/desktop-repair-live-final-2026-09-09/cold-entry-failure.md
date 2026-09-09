# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portal-desktop-design.spec.ts >> [desktop.entry.clean] Desktops sidebar opens option B directly, including its real disconnected state
- Location: e2e/portal-desktop-design.spec.ts:52:5

# Error details

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Desktops', exact: true })

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]: Loading portal…
  - alert [ref=e3]
```

# Test source

```ts
  1   | import { expect, test, type Page } from './_egress';
  2   | 
  3   | // This is a live Portal acceptance case, not the operator Vite server started by
  4   | // the default E2E config. Set the explicit target and reuse-server mode to run it.
  5   | const portalUrl = process.env.PORTAL_DESKTOP_ACCEPTANCE_URL;
  6   | test.skip(!portalUrl, 'Live portal acceptance requires PORTAL_DESKTOP_ACCEPTANCE_URL');
  7   | 
  8   | const missingHost = 'acceptance-missing-host';
  9   | const destinationFor = (page: Page) => page.getByRole('region', { name: 'Desktop workspace', exact: true });
  10  | 
  11  | async function expectShellReady(page: Page) {
  12  |   // Use the real navigation as the app-list positive control. A shell that
  13  |   // never loads fails here, separately from a loaded shell mounting the wrong
  14  |   // destination. This uses the runner's existing action budget.
  15  |   await page.getByRole('button', { name: 'Desktops', exact: true }).waitFor({ state: 'visible' });
  16  | }
  17  | 
  18  | function desktopLink(selection: Record<string, string> = {}) {
  19  |   const url = new URL('/', portalUrl);
  20  |   url.search = new URLSearchParams({ app: 'desktops', accountsPane: 'false', chatPane: 'false', ...selection }).toString();
  21  |   return url.href;
  22  | }
  23  | 
  24  | /** Discover a real workspace through the delivered shell; never mount or stub the component. */
  25  | async function selectWorkspace(page: Page) {
  26  |   await page.goto(desktopLink({ desktopHost: missingHost }), { waitUntil: 'domcontentloaded' });
  27  |   await expectShellReady(page);
  28  |   const destination = destinationFor(page);
  29  |   await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
  30  |   await destination.getByRole('combobox', { name: 'Desktop workspace', exact: true }).click();
  31  |   await page.getByRole('option').first().click();
  32  |   const workspace = destination.getByRole('region', { name: /^Desktops for / });
  33  |   await expect(workspace).toBeVisible();
  34  |   await expect.poll(() => new URL(page.url()).searchParams.get('desktopHost')).not.toBe(missingHost);
  35  |   const host = new URL(page.url()).searchParams.get('desktopHost');
  36  |   expect(host, 'the selector must persist its actual subject in the URL').toBeTruthy();
  37  |   const name = await workspace.getAttribute('aria-label');
  38  |   expect(name).toBeTruthy();
  39  |   return { host: host!, name: name!, url: page.url() };
  40  | }
  41  | 
  42  | async function expectSelectedWorkspace(page: Page, selected: { host: string; name: string }, parameter = 'desktopHost') {
  43  |   await expectShellReady(page);
  44  |   await expect(destinationFor(page).getByRole('region', { name: selected.name, exact: true })).toBeVisible();
  45  |   await expect(page.getByRole('list', { name: 'Managed workspace hosts' })).toHaveCount(0);
  46  |   await expect.poll(() => new URL(page.url()).searchParams.get('app')).toBe('desktops');
  47  |   await expect.poll(() => new URL(page.url()).searchParams.get(parameter)).toBe(selected.host);
  48  | }
  49  | 
  50  | // These stable scenario ids are the P-002 acceptance contract. Each is runnable
  51  | // independently against the original and repaired builds, with the same checks.
  52  | test('[desktop.entry.clean] Desktops sidebar opens option B directly, including its real disconnected state', async ({ page }, testInfo) => {
  53  |   await page.setViewportSize({ width: 1440, height: 900 });
  54  |   await page.goto(`${portalUrl}/?app=home&accountsPane=false&chatPane=false`, { waitUntil: 'domcontentloaded' });
> 55  |   await page.getByRole('button', { name: 'Desktops', exact: true }).click();
      |                                                                     ^ TimeoutError: locator.click: Timeout 10000ms exceeded.
  56  |   const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
  57  |   await expect(destination).toBeVisible();
  58  |   await expect(page.getByRole('list', { name: 'Managed workspace hosts' })).toHaveCount(0);
  59  |   const roster = destination.getByRole('complementary', { name: 'Workspace desktops and activity' });
  60  |   await expect(roster).toBeVisible();
  61  |   const screenArea = destination.locator('[class*="desktopWorkspaceMain"]');
  62  |   const viewerBounds = await screenArea.boundingBox();
  63  |   const rosterBounds = await roster.boundingBox();
  64  |   expect(viewerBounds).not.toBeNull();
  65  |   expect(rosterBounds).not.toBeNull();
  66  |   expect(rosterBounds!.x).toBeGreaterThan(viewerBounds!.x + viewerBounds!.width - 2);
  67  |   expect(viewerBounds!.width).toBeGreaterThan(rosterBounds!.width);
  68  |   await page.screenshot({ path: testInfo.outputPath('desktop-option-b-1440.png'), fullPage: true });
  69  | 
  70  |   // The actual canary's unavailable state must remain truthful. This test does
  71  |   // not provision, initialize, connect, or take control of a cloud desktop.
  72  |   if (await destination.getByText('Your desktop is not ready yet').isVisible()) {
  73  |     await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
  74  |   }
  75  | 
  76  |   await page.setViewportSize({ width: 390, height: 844 });
  77  |   await expect(roster).toBeVisible();
  78  |   await expect.poll(async () => {
  79  |     const main = await screenArea.boundingBox();
  80  |     const side = await roster.boundingBox();
  81  |     return Boolean(main && side && side.y >= main.y + main.height - 2);
  82  |   }).toBe(true);
  83  |   expect(await destination.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  84  |   await page.screenshot({ path: testInfo.outputPath('desktop-option-b-390.png'), fullPage: true });
  85  |   await roster.scrollIntoViewIfNeeded();
  86  |   await expect(roster).toBeInViewport();
  87  |   await page.screenshot({ path: testInfo.outputPath('desktop-option-b-390-roster.png'), fullPage: true });
  88  | });
  89  | 
  90  | for (const param of ['desktopHost', 'host']) {
  91  |   test(`an invalid ${param} deep link cannot open a different machine`, async ({ page }) => {
  92  |     await page.goto(`${portalUrl}/?app=desktops&${param}=acceptance-missing-host&accountsPane=false&chatPane=false`, { waitUntil: 'domcontentloaded' });
  93  |     await expectShellReady(page);
  94  |     const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
  95  |     await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
  96  |     await expect(destination.getByRole('region', { name: /^Desktops for / })).toHaveCount(0);
  97  |     await expect(destination.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
  98  |     await expect.poll(() => new URL(page.url()).searchParams.get(param)).toBe('acceptance-missing-host');
  99  |   });
  100 | }
  101 | 
  102 | test('[desktop.entry.canonical] canonical link reaches its subject and takes precedence over a conflicting legacy subject', async ({ page }) => {
  103 |   const selected = await selectWorkspace(page);
  104 |   await page.goto('about:blank');
  105 |   await page.goto(desktopLink({ desktopHost: selected.host, host: missingHost }), { waitUntil: 'domcontentloaded' });
  106 |   await expectSelectedWorkspace(page, selected);
  107 | });
  108 | 
  109 | test('[desktop.entry.legacy] legacy link reaches its subject without a canonical selector', async ({ page }) => {
  110 |   const selected = await selectWorkspace(page);
  111 |   await page.goto('about:blank');
  112 |   await page.goto(desktopLink({ host: selected.host }), { waitUntil: 'domcontentloaded' });
  113 |   await expectSelectedWorkspace(page, selected, 'host');
  114 |   expect(new URL(page.url()).searchParams.get('desktopHost')).toBeNull();
  115 | });
  116 | 
  117 | test('[desktop.entry.persisted] a selected workspace URL opens the same subject in a fresh page', async ({ page, context }) => {
  118 |   const selected = await selectWorkspace(page);
  119 |   // A new page has no mounted component state. URL persistence is the product
  120 |   // contract; cross-destination sidebar switches intentionally clear selectors.
  121 |   const reopened = await context.newPage();
  122 |   try {
  123 |     await reopened.goto(selected.url, { waitUntil: 'domcontentloaded' });
  124 |     await expectSelectedWorkspace(reopened, selected);
  125 |   } finally {
  126 |     await reopened.close();
  127 |   }
  128 | });
  129 | 
  130 | test('[desktop.entry.reload] reloading preserves the selected workspace', async ({ page }) => {
  131 |   const selected = await selectWorkspace(page);
  132 |   await page.reload({ waitUntil: 'domcontentloaded' });
  133 |   await expectSelectedWorkspace(page, selected);
  134 | });
  135 | 
  136 | test('[desktop.entry.history] back and forward restore both unavailable and selected subjects', async ({ page }) => {
  137 |   const selected = await selectWorkspace(page);
  138 |   await page.goBack({ waitUntil: 'domcontentloaded' });
  139 |   await expect(destinationFor(page).getByText('Workspace unavailable', { exact: true })).toBeVisible();
  140 |   await expect.poll(() => new URL(page.url()).searchParams.get('desktopHost')).toBe(missingHost);
  141 |   await expect(destinationFor(page).getByRole('region', { name: selected.name, exact: true })).toHaveCount(0);
  142 |   await page.goForward({ waitUntil: 'domcontentloaded' });
  143 |   await expectSelectedWorkspace(page, selected);
  144 | });
  145 | 
  146 | test('desktop navigation completes while the auxiliary workspace-stats request is held', async ({ page }) => {
  147 |   let release!: () => void;
  148 |   const held = new Promise<void>((resolve) => { release = resolve; });
  149 |   const requested = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/workspace-stats');
  150 |   // Controlled latency only: the shell, app list and desktop destination are
  151 |   // real. This test makes no claim about the held roster response or readiness.
  152 |   await page.route('**/api/workspace-stats', async (route) => {
  153 |     await held;
  154 |     await route.abort();
  155 |   });
```