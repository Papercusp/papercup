/**
 * /adv Harnesses tab — the hive member model (harnesses-tab-hive-model
 * Phase 1, P-005 e2e). Drives the REAL selector + URL axes + member rail on
 * the live default path (`/adv?tab=harnesses&slug=…&harness=…`) — NOT a
 * component story with injected props (the EI-89 / D-007 bug class is "works
 * under injected props, mis-wired on the live default path").
 *
 * Covers the whole Phase-1 surface end-to-end:
 *   P-001  `?harness=` member axis + dock keyed by the focused member
 *   P-002  the member rail (in-tab selection → `?harness=`)
 *   P-003  all-mode (`?scope=all`) hive-grouped cards + drill-in
 *
 * Two independent oracles, each race-free:
 *   - the member RAIL's `aria-current` (= the resolved `dockSlug`, which is
 *     ALSO the slug the dock + HarnessTopBar render) — the faithful "which
 *     member is focused" signal, free of the projects/lite loading transient
 *     (before projects load, dockSlug briefly falls back to the hive root;
 *     the rail settles on the resolved member once loaded).
 *   - the `/api/harness/<slug>/lanes` fetch, which on the Harnesses tab only
 *     HarnessTopBar (the dock) issues, keyed to `dockSlug` — a positive
 *     "the dock actually fetched for this member" signal. (NB: `/status` is
 *     NOT dock-specific — the shell header AdvNowRunning fetches the hive
 *     root's `/status` for `?slug=`, so it can't distinguish dock-keying.)
 *
 * A multi-member hive is stubbed via `/api/harness/projects/lite` (a real
 * root + parent_slug children), so the test needs no real hive in the
 * workspace.
 *
 * NB: like adv-contributors-panel.spec.ts this drives the operator-vite SPA in
 * the e2e Chromium project. The SPA only renders against a BUILT bundle (vite
 * preview / the staging-served dist) or an HMR-enabled Vite — a stale
 * HMR-DISABLED :3055 serves a blank `#root` ('/@vite/client' createHotContext
 * stub), so the tab never mounts and these `test.skip`. The WebKitGTK/Tauri
 * shell confirmation per D-007 is a separate agent-driven run (tauri-agent-
 * tools, isolated Xvfb), recorded as plan evidence.
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// A stubbed hive: a real root harness `e2e-hive` with two member harnesses
// (parent_slug → root), plus an unrelated solo harness.
const HIVE = 'e2e-hive';
const MEMBER_RD = 'e2e-hive-rd';
const MEMBER_MKT = 'e2e-hive-mkt';
const SOLO = 'e2e-solo';

const PROJECTS_LITE = {
  projects: [
    { slug: HIVE, path: `/tmp/${HIVE}`, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false },
    { slug: MEMBER_RD, path: `/tmp/${MEMBER_RD}`, hasState: true, hasSpec: false, parent_slug: HIVE, harness_kind: 'coding', is_shared: false },
    { slug: MEMBER_MKT, path: `/tmp/${MEMBER_MKT}`, hasState: true, hasSpec: false, parent_slug: HIVE, harness_kind: 'coding', is_shared: true },
    { slug: SOLO, path: `/tmp/${SOLO}`, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false },
  ],
};

/**
 * Stub projects/lite (the hive grouping source) + record which harness slugs
 * the dock fetches `/api/harness/<slug>/lanes` for (the dock-keying oracle).
 * Status + agents are stubbed benign so the shell header + dock are hermetic.
 */
async function stubAndRecord(page: Page): Promise<Set<string>> {
  const lanesSlugs = new Set<string>();
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECTS_LITE) });
  });
  // HarnessesWorkspace reads the projects list via useSyncQuery('harnessProjects.lite')
  // (REST→sync migration 2026-06-11), NOT the legacy REST route above — its rows
  // come through the sync batch fetcher (POST /api/zero-harness/rest-query-batch →
  // {results:[{rows,version}]}, one result per {name,args} query, in order). Stub
  // it or the member rail renders empty and every hive-member-* testid is absent
  // (EI-319 residual). SSE carries only invalidation; rows come from this endpoint.
  await page.route('**/api/zero-harness/rest-query-batch**', async (route) => {
    let queries: Array<{ name?: string }> = [];
    try { queries = (JSON.parse(route.request().postData() ?? '{}').queries ?? []) as Array<{ name?: string }>; } catch { /* empty batch */ }
    const results = queries.map((q) =>
      q?.name === 'harnessProjects.lite'
        ? { rows: PROJECTS_LITE.projects, version: '1' }
        : { rows: [], version: '1' },
    );
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    const m = /\/api\/harness\/([^/]+)\/lanes/.exec(route.request().url());
    if (m) lanesSlugs.add(decodeURIComponent(m[1]));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }) });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) });
  });
  return lanesSlugs;
}

/**
 * Navigate to the Harnesses tab and report whether the expected surface
 * mounted (`mount` selector). A blank HMR-disabled :3055 never mounts it, so
 * the caller skips rather than fails (mirrors adv-contributors-panel.spec.ts).
 */
