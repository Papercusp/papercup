/**
 * /adv Work-items dock mount must not fire a React render loop (WI-39552).
 *
 * Mounting the harnesses dock with a Work-items panel emitted a burst of ~40
 * `Maximum update depth exceeded` console.errors over ~4s. React only emits that
 * after 50 nested update passes, so each line is a real runaway loop React
 * aborted — not a slow-render warning.
 *
 * WHY THIS SPEC EXISTS SEPARATELY FROM adv-work-items-filter.spec.ts: that spec
 * passes GREEN while the loop fires. The falsifier for this defect is the
 * console-error COUNT, not a test verdict, so it needs an oracle that watches the
 * console — no assertion about filter behaviour can catch it.
 *
 * Set WI39552_DEBUG=1 to dump each captured error's stack + location instead of
 * only counting them.
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const SLUG = 'e2e-wi-renderloop-pot';

const PROJECTS = [
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
];

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
    id: 'WI-2',
    kind: 'change',
    family: 'feature',
    title: 'Second stubbed item',
    summary: null,
    state: 'wip',
    assignee: 'bob',
    assignedBy: null,
    severity: 'low',
    priority: 2,
    rank: 2,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-06-15T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
];

const SKIP_MSG =
  'The /adv shell did not mount the Work items panel. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1).';

const LOOP_RE = /Maximum update depth exceeded/;

async function stubApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: PROJECTS }),
    });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }),
    });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [] }),
    });
  });
  return stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return PROJECTS;
    if (name === 'workItems.byHarness') return WORK_ITEMS;
    return undefined;
  });
}

test.describe('/adv Work items panel — render loop', () => {
  test('mounting the dock fires zero "Maximum update depth exceeded" errors', async ({ page }) => {
    const debug = Boolean(process.env.WI39552_DEBUG);
    const loops: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() !== 'error' || !LOOP_RE.test(msg.text())) return;
      const loc = msg.location();
      loops.push(`${loc.url}:${loc.lineNumber}:${loc.columnNumber}`);
    });
    page.on('pageerror', (err) => {
      if (!LOOP_RE.test(err.message)) return;
      if (debug) console.log(`[pageerror stack]\n${err.stack}\n---`);
      loops.push(`pageerror: ${err.message}`);
    });

    const sync = await stubApis(page);
    await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self&welcome=0`, {
      waitUntil: 'domcontentloaded',
    });
    const mounted = await page
      .getByRole('button', { name: 'Add panel' })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    assertMounted(mounted, SKIP_MSG);

    await page.getByRole('button', { name: 'Add panel' }).click();
    const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
    await expect(catalog).toBeVisible();
    await catalog.getByText('Work items', { exact: true }).first().click();

    const bar = page.locator('.pc-advpanel__filterbar').first();
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await sync.waitForServed(['workItems.byHarness']);

    // The burst spans ~4s after mount in the failing state; give it a settling
    // window so a slow loop cannot pass by finishing after the assertion.
    await page.waitForTimeout(5_000);

    if (debug && loops.length) console.log(`[loop sites]\n${loops.join('\n')}`);
    expect(
      loops.length,
      `React aborted ${loops.length} runaway update loop(s) on mount (WI-39552). ` +
        `Sites:\n${[...new Set(loops)].join('\n')}`,
    ).toBe(0);
  });
});
