# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portal-desktop-design.spec.ts >> desktop navigation completes while the auxiliary workspace-stats request is held
- Location: e2e/portal-desktop-design.spec.ts:146:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('region', { name: 'Desktop workspace', exact: true }).getByText('Workspace unavailable', { exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('region', { name: 'Desktop workspace', exact: true }).getByText('Workspace unavailable', { exact: true })

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - alert [ref=e2]
  - generic [ref=e3]:
    - navigation "Apps" [ref=e4]:
      - generic "Papercusp Portal" [ref=e5]
      - button "Local workspace" [ref=e6] [cursor=pointer]:
        - img [ref=e7]
      - generic [ref=e11]:
        - button "Papercup Chat" [ref=e12] [cursor=pointer]:
          - img [ref=e13]
          - generic [ref=e16]: Papercup Chat
        - button "Chat history" [ref=e17] [cursor=pointer]:
          - img [ref=e18]
          - generic [ref=e22]: Chat history
        - generic [ref=e23]:
          - button "Calendar" [ref=e24] [cursor=pointer]:
            - img [ref=e25]
            - generic [ref=e27]: Calendar
          - button "Unpin Calendar" [ref=e28] [cursor=pointer]:
            - img [ref=e29]
        - generic [ref=e33]:
          - button "Phone" [ref=e34] [cursor=pointer]:
            - img [ref=e35]
            - generic [ref=e37]: Phone
          - button "Unpin Phone" [ref=e38] [cursor=pointer]:
            - img [ref=e39]
        - generic [ref=e43]:
          - button "Desktops" [ref=e44] [cursor=pointer]:
            - img [ref=e45]
            - generic [ref=e47]: Desktops
          - button "Unpin Desktops" [ref=e48] [cursor=pointer]:
            - img [ref=e49]
        - generic [ref=e53]:
          - button "Plans" [ref=e54] [cursor=pointer]:
            - img [ref=e55]
            - generic [ref=e58]: Plans
          - button "Unpin Plans" [ref=e59] [cursor=pointer]:
            - img [ref=e60]
        - generic [ref=e64]:
          - button "Inbox" [ref=e65] [cursor=pointer]:
            - img [ref=e66]
            - generic [ref=e69]: Inbox
          - button "Unpin Inbox" [ref=e70] [cursor=pointer]:
            - img [ref=e71]
        - generic [ref=e75]:
          - button "Workspaces" [ref=e76] [cursor=pointer]:
            - img [ref=e77]
            - generic [ref=e81]: Workspaces
          - button "Unpin Workspaces" [ref=e82] [cursor=pointer]:
            - img [ref=e83]
        - generic [ref=e87]:
          - button "Overview" [ref=e88] [cursor=pointer]:
            - img [ref=e89]
            - generic [ref=e94]: Overview
          - button "Unpin Overview" [ref=e95] [cursor=pointer]:
            - img [ref=e96]
        - generic [ref=e100]:
          - button "HUD" [ref=e101] [cursor=pointer]:
            - img [ref=e102]
            - generic [ref=e105]: HUD
          - button "Unpin HUD" [ref=e106] [cursor=pointer]:
            - img [ref=e107]
        - generic [ref=e111]:
          - button "Work" [ref=e112] [cursor=pointer]:
            - img [ref=e113]
            - generic [ref=e123]: Work
          - button "Unpin Work" [ref=e124] [cursor=pointer]:
            - img [ref=e125]
        - generic [ref=e129]:
          - button "Learning" [ref=e130] [cursor=pointer]:
            - img [ref=e131]
            - generic [ref=e134]: Learning
          - button "Unpin Learning" [ref=e135] [cursor=pointer]:
            - img [ref=e136]
        - generic [ref=e140]:
          - button "Workflow Editor" [ref=e141] [cursor=pointer]:
            - img [ref=e142]
            - generic [ref=e146]: Workflow Editor
          - button "Unpin Workflow Editor" [ref=e147] [cursor=pointer]:
            - img [ref=e148]
      - button "More sections" [ref=e152] [cursor=pointer]:
        - img [ref=e153]
        - generic [ref=e157]: More
      - generic [ref=e158]:
        - button "Cloud" [ref=e159] [cursor=pointer]:
          - img [ref=e160]
          - generic [ref=e162]: Cloud
        - button "Cupboard" [ref=e163] [cursor=pointer]:
          - img [ref=e164]
          - generic [ref=e168]: Cupboard
        - button "DEV" [ref=e169] [cursor=pointer]:
          - img [ref=e170]
          - generic [ref=e172]: DEV
        - button "Support" [ref=e173] [cursor=pointer]:
          - img [ref=e174]
          - generic [ref=e181]: Support
        - button "Settings" [ref=e182] [cursor=pointer]:
          - img [ref=e183]
          - generic [ref=e186]: Settings
        - 'button "Portal account: Local. Status: Local." [ref=e187] [cursor=pointer]':
          - img [ref=e188]
    - complementary "Accounts sidebar" [ref=e192]:
      - generic [ref=e193]:
        - button "Expand Accounts sidebar" [ref=e194] [cursor=pointer]:
          - img [ref=e195]
        - button "Open Accounts sidebar" [ref=e198] [cursor=pointer]:
          - img [ref=e199]
    - complementary "Papercup chat sidebar" [ref=e202]:
      - generic [ref=e203]:
        - button "Expand Papercup chat sidebar" [ref=e204] [cursor=pointer]:
          - img [ref=e205]
        - button "Open Papercup chat sidebar" [ref=e208] [cursor=pointer]:
          - img [ref=e209]
    - main [ref=e212]:
      - generic [ref=e213]:
        - heading "Desktops" [level=1] [ref=e216]
        - generic [ref=e217]:
          - generic [ref=e218]: Workspace
          - combobox "Workspace" [ref=e219]:
            - option "Local workspace" [selected]
        - button "Open app launcher" [ref=e220] [cursor=pointer]:
          - img [ref=e221]
          - generic [ref=e223]: ⌘K
        - button "Open quick panel" [ref=e224] [cursor=pointer]:
          - img [ref=e225]
          - generic [ref=e227]: ⌘J
        - generic [ref=e229]:
          - img [ref=e230]
          - combobox "Search or chat" [ref=e233]
        - generic "Portal voice controls"
        - button "Start voice chat" [ref=e234] [cursor=pointer]:
          - img [ref=e235]
          - text: Start voice chat
        - link "Download TUI" [ref=e238] [cursor=pointer]:
          - /url: https://papercusp.com/download
          - img [ref=e239]
          - text: Download TUI
        - button "Notifications, 87 unread" [ref=e242] [cursor=pointer]:
          - img [ref=e243]
          - generic [ref=e246]: "87"
        - group "Theme" [ref=e247]:
          - button "Light" [ref=e248] [cursor=pointer]:
            - img [ref=e249]
          - button "System" [ref=e255] [cursor=pointer]:
            - img [ref=e256]
          - button "Dark" [pressed] [ref=e267] [cursor=pointer]:
            - img [ref=e268]
      - status [ref=e272]:
        - heading "Loading Desktops…" [level=2] [ref=e273]
  - region "Notifications alt+T"
```

# Test source

```ts
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
  156 |   try {
  157 |     await page.goto(desktopLink({ desktopHost: missingHost }), { waitUntil: 'domcontentloaded' });
  158 |     await requested;
> 159 |     await expect(destinationFor(page).getByText('Workspace unavailable', { exact: true })).toBeVisible();
      |                                                                                            ^ Error: expect(locator).toBeVisible() failed
  160 |     await expect(page.getByRole('list', { name: 'Managed workspace hosts' })).toHaveCount(0);
  161 |   } finally {
  162 |     release();
  163 |     await page.unrouteAll({ behavior: 'wait' });
  164 |   }
  165 | });
  166 | 
```