async function gotoHarnessesTab(page: Page, search: string, mount: { role: 'button'; name: string } | { testId: string }): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&${search}`, { waitUntil: 'domcontentloaded' });
  const target = 'testId' in mount ? page.getByTestId(mount.testId) : page.getByRole(mount.role, { name: mount.name });
  return target
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

const DOCK_MOUNT = { role: 'button', name: 'Add panel' } as const;
const SKIP_MSG =
  'The /adv shell did not mount the Harnesses tab. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist on :3170, or a vite preview OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173) — ' +
  "a stale HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

/** Assert the rail marks exactly `slug` as the focused member. */
async function expectRailActive(page: Page, slug: string, notSlug: string) {
  await expect(page.getByTestId(`hive-member-${slug}`)).toHaveAttribute('aria-current', 'true', { timeout: 15_000 });
  await expect(page.getByTestId(`hive-member-${notSlug}`)).not.toHaveAttribute('aria-current', 'true');
}

test.describe('/adv Harnesses tab — hive member model (P-001/P-002/P-003)', () => {
  test('P-001 deep link ?slug=hive&harness=member focuses the MEMBER, not the hive root', async ({ page }) => {
    const lanesSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&harness=${MEMBER_RD}`, DOCK_MOUNT);
    test.skip(!mounted, SKIP_MSG);

    // The deep link is restored exactly, the rail marks the member focused
    // (not the root), and the dock actually fetched for the member.
    expect(page.url()).toContain(`harness=${MEMBER_RD}`);
    await expectRailActive(page, MEMBER_RD, HIVE);
    await expect.poll(() => lanesSlugs.has(MEMBER_RD), { timeout: 15_000 }).toBe(true);
  });

  test('P-001 default (no ?harness=) focuses the hive root (D-001)', async ({ page }) => {
    const lanesSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, DOCK_MOUNT);
    test.skip(!mounted, SKIP_MSG);

    // Root is a real harness → it is the default focused member.
    await expectRailActive(page, HIVE, MEMBER_RD);
    await expect.poll(() => lanesSlugs.has(HIVE), { timeout: 15_000 }).toBe(true);
  });

  test('P-001 a stale ?harness= (names no member) falls back to the root and is cleared from the URL', async ({ page }) => {
    await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&harness=from-a-different-hive`, DOCK_MOUNT);
    test.skip(!mounted, SKIP_MSG);

    // Ignored → root default, and the stale value is dropped from the URL
    // (isHarnessParamStale → setHarness(null)).
    await expectRailActive(page, HIVE, MEMBER_RD);
    await expect.poll(() => new URL(page.url()).searchParams.get('harness'), { timeout: 10_000 }).toBeNull();
  });

  test('P-001 a solo harness has no rail and keys the dock to its own slug (zero regression)', async ({ page }) => {
    const lanesSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${SOLO}`, DOCK_MOUNT);
    test.skip(!mounted, SKIP_MSG);

    // A single-member hive renders no rail (nothing to pick) — the dock is
    // byte-identical to the pre-plan single-harness view.
    await expect(page.getByTestId('hive-member-rail')).toHaveCount(0);
    await expect.poll(() => lanesSlugs.has(SOLO), { timeout: 15_000 }).toBe(true);
  });

  test('P-002 clicking a member in the rail sets ?harness= and re-keys the dock', async ({ page }) => {
    const lanesSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, DOCK_MOUNT);
    test.skip(!mounted, SKIP_MSG);

    // Starts on the root (default); click the marketing member in the rail.
    await expectRailActive(page, HIVE, MEMBER_MKT);
    await page.getByTestId(`hive-member-${MEMBER_MKT}`).click();

    await expect.poll(() => new URL(page.url()).searchParams.get('harness'), { timeout: 10_000 }).toBe(MEMBER_MKT);
    await expectRailActive(page, MEMBER_MKT, HIVE);
    await expect.poll(() => lanesSlugs.has(MEMBER_MKT), { timeout: 15_000 }).toBe(true);
  });

  test('P-003 all-mode: clicking a member card drills in, setting both ?slug= and ?harness= and exiting all-mode', async ({ page }) => {
    await stubAndRecord(page);
    // All-mode renders the hive-grouped cards (no dock / no "Add panel"), so
    // the mount oracle is the cards container.
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&scope=all`, { testId: 'hive-workspace-cards' });
    test.skip(!mounted, SKIP_MSG);

    // Drill into the R&D member of the e2e-hive card.
    await page.getByTestId(`hive-card-${HIVE}`).getByTestId(`hive-member-${MEMBER_RD}`).click();

    await expect
      .poll(
        () => {
          const u = new URL(page.url());
          return `${u.searchParams.get('slug')}:${u.searchParams.get('harness')}:${u.searchParams.get('scope') ?? 'expanded'}`;
        },
        { timeout: 10_000 },
      )
      .toBe(`${HIVE}:${MEMBER_RD}:expanded`);
  });
});
