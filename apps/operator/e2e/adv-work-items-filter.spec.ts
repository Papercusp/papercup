/**
 * /adv Work-items panel — column FILTER BAR end-to-end (real browser).
 *
 * Bug (user-reported, 2026-06-14): on the /adv "Working" tab WorkItemsPanel,
 * clicking the "+ Add filter" dropdown and picking a column "does nothing" —
 * the per-column filter editor popover never opens.
 *
 * Root cause (ColumnFilterBar.tsx): the `+ Add filter` is a Radix <Select>.
 * On selection it set `editingKey` SYNCHRONOUSLY inside `onValueChange`, which
 * mounts the editor <Popover> in the SAME click gesture. The Select's closing
 * pointer event then lands on the freshly-mounted Popover's dismissable layer
 * as an "outside" interaction and dismisses it instantly. The fix defers the
 * open one frame (`requestAnimationFrame(() => setEditingKey(key))`) so the
 * Select fully closes + settles focus before the Popover mounts.
 *
 * Why an e2e (not a jsdom render test): the dismiss is a REAL Radix
 * dismissable-layer pointer-event race — jsdom fires no layout/pointer events
 * for it, so the synchronous version "passes" there. Only a real browser
 * engine reproduces the bug, which is exactly what this spec exercises. Flip
 * the rAF back to a synchronous `setEditingKey(key)` and this spec goes red
 * (the editor never opens) — that is the causation guard for the fix.
 *
 * Hermetic via route-stubbing (mirrors adv-contributors-panel.spec.ts): the
 * shell's projects/lite is stubbed so the slug always mounts the dock, and the
 * sync layer's `POST /api/zero-harness/rest-query-batch` is stubbed so
 * `workItems.byHarness` returns a couple of rows (enough to make the State/Kind
 * enum option lists non-empty) without depending on a populated substrate.
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA in the e2e
 * Chromium project. A stale HMR-disabled :3055 serves a blank #root — the
 * shell never mounts and the spec SKIPS (it does not falsely fail). Run against
 * an HMR-enabled Vite (the config's own webServer boots one) to actually
 * exercise it.
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched.
const SLUG = process.env.ADV_WI_FILTER_E2E_SLUG ?? 'e2e-wi-filter-pot';

// Two stubbed work items so the enum option lists (State / Kind) are non-empty.
// `family` drives which status-pill table the State cell renders from — both
// values present so neither render path is skipped.
const WORK_ITEMS = [
  {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    title: 'First stubbed item',
    summary: null,
    state: 'open',
    assignee: 'alice',
    assignedBy: null,
    severity: 'high',
    priority: 1,
    rank: 1,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-06-14T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
  {
    id: 'F-2',
    kind: 'feature',
    family: 'feature',
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
    updatedAt: '2026-06-14T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
];

const SKIP_MSG =
  'The /adv shell did not mount the Work items panel. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

/**
 * Stub the data the shell + panel need so this is hermetic:
 *   - projects/lite validates the URL slug (keeps the persisted-selection
 *     restore from flipping to all-mode and hiding the per-pot dock),
 *   - status/lanes/agents keep the top bar benign,
 *   - the sync batch endpoint returns rows per query NAME (workItems.byHarness
 *     → our two rows; everything else → []). The batch contract is
 *     `POST /api/zero-harness/rest-query-batch` with body
 *     `{ queries: [{ name, args }] }` → `{ results: [{ rows, version }] }` in
 *     order (libs/generic/sync/.../batch-fetcher.ts).
 */
async function stubApis(page: Page) {
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
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }),
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
      body: JSON.stringify({ agents: [] }),
    });
  });

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

/** Drives to the harnesses ("Working") dock and reports whether it mounted. */
async function dockMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Ensure a Work items panel is mounted + focused via the real Add-panel catalog
 * (the user-facing flow). The default dock layout already seeds one; the catalog
 * click focuses that existing instance rather than duplicating it. Either way the
 * filter bar ends up on screen. Returns the bar root locator.
 */
async function openWorkItemsPanel(page: Page) {
  await page.getByRole('button', { name: 'Add panel' }).click();
  const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
  await expect(catalog).toBeVisible();
  await catalog.getByText('Work items', { exact: true }).first().click();

  // The filter bar renders from the panel's static filterable columns even with
  // zero rows, so it is the stable anchor for "the panel is up".
  const bar = page.locator('.pc-advpanel__filterbar').first();
  await expect(bar).toBeVisible({ timeout: 15_000 });
  return bar;
}

function wifParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('wif');
}

test.describe('/adv Work items panel — column filter bar', () => {
  test('+ Add filter → picking a column opens the editor popover (the dismiss-race fix)', async ({
    page,
  }) => {
    await stubApis(page);
    const mounted = await dockMounts(page);
    test.skip(!mounted, SKIP_MSG);

    const bar = await openWorkItemsPanel(page);

    // Open the "+ Add filter" Select (aria-label "Add a column filter").
    const addFilter = bar.getByRole('combobox', { name: 'Add a column filter' });
    await expect(addFilter).toBeVisible();
    await addFilter.click();

    // Pick the State column from the Select's listbox.
    await page.getByRole('option', { name: 'State', exact: true }).click();

    // THE ASSERTION THE BUG BREAKS: the per-column editor popover must OPEN and
    // STAY open. With the synchronous (buggy) setEditingKey the Select's closing
    // pointer event dismisses it in the same gesture, so this dialog never
    // appears. With the rAF fix it survives.
    const editor = page.getByRole('dialog', { name: 'Edit State filter' });
    await expect(editor).toBeVisible({ timeout: 5_000 });

    // The enum editor lists the live state values (derived from the stubbed
    // rows): "open" and "in_progress".
    await expect(editor.getByText('open', { exact: true })).toBeVisible();
    await expect(editor.getByText('in_progress', { exact: true })).toBeVisible();

    // Select a value → a removable chip appears AND the URL gains the `wif` param.
    await editor.getByRole('checkbox', { name: 'open' }).click();

    const chip = bar.locator('.pc-advpanel__chip', { hasText: 'State: open' });
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).not.toBeNull();

    // Close the editor, then "Clear all" drops the filter + the URL param.
    await editor.getByRole('button', { name: 'Close filter editor' }).click();
    await bar.getByRole('button', { name: 'Clear all' }).click();
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'State: open' })).toHaveCount(0);
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).toBeNull();
  });
});
