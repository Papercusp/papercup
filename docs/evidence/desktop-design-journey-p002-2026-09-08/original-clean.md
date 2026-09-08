# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: portal-desktop-design.spec.ts >> [desktop.entry.clean] Desktops sidebar opens option B directly, including its real disconnected state
- Location: apps/operator/e2e/portal-desktop-design.spec.ts:52:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('region', { name: 'Desktop workspace', exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('region', { name: 'Desktop workspace', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e1]:
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
          - button "Desktops" [active] [ref=e44] [cursor=pointer]:
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
                  - generic [ref=e305]:
                    - generic [ref=e306]: "01"
                    - generic [ref=e307]: Connect
                    - generic [ref=e308]: BYOC bounded canary · invalid
              - listitem [ref=e310]:
                - 'button "02 Configure: complete. Last provisioned 2d ago" [ref=e311] [cursor=pointer]':
                  - img [ref=e313]
                  - generic [ref=e314]:
                    - generic [ref=e315]: "02"
                    - generic [ref=e316]: Configure
                    - generic [ref=e317]: Last provisioned 2d ago
              - listitem [ref=e319]:
                - 'button "03 Operate: current step. 12 workspaces · 1 needs attention" [ref=e320] [cursor=pointer]':
                  - img [ref=e322]
                  - generic [ref=e325]:
                    - generic [ref=e326]: "03"
                    - generic [ref=e327]: Operate
                    - generic [ref=e328]: 12 workspaces · 1 needs attention
            - region "Fleet posture" [ref=e330]:
              - generic [ref=e331]:
                - generic [ref=e332]: Running
                - strong [ref=e333]: "1"
              - generic [ref=e334]:
                - generic [ref=e335]: Stopped
                - strong [ref=e336]: "0"
              - generic [ref=e337]:
                - generic [ref=e338]: Drifting
                - strong [ref=e339]: "1"
              - generic [ref=e340]:
                - generic [ref=e341]: Monthly
                - strong [ref=e342]: $0.00
            - region "Recent activity" [ref=e343]:
              - heading "Recent activity" [level=2] [ref=e344]
              - list [ref=e345]:
                - listitem [ref=e346]:
                  - generic [ref=e348]:
                    - strong [ref=e349]: BYOC Canary GCP
                    - generic [ref=e350]: Provider catalog validated
                    - time [ref=e351]: 9/8/2026, 10:39:29 AM
                - listitem [ref=e352]:
                  - generic [ref=e354]:
                    - strong [ref=e355]: p018-canary-20260905-r7
                    - generic [ref=e356]: initialize:failed · Workspace host initialization failed after 5/6 steps
                    - time [ref=e357]: 9/7/2026, 1:40:32 AM
                - listitem [ref=e358]:
                  - generic [ref=e360]:
                    - strong [ref=e361]: p018-canary-20260905-r7
                    - generic [ref=e362]: initialize:bind-credential · Initialization step 'bind-agent' (bind-credential) succeeded
                    - time [ref=e363]: 9/7/2026, 1:38:23 AM
                - listitem [ref=e364]:
                  - generic [ref=e366]:
                    - strong [ref=e367]: p018-canary-20260905-r7
                    - generic [ref=e368]: initialize:bind-credential · Initialization step 'bind-cloud' (bind-credential) succeeded
                    - time [ref=e369]: 9/7/2026, 1:38:18 AM
                - listitem [ref=e370]:
                  - generic [ref=e372]:
                    - strong [ref=e373]: p018-canary-20260905-r7
                    - generic [ref=e374]: initialize:clone-repository · Initialization step 'source' (clone-repository) succeeded
                    - time [ref=e375]: 9/7/2026, 1:38:14 AM
                - listitem [ref=e376]:
                  - generic [ref=e378]:
                    - strong [ref=e379]: p018-canary-20260905-r7
                    - generic [ref=e380]: initialize:bind-credential · Initialization step 'bind-git' (bind-credential) succeeded
                    - time [ref=e381]: 9/7/2026, 1:38:07 AM
          - region "Managed workspaces" [ref=e383]:
            - generic [ref=e385]:
              - paragraph [ref=e386]:
                - generic [ref=e387]: "03"
                - text: Operate
              - heading "Managed workspaces" [level=2] [ref=e388]
              - paragraph [ref=e389]: Actions set desired state; reconciliation updates observed state and the durable progress stream.
            - status [ref=e390]:
              - img [ref=e391]
              - generic [ref=e393]:
                - strong [ref=e394]: 1 host has diverged from its desired state
                - list [ref=e395]:
                  - listitem [ref=e396]:
                    - button "p018-canary-20260905-r7" [ref=e397] [cursor=pointer]
                    - generic [ref=e398]: running → provisioning · diverged for 1d
            - list "Managed workspace hosts" [ref=e399]:
              - listitem [ref=e400]:
                - generic [ref=e401]:
                  - button "p018-canary-20260905-r6 GCP · us-central1 · e2-standard-2 · 40 GiB absent Unavailable / mo" [ref=e402] [cursor=pointer]:
                    - img [ref=e404]
                    - generic [ref=e407]:
                      - strong [ref=e408]: p018-canary-20260905-r6
                      - generic [ref=e409]: GCP · us-central1 · e2-standard-2 · 40 GiB
                    - generic [ref=e410]: absent
                    - generic [ref=e411]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r6" [ref=e412]:
                    - button "More actions for p018-canary-20260905-r6" [ref=e414] [cursor=pointer]:
                      - img [ref=e415]
              - listitem [ref=e419]:
                - generic [ref=e420]:
                  - button "p018-canary-20260905-r5 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e421] [cursor=pointer]:
                    - img [ref=e423]
                    - generic [ref=e426]:
                      - strong [ref=e427]: p018-canary-20260905-r5
                      - generic [ref=e428]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e429]: absent
                    - generic [ref=e430]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r5" [ref=e431]:
                    - button "More actions for p018-canary-20260905-r5" [ref=e433] [cursor=pointer]:
                      - img [ref=e434]
              - listitem [ref=e438]:
                - generic [ref=e439]:
                  - button "p018-canary-20260905-r4 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e440] [cursor=pointer]:
                    - img [ref=e442]
                    - generic [ref=e445]:
                      - strong [ref=e446]: p018-canary-20260905-r4
                      - generic [ref=e447]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e448]: absent
                    - generic [ref=e449]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r4" [ref=e450]:
                    - button "More actions for p018-canary-20260905-r4" [ref=e452] [cursor=pointer]:
                      - img [ref=e453]
              - listitem [ref=e457]:
                - generic [ref=e458]:
                  - button "p018-canary-20260905-r3 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e459] [cursor=pointer]:
                    - img [ref=e461]
                    - generic [ref=e464]:
                      - strong [ref=e465]: p018-canary-20260905-r3
                      - generic [ref=e466]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e467]: absent
                    - generic [ref=e468]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r3" [ref=e469]:
                    - button "More actions for p018-canary-20260905-r3" [ref=e471] [cursor=pointer]:
                      - img [ref=e472]
              - listitem [ref=e476]:
                - generic [ref=e477]:
                  - button "p018-canary-20260905-r2 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e478] [cursor=pointer]:
                    - img [ref=e480]
                    - generic [ref=e483]:
                      - strong [ref=e484]: p018-canary-20260905-r2
                      - generic [ref=e485]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e486]: absent
                    - generic [ref=e487]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r2" [ref=e488]:
                    - button "More actions for p018-canary-20260905-r2" [ref=e490] [cursor=pointer]:
                      - img [ref=e491]
              - listitem [ref=e495]:
                - generic [ref=e496]:
                  - button "p018-canary-20260905-r7 GCP · us-central1 · e2-standard-2 · 40 GiB running → provisioning Unavailable / mo" [ref=e497] [cursor=pointer]:
                    - img [ref=e499]
                    - generic [ref=e502]:
                      - strong [ref=e503]: p018-canary-20260905-r7
                      - generic [ref=e504]: GCP · us-central1 · e2-standard-2 · 40 GiB
                    - generic [ref=e505]: running → provisioning
                    - generic [ref=e506]: Unavailable / mo
                  - generic "Lifecycle actions for p018-canary-20260905-r7" [ref=e507]:
                    - button "Stop" [ref=e508] [cursor=pointer]:
                      - img [ref=e509]
                      - text: Stop
                    - button "More actions for p018-canary-20260905-r7" [ref=e512] [cursor=pointer]:
                      - img [ref=e513]
              - listitem [ref=e517]:
                - generic [ref=e518]:
                  - button "p046-canary-06 GCP · us-central1 · e2-standard-2 · 30 GiB destroying Unavailable / mo" [ref=e519] [cursor=pointer]:
                    - img [ref=e521]
                    - generic [ref=e524]:
                      - strong [ref=e525]: p046-canary-06
                      - generic [ref=e526]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e527]: destroying
                    - generic [ref=e528]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-06" [ref=e529]:
                    - button "More actions for p046-canary-06" [ref=e531] [cursor=pointer]:
                      - img [ref=e532]
              - listitem [ref=e536]:
                - generic [ref=e537]:
                  - button "p046-canary-05 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e538] [cursor=pointer]:
                    - img [ref=e540]
                    - generic [ref=e543]:
                      - strong [ref=e544]: p046-canary-05
                      - generic [ref=e545]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e546]: absent
                    - generic [ref=e547]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-05" [ref=e548]:
                    - button "More actions for p046-canary-05" [ref=e550] [cursor=pointer]:
                      - img [ref=e551]
              - listitem [ref=e555]:
                - generic [ref=e556]:
                  - button "P-046 canary 04 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e557] [cursor=pointer]:
                    - img [ref=e559]
                    - generic [ref=e562]:
                      - strong [ref=e563]: P-046 canary 04
                      - generic [ref=e564]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e565]: absent
                    - generic [ref=e566]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 canary 04" [ref=e567]:
                    - button "More actions for P-046 canary 04" [ref=e569] [cursor=pointer]:
                      - img [ref=e570]
              - listitem [ref=e574]:
                - generic [ref=e575]:
                  - button "P-046 live canary host r3 GCP · us-central1 · e2-small · 20 GiB absent Unavailable / mo" [ref=e576] [cursor=pointer]:
                    - img [ref=e578]
                    - generic [ref=e581]:
                      - strong [ref=e582]: P-046 live canary host r3
                      - generic [ref=e583]: GCP · us-central1 · e2-small · 20 GiB
                    - generic [ref=e584]: absent
                    - generic [ref=e585]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 live canary host r3" [ref=e586]:
                    - button "More actions for P-046 live canary host r3" [ref=e588] [cursor=pointer]:
                      - img [ref=e589]
              - listitem [ref=e593]:
                - generic [ref=e594]:
                  - button "p046-canary-03 GCP · us-central1 · e2-standard-2 · 30 GiB absent Unavailable / mo" [ref=e595] [cursor=pointer]:
                    - img [ref=e597]
                    - generic [ref=e600]:
                      - strong [ref=e601]: p046-canary-03
                      - generic [ref=e602]: GCP · us-central1 · e2-standard-2 · 30 GiB
                    - generic [ref=e603]: absent
                    - generic [ref=e604]: Unavailable / mo
                  - generic "Lifecycle actions for p046-canary-03" [ref=e605]:
                    - button "More actions for p046-canary-03" [ref=e607] [cursor=pointer]:
                      - img [ref=e608]
              - listitem [ref=e612]:
                - generic [ref=e613]:
                  - button "P-046 live canary host GCP · us-central1 · e2-small · 20 GiB absent Unavailable / mo" [ref=e614] [cursor=pointer]:
                    - img [ref=e616]
                    - generic [ref=e619]:
                      - strong [ref=e620]: P-046 live canary host
                      - generic [ref=e621]: GCP · us-central1 · e2-small · 20 GiB
                    - generic [ref=e622]: absent
                    - generic [ref=e623]: Unavailable / mo
                  - generic "Lifecycle actions for P-046 live canary host" [ref=e624]:
                    - button "More actions for P-046 live canary host" [ref=e626] [cursor=pointer]:
                      - img [ref=e627]
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
  55  |   await page.getByRole('button', { name: 'Desktops', exact: true }).click();
  56  |   const destination = page.getByRole('region', { name: 'Desktop workspace', exact: true });
> 57  |   await expect(destination).toBeVisible();
      |                             ^ Error: expect(locator).toBeVisible() failed
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
  156 |   try {
  157 |     await page.goto(desktopLink({ desktopHost: missingHost }), { waitUntil: 'domcontentloaded' });
```