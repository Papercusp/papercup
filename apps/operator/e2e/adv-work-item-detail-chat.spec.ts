/**
 * /adv Work-items DETAIL PANE + chat-launch end-to-end (real browser).
 *
 * WI-3238: the unified work-item Detail pane (DetailPanel → WorkItemDetail) and
 * its "Chat" affordance (EI-290 / WI-125) had unit coverage but no e2e — the
 * real journey a user takes was never exercised through a browser:
 *
 *   pick a work item in the grid  →  the Detail pane renders that item  →
 *   click "Chat"  →  a worker chat is created for it and a chat panel opens.
 *
 * Why an e2e and not just the jsdom render tests (WorkItemDetail.test.tsx):
 * the flow crosses THREE seams a jsdom test stubs away — the dockview
 * master-detail layout (the seeded Work-items-over-Detail split), the nuqs
 * `?sel` selection contract that couples the grid row-click to the Detail
 * pane, and `openFeatureChat`'s window-event → dock-drain that mounts the chat
 * panel. Only a real engine renders the dock + honours the event drain.
 *
 * Hermetic via route-stubbing (mirrors adv-work-items-filter.spec.ts): the
 * shell's projects/lite is stubbed so the slug always mounts the dock; the sync
 * batch returns two WI rows; the harness status / issues-list REST bootstraps
 * (which the Detail pane's useHarnessFeatures / useHarnessIssues gate on — a
 * null features/issues keeps the pane on "Loading…") return empty; and the
 * agent-chats list/create/load endpoints are stubbed so the chat launches
 * without a populated substrate.
 *
 * Like the sibling adv specs this drives the operator-vite SPA in the e2e
 * Chromium project. A stale HMR-disabled :3055 serves a blank #root — the shell
 * never mounts and the spec SKIPS (it does not falsely fail). Run against an
 * HMR-enabled Vite (the config's own webServer boots one) to actually exercise it.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched. Unique so no persisted dock layout for a
// real slug hydrates over the default Work-items-over-Detail seed.
const SLUG = process.env.ADV_WI_DETAIL_E2E_SLUG ?? 'e2e-wi-detail-pot';

// Two stubbed work items. Both carry WI-* ids so `resolveSelectionKind` routes
// them to the unified WorkItemDetail (F-*/I-* would take the feature/issue
// detail paths, which read different lists).
const WORK_ITEMS = [
  {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    title: 'First stubbed item',
    summary: 'A stubbed work item used to exercise the detail pane.',
    state: 'open',
    assignee: 'alice',
    assignedBy: null,
    severity: 'high',
    priority: 1,
    rank: 1,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-07-06T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
  {
    id: 'WI-2',
    kind: 'task',
    family: 'issue',
    title: 'Second stubbed item',
    summary: null,
    state: 'in_progress',
    assignee: 'bob',
    assignedBy: null,
    severity: null,
    priority: 2,
    rank: 2,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-07-06T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
];

const SKIP_MSG =
  'The /adv shell did not mount the harnesses dock. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

// Records every agent-chat CREATE (POST) the page makes, so a test can assert
// the chat-launch fired with the right work-item binding.
interface CreatedChat {
  role?: string;
  featureId?: string | null;
  title?: string | null;
}

async function stubApis(page: Page, created: CreatedChat[]) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [
          {
            slug: SLUG,
            path: `/tmp/${SLUG}`,
            name: SLUG,
            hasState: true,
            hasSpec: true,
            parent_slug: null,
            harness_kind: 'project',
            is_shared: false,
          },
        ],
      }),
    });
  });

  // Top-bar status + the Detail pane's useHarnessFeatures REST bootstrap both
  // hit /status — carry BOTH shapes (counts for the bar, features:[] so the
  // features list resolves to [] and the pane leaves "Loading…").
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 }, features: [] }),
    });
  });
  // useHarnessIssues REST bootstrap — issues:[] so the issues list resolves.
  await page.route('**/api/harness/*/issues-list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ issues: [], pending: [] }),
    });
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ lanes: [], max: 1 }),
    });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [], runs: [] }),
    });
  });

  // Agent-chats: the reuse-check LIST (GET …/agent-chats), the CREATE
  // (POST …/agent-chats) and the ChatPanel LOAD (GET …/agent-chats/<id>).
  // Ordered before the generic list route below? No — Playwright matches the
  // MOST-RECENTLY-registered route first, so this specific one must be
  // registered AFTER the batch route (it is). We disambiguate by method + path.
  await page.route('**/api/harness/*/agent-chats**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Path after …/agent-chats : '' for list/create, '/<id>…' for a specific chat.
    const tail = url.pathname.replace(/^.*\/agent-chats/, '');
    const hasChatId = tail.length > 1; // '' or '/' → list/create; '/<id>' → specific

    if (!hasChatId) {
      if (req.method() === 'POST') {
        const body = (req.postDataJSON() ?? {}) as {
          role?: string;
          feature_id?: string | null;
          title?: string | null;
        };
        created.push({ role: body.role, featureId: body.feature_id, title: body.title });
        // Return title:null so the opened dock tab falls back to the
        // distinctive `${role} · ${featureId}` label the drain computes.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'chat-e2e-1',
            role: body.role ?? 'worker',
            feature_id: body.feature_id ?? null,
            title: null,
          }),
        });
        return;
      }
      // GET list → empty so openFeatureChat takes the create path.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      });
      return;
    }

    // Specific chat load / delete — benign so ChatPanel mounts without error.
    if (req.method() === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'chat-e2e-1',
        role: 'worker',
        feature_id: 'WI-1',
        title: null,
        mode: 'discuss',
        messages: [],
      }),
    });
  });

  // Sync batch — rows per query NAME. workItems.byHarness → our two rows;
  // everything else (features/issues/agent-runs consolidated overlays,
  // agentChats.byHarness, …) → [].
  await page.route('**/api/zero-harness/rest-query-batch**', async (route) => {
    const post = route.request().postDataJSON() as
      | { queries?: Array<{ name?: string; args?: unknown }> }
      | null;
    const queries = post?.queries ?? [];
    const results = queries.map((q) => {
      const rows = q.name === 'workItems.byHarness' ? WORK_ITEMS : [];
      return { rows, version: String(Date.now()) };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });
}

/**
 * Drives to the harnesses dock and reports whether it mounted. `welcome=0`
 * suppresses the no-work HarnessWelcome overlay (default-on, gated on
 * useHarnessHasNoWork) — with empty features/issues stubs it otherwise covers
 * the dock and intercepts every click.
 */
async function dockMounts(page: Page, sel?: string): Promise<boolean> {
  const selPart = sel ? `&sel=${sel}` : '';
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self&welcome=0${selPart}`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('/adv work-item Detail pane + chat launch', () => {
  test('deep-linked work item renders the Detail pane and its Chat button launches a worker chat', async ({
    page,
  }) => {
    const created: CreatedChat[] = [];
    await stubApis(page, created);
    const mounted = await dockMounts(page, 'WI-1');
    test.skip(!mounted, SKIP_MSG);

    // The seeded Detail pane resolves ?sel=WI-1 against workItems.byHarness and
    // renders WorkItemDetail — id + title in the header, the Chat action below.
    const detail = page.locator('.pc-adv-detail').first();
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('First stubbed item', {
      timeout: 20_000,
    });
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-1');
    const chatBtn = detail.getByTestId('wi-detail-chat');
    await expect(chatBtn).toBeVisible();

    // Launch the chat — openFeatureChat POSTs /agent-chats then fires the
    // open-chat event the dock drains into a Chat panel.
    await chatBtn.click();

    // The create must carry THIS item's binding (worker role, discuss is
    // sent per-message not in the create body).
    await expect
      .poll(() => created.find((c) => c.featureId === 'WI-1'), { timeout: 10_000 })
      .toBeTruthy();
    const chat = created.find((c) => c.featureId === 'WI-1')!;
    expect(chat.role).toBe('worker');
    expect(chat.title).toBe('First stubbed item');

    // The drain mounts a Chat panel — its tab falls back to `worker · WI-1`
    // (created chat title is null), proving the event reached the dock.
    await expect(page.getByText('worker · WI-1').first()).toBeVisible({ timeout: 15_000 });
  });

  test('clicking a grid row drives the Detail pane selection', async ({ page }) => {
    const created: CreatedChat[] = [];
    await stubApis(page, created);
    const mounted = await dockMounts(page); // no ?sel — pane starts on the empty state
    test.skip(!mounted, SKIP_MSG);

    // The Work-items grid renders both rows; the Detail pane shows its
    // pick-an-item empty state until a row is clicked.
    const detail = page.locator('.pc-adv-detail').first();
    const grid = page.locator('.pc-advpanel').first();
    await expect(grid.getByText('Second stubbed item')).toBeVisible({ timeout: 20_000 });

    // Row click sets ?sel via nuqs → the Detail pane follows to that item.
    await grid.getByText('Second stubbed item').click();
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('Second stubbed item', {
      timeout: 15_000,
    });
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-2');
    await expect(detail.getByTestId('wi-detail-chat')).toBeVisible();
  });
});
