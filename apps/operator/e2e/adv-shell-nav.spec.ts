/**
 * /adv shell tab navigation (P-011, app-wide-test-coverage-2026-06-05).
 *
 * The /adv operator shell is one TanStack route whose sections are pure
 * `?tab=` nuqs state (operator-vite routes/adv/index.tsx + AdvShell.tsx).
 * Existing adv specs cover individual panels (contributors, member axis,
 * creation fork); NONE covered the top-level navigation contract itself.
 * This spec drives it end-to-end:
 *
 *   1. every primary tab in the strip (the 12 ADV_TABS) deep-links via
 *      `?tab=<id>` and renders without the route error boundary
 *      ("This view hit an error", RouteErrorBoundary.tsx) and without app
 *      console errors,
 *   2. clicking a tab writes `?tab=` to the URL (the nuqs contract: agents
 *      read/write the URL, users deep-link it),
 *   3. URL round-trip — a reload and a direct goto of the deep URL land on
 *      the same tab,
 *   4. scope coupling — under `?scope=all` ("All Pots") the strip collapses
 *      to the workspace-level subset and a per-pot deep link snaps back to
 *      Overview instead of stranding on a hidden tab (AdvShell's
 *      WORKSPACE_TAB_IDS + snap-back effect).
 *
 * Hermetic where it matters: `/api/harness/projects/lite` is stubbed (like
 * adv-harness-member-axis.spec.ts) so the slug in the URL is always a valid
 * project regardless of workspace contents — otherwise AdvShell's persisted-
 * selection restore would flip a fresh browser context into all-mode and
 * hide the per-pot tabs. Status/lanes/agents are stubbed benign; the rest of
 * the tab content fetches hit the live proxy and may 401/404 for the
 * fictional slug, which the console scrub treats as environment noise.
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA in the
 * e2e Chromium project. A stale HMR-disabled :3055 serves a blank `#root`
 * ('/@vite/client' createHotContext stub) — the shell never mounts and these
 * tests skip rather than fail (the config's own webServer boots an
 * HMR-enabled Vite, where everything renders).
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// Fictional slug — valid because projects/lite is stubbed, hermetic because
// no real workspace harness is touched.
const SLUG = 'e2e-nav-pot';

const PROJECTS_LITE = {
  projects: [
    {
      slug: SLUG,
      path: `/tmp/${SLUG}`,
      hasState: true,
      hasSpec: true,
      parent_slug: null,
      harness_kind: 'project',
      is_shared: false,
    },
  ],
};

/**
 * The primary tab set, mirroring ADV_TABS in
 * apps/operator-vite/src/components/adv/AdvShell.tsx (strip order). `label`
 * is both the trigger's accessible name (rendered lowercase) and the shell
 * `<h1>` title (getAdvTitle in routes/adv/index.tsx). The strip-contents
 * test below fails if this list drifts from the real ADV_TABS.
 */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'plans', label: 'Create' },
  // Label renamed Harnesses → Progress (owner ask, 2026-06-10); the tab ID
  // stays 'harnesses' — it's URL-serialized (?tab=harnesses deep links).
  { id: 'harnesses', label: 'Progress' },
  { id: 'frames', label: 'Frames' },
  { id: 'git', label: 'Git' },
  { id: 'testing', label: 'Tests' },
  { id: 'docs', label: 'Docs' },
  { id: 'insights', label: 'Insights' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'learning', label: 'Learning' },
  { id: 'settings', label: 'Settings' },
] as const;

/** Workspace-level tabs that stay visible under ?scope=all (WORKSPACE_TAB_IDS). */
const WORKSPACE_TABS = ['overview', 'plans', 'harnesses', 'conversations', 'learning', 'frames'];

const SKIP_MSG =
  'The /adv shell did not mount the tab strip. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist, or a vite preview OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173) — ' +
  "a stale HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

/**
 * Stub the shell's own data dependencies so navigation is hermetic:
 * projects/lite validates the URL slug (and keeps the persisted-selection
 * restore from flipping to all-mode); status/lanes/agents keep the header
 * widgets + Harnesses dock benign. Tab CONTENT fetches stay live on purpose
 * — a tab that crashes on real (empty) data is exactly what test 1 hunts.
 */
async function stubShellApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECTS_LITE),
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
}

/**
 * Console-error scrub (home.spec.ts pattern, widened for this suite's
 * fictional slug). Ignored as ENVIRONMENT noise, not app bugs:
 *   - third-party / hydration / favicon chatter,
 *   - failed resource loads — slug-scoped + authed fetches 401/403/404
 *     against the live proxy for a stubbed slug in a raw e2e browser.
 * Everything else (uncaught exceptions, React render errors, the
 * RouteErrorBoundary's own console.error) stays flagged.
 */
function scrubConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
      !/Failed to load resource/i.test(e) &&
      !/\b(401|403|404)\b.*(Unauthorized|Forbidden|Not Found)/i.test(e),
  );
}

/** Attach BEFORE goto so boot-time errors are captured too. */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

