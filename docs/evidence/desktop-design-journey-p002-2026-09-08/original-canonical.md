# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portal-desktop-design.spec.ts >> [desktop.entry.canonical] canonical link reaches its subject and takes precedence over a conflicting legacy subject
- Location: apps/operator/e2e/portal-desktop-design.spec.ts:102:5

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
        - generic [ref=e234]:
          - button "67 agents running, 43 thinking. Open the agent roster." [ref=e236] [cursor=pointer]:
            - generic [ref=e237]:
              - text: ⚡67
              - generic: agents running
              - text: · 43 thinking
          - button "2308 processes. Open the process manager." [ref=e239] [cursor=pointer]:
            - img [ref=e240]
            - generic [ref=e242]: 2308 processes
        - generic "Portal voice controls"
        - button "Start voice chat" [ref=e243] [cursor=pointer]:
          - img [ref=e244]
          - text: Start voice chat
        - link "Download TUI" [ref=e247] [cursor=pointer]:
          - /url: https://papercusp.com/download
          - img [ref=e248]
          - text: Download TUI
        - button "Notifications, 87 unread" [ref=e251] [cursor=pointer]:
          - img [ref=e252]
          - generic [ref=e255]: "87"
        - group "Theme" [ref=e256]:
          - button "Light" [ref=e257] [cursor=pointer]:
            - img [ref=e258]
          - button "System" [ref=e264] [cursor=pointer]:
            - img [ref=e265]
          - button "Dark" [pressed] [ref=e276] [cursor=pointer]:
            - img [ref=e277]
      - generic [ref=e281]:
        - generic [ref=e282]:
          - generic [ref=e283]:
            - paragraph [ref=e284]:
              - img [ref=e285]
              - text: Local BYOC control plane
            - heading "Cloud Workspaces" [level=1] [ref=e287]
            - paragraph [ref=e288]: Provision and operate durable Papercusp hosts in infrastructure you control. Desired state and observed state stay separate so drift is visible instead of guessed away.
          - generic [ref=e289]:
            - button "Refresh cloud workspace state" [ref=e290] [cursor=pointer]:
              - img [ref=e291]
              - text: Refresh
            - generic [ref=e296]: Live control state
        - generic [ref=e297]:
          - navigation "Cloud workspace setup" [ref=e298]:
            - list [ref=e299]:
              - listitem [ref=e300]:
                - 'button "01 Connect: needs attention. BYOC bounded canary · invalid" [ref=e301] [cursor=pointer]':
                  - img [ref=e303]
              - listitem [ref=e305]:
                - 'button "02 Configure: complete. Last provisioned 2d ago" [ref=e306] [cursor=pointer]':
                  - img [ref=e308]
              - listitem [ref=e309]:
                - 'button "03 Operate: current step. 12 workspaces · 1 needs attention" [ref=e310] [cursor=pointer]':
                  - img [ref=e312]
          - region "Managed workspaces" [ref=e316]:
            - generic [ref=e318]:
              - paragraph [ref=e319]:
                - generic [ref=e320]: "03"
                - text: Operate
              - heading "Managed workspaces" [level=2] [ref=e321]
              - paragraph [ref=e322]: Actions set desired state; reconciliation updates observed state and the durable progress stream.
            - status [ref=e323]:
              - img [ref=e324]
              - generic [ref=e326]:
                - strong [ref=e327]: 1 host has diverged from its desired state
                - list [ref=e328]:
                  - listitem [ref=e329]:
                    - button "p018-canary-20260905-r7" [ref=e330] [cursor=pointer]
                    - generic [ref=e331]: running → provisioning · diverged for 1d
            - list "Managed workspace hosts" [ref=e332]:
              - listitem [ref=e333]:
                - generic [ref=e334]:
                  - button "p018-canary-20260905-r6 GCP · us-central1 · e2-standard-2 · 40 GiB absent Unavailable / mo" [ref=e335] [cursor=pointer]:
                    - img [ref=e337]
                    - generic [ref=e340]:
                      - strong [ref=e341]: p018-canary-20260905-r6
                      - generic [ref=e342]: GCP · us-central1 · e2-standard-2 · 40 GiB
                    - generic [ref=e343]: absent
                    - generic [ref=e344]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r6" [ref=e345]:
                    - button "More actions for p018-canary-20260905-r6" [ref=e347] [cursor=pointer]:
                      - img [ref=e348]
              - listitem [ref=e352]:
                - generic [ref=e353]:
                  - button "p018-canary-20260905-r5 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e354] [cursor=pointer]:
                    - img [ref=e356]
                    - generic [ref=e359]:
                      - strong [ref=e360]: p018-canary-20260905-r5
                      - generic [ref=e361]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e362]: absent
                    - generic [ref=e363]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r5" [ref=e364]:
                    - button "More actions for p018-canary-20260905-r5" [ref=e366] [cursor=pointer]:
                      - img [ref=e367]
              - listitem [ref=e371]:
                - generic [ref=e372]:
                  - button "p018-canary-20260905-r4 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e373] [cursor=pointer]:
                    - img [ref=e375]
                    - generic [ref=e378]:
                      - strong [ref=e379]: p018-canary-20260905-r4
                      - generic [ref=e380]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e381]: absent
                    - generic [ref=e382]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r4" [ref=e383]:
                    - button "More actions for p018-canary-20260905-r4" [ref=e385] [cursor=pointer]:
                      - img [ref=e386]
              - listitem [ref=e390]:
                - generic [ref=e391]:
                  - button "p018-canary-20260905-r3 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e392] [cursor=pointer]:
                    - img [ref=e394]
                    - generic [ref=e397]:
                      - strong [ref=e398]: p018-canary-20260905-r3
                      - generic [ref=e399]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e400]: absent
                    - generic [ref=e401]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r3" [ref=e402]:
                    - button "More actions for p018-canary-20260905-r3" [ref=e404] [cursor=pointer]:
                      - img [ref=e405]
              - listitem [ref=e409]:
                - generic [ref=e410]:
                  - button "p018-canary-20260905-r2 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e411] [cursor=pointer]:
                    - img [ref=e413]
                    - generic [ref=e416]:
                      - strong [ref=e417]: p018-canary-20260905-r2
                      - generic [ref=e418]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e419]: absent
                    - generic [ref=e420]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r2" [ref=e421]:
                    - button "More actions for p018-canary-20260905-r2" [ref=e423] [cursor=pointer]:
                      - img [ref=e424]
              - listitem [ref=e428]:
                - generic [ref=e429]:
                  - button "p018-canary-20260905-r7 GCP · us-central1 · e2-standard-2 · 40 GiB running → provisioning Unavailable / mo" [ref=e430] [cursor=pointer]:
                    - img [ref=e432]
                    - generic [ref=e435]:
                      - strong [ref=e436]: p018-canary-20260905-r7
                      - generic [ref=e437]: GCP · us-central1 · e2-standard-2 · 40 GiB
                    - generic [ref=e438]: running → provisioning
                    - generic [ref=e439]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r7" [ref=e440]:
                    - button "Stop" [ref=e441] [cursor=pointer]:
                      - img [ref=e442]
                      - text: Stop
                    - button "More actions for p018-canary-20260905-r7" [ref=e445] [cursor=pointer]:
                      - img [ref=e446]
              - listitem [ref=e450]:
                - generic [ref=e451]:
                  - button "p046-canary-06 GCP · us-central1 · e2-standard-2 · 30 GiB destroying Unavailable / mo" [ref=e452] [cursor=pointer]:
                    - img [ref=e454]
                    - generic [ref=e457]:
                      - strong [ref=e458]: p046-canary-06
                      - generic [ref=e459]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e460]: destroying
                    - generic [ref=e461]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-06" [ref=e462]:
                    - button "More actions for p046-canary-06" [ref=e464] [cursor=pointer]:
                      - img [ref=e465]
              - listitem [ref=e469]:
                - generic [ref=e470]:
                  - button "p046-canary-05 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e471] [cursor=pointer]:
                    - img [ref=e473]
                    - generic [ref=e476]:
                      - strong [ref=e477]: p046-canary-05
                      - generic [ref=e478]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e479]: absent
                    - generic [ref=e480]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-05" [ref=e481]:
                    - button "More actions for p046-canary-05" [ref=e483] [cursor=pointer]:
                      - img [ref=e484]
              - listitem [ref=e488]:
                - generic [ref=e489]:
                  - button "P-046 canary 04 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e490] [cursor=pointer]:
                    - img [ref=e492]
                    - generic [ref=e495]:
                      - strong [ref=e496]: P-046 canary 04
                      - generic [ref=e497]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e498]: absent
                    - generic [ref=e499]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 canary 04" [ref=e500]:
                    - button "More actions for P-046 canary 04" [ref=e502] [cursor=pointer]:
                      - img [ref=e503]
              - listitem [ref=e507]:
                - generic [ref=e508]:
                  - button "P-046 live canary host r3 GCP · us-central1 · e2-small · 20 GiB absent Unavailable / mo" [ref=e509] [cursor=pointer]:
                    - img [ref=e511]
                    - generic [ref=e514]:
                      - strong [ref=e515]: P-046 live canary host r3
                      - generic [ref=e516]: GCP · us-central1 · e2-small · 20 GiB
                    - generic [ref=e517]: absent
                    - generic [ref=e518]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 live canary host r3" [ref=e519]:
                    - button "More actions for P-046 live canary host r3" [ref=e521] [cursor=pointer]:
                      - img [ref=e522]
              - listitem [ref=e526]:
                - generic [ref=e527]:
                  - button "p046-canary-03 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e528] [cursor=pointer]:
                    - img [ref=e530]
                    - generic [ref=e533]:
                      - strong [ref=e534]: p046-canary-03
                      - generic [ref=e535]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e536]: absent
                    - generic [ref=e537]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-03" [ref=e538]:
                    - button "More actions for p046-canary-03" [ref=e540] [cursor=pointer]:
                      - img [ref=e541]
              - listitem [ref=e545]:
                - generic [ref=e546]:
                  - button "P-046 live canary host GCP · us-central1 · e2-small · 20 GiB absent Unavailable / mo" [ref=e547] [cursor=pointer]:
                    - img [ref=e549]
                    - generic [ref=e552]:
                      - strong [ref=e553]: P-046 live canary host
                      - generic [ref=e554]: GCP · us-central1 · e2-small · 20 GiB
                    - generic [ref=e555]: absent
                    - generic [ref=e556]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 live canary host" [ref=e557]:
                    - button "More actions for P-046 live canary host" [ref=e559] [cursor=pointer]:
                      - img [ref=e560]
  - region "Notifications alt+T"
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
> 29  |   await expect(destination.getByText('Workspace unavailable', { exact: true })).toBeVisible();
      |                                                                                 ^ Error: expect(locator).toBeVisible() failed
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
  55  |   await page.getByRole('button', { name: 'Desktops', exact: true }).click();
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
```