/**
 * Navigate to /adv with the given search and report whether the shell's tab
 * strip mounted. A blank HMR-disabled :3055 never mounts it, so the caller
 * skips rather than fails (mirrors the sibling adv specs).
 */
async function gotoAdv(page: Page, search: string): Promise<boolean> {
  const res = await page.goto(`${baseURL}/adv${search}`, { waitUntil: 'domcontentloaded' });
  // The SPA shell itself must serve (any tab — content is client-rendered).
  expect([200, 304]).toContain(res?.status() ?? 0);
  return page
    .getByRole('tablist', { name: 'Adv sections' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/** The shell header's title — flips with the active tab (getAdvTitle). */
function shellTitle(page: Page) {
  return page.locator('.pc-advshell__copy h1');
}

/**
 * No error boundary latched: neither the Outlet-level RouteErrorBoundary
 * fallback nor TanStack's bare root "Something went wrong" boundary.
 */
async function expectNoErrorBoundary(page: Page) {
  await expect(page.getByRole('alert').filter({ hasText: 'This view hit an error' })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

function tabParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('tab');
}

test.describe('/adv shell tab navigation (P-011)', () => {
  test('the strip renders exactly the primary tab set, in order', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    // toHaveText with an array asserts count AND order — drift between this
    // spec's TABS and the real ADV_TABS fails here, not via a silent no-op
    // getByRole miss in the per-tab tests.
    await expect(
      page.getByRole('tablist', { name: 'Adv sections' }).getByRole('tab'),
    ).toHaveText(TABS.map((t) => t.label.toLowerCase()));
  });

  for (const tab of TABS) {
    test(`deep link ?tab=${tab.id} lands on ${tab.label} and renders clean`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page);
      await stubShellApis(page);
      const mounted = await gotoAdv(page, `?tab=${tab.id}&slug=${SLUG}&scope=expanded`);
      test.skip(!mounted, SKIP_MSG);

      // Landed on the tab: the shell title + the selected trigger agree.
      await expect(shellTitle(page)).toHaveText(tab.label);
      await expect(
        page.getByRole('tab', { name: tab.label.toLowerCase(), exact: true }),
      ).toHaveAttribute('aria-selected', 'true');

      // The nuqs param survived mount — nothing rewrote/dropped it. The
      // default tab is the one exception: nuqs clearOnDefault may strip
      // `tab=overview`, which is equivalent state, so both spellings pass.
      if (tab.id === 'overview') {
        expect([tab.id, null]).toContain(tabParam(page));
      } else {
        expect(tabParam(page)).toBe(tab.id);
      }

      await expectNoErrorBoundary(page);
      expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
    });
  }

  test('clicking tabs writes ?tab= (nuqs) and the state survives reload', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    // No ?tab= → the default landing surface (Overview).
    await expect(shellTitle(page)).toHaveText('Overview');

    // Click → URL reflects the selection (the agent/deep-link contract).
    await page.getByRole('tab', { name: 'git', exact: true }).click();
    await expect.poll(() => tabParam(page), { timeout: 10_000 }).toBe('git');
    await expect(shellTitle(page)).toHaveText('Git');

    await page.getByRole('tab', { name: 'docs', exact: true }).click();
    await expect.poll(() => tabParam(page), { timeout: 10_000 }).toBe('docs');
    await expect(shellTitle(page)).toHaveText('Docs');

    // Reload → the nuqs state round-trips (URL is the store, not useState).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(shellTitle(page)).toHaveText('Docs');
    await expect(page.getByRole('tab', { name: 'docs', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Back to the default tab: nuqs clearOnDefault drops the param (or
    // writes the default literally — both encode "overview").
    await page.getByRole('tab', { name: 'overview', exact: true }).click();
    await expect(shellTitle(page)).toHaveText('Overview');
    await expect
      .poll(() => {
        const v = tabParam(page);
        return v === null || v === 'overview';
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test('?scope=all collapses the strip to workspace-level tabs and snaps a per-pot deep link to Overview', async ({ page }) => {
    await stubShellApis(page);
    // Git is a per-pot tab — invisible under "All Pots". The shell's
    // snap-back effect must land on Overview, not strand on a hidden tab.
    const mounted = await gotoAdv(page, `?tab=git&slug=${SLUG}&scope=all`);
    test.skip(!mounted, SKIP_MSG);

    await expect(shellTitle(page)).toHaveText('Overview');
    await expect
      .poll(() => {
        const v = tabParam(page);
        return v === null || v === 'overview';
      }, { timeout: 10_000 })
      .toBe(true);

    // The strip shows exactly the workspace-level subset (ADV_TABS order).
    const expected = TABS.filter((t) => WORKSPACE_TABS.includes(t.id));
    await expect(
      page.getByRole('tablist', { name: 'Adv sections' }).getByRole('tab'),
    ).toHaveText(expected.map((t) => t.label.toLowerCase()));
    await expect(page.getByRole('tab', { name: 'git', exact: true })).toHaveCount(0);
  });
});
