/**
 * /adv Harnesses tab — the `?harness=` member axis (harnesses-tab-hive-model
 * Phase 1, P-005 e2e).
 *
 * Plan: harnesses-tab-hive-model-2026-06-07. The /adv shell selector owns
 * `?slug=` (the HIVE / root scope); the Harnesses tab adds an orthogonal
 * `?harness=` axis selecting which MEMBER harness of that hive is focused in
 * the dock. This spec drives the REAL selector + URL axes on the live default
 * path (`/adv?tab=harnesses&slug=…&harness=…`) — NOT a component story with
 * injected props (the EI-89 / D-007 bug class is "works under injected props,
 * mis-wired on the live default path").
 *
 * How the dock-keying is asserted HERMETICALLY: HarnessTopBar (and the dock
 * panels) fetch `/api/harness/<slug>/status` for whichever harness the dock is
 * keyed to. So intercepting those requests tells us exactly which member the
 * `?harness=` axis resolved to — without depending on per-harness substrate
 * content. A multi-member hive is stubbed via `/api/harness/projects/lite`
 * (root + parent_slug children), so the test does not need a real hive in the
 * workspace.
 *
 * NB: like the sibling adv-contributors-panel.spec.ts, this drives the
 * operator-vite SPA in the e2e Chromium project (the sanctioned browser-E2E
 * framework). The SPA only renders against an HMR-enabled Vite (or a
 * `vite preview` of the prebuilt bundle); a stale HMR-DISABLED :3055 serves a
 * blank `#root` (the desktop-static-host `/@vite/client` stub omits
 * `createHotContext`), so the dock never mounts and these `test.skip`. Run
 * against an HMR vite or `OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173`
 * (vite preview). The live WebKitGTK/Tauri-shell confirmation per D-007 is a
 * separate agent-driven run (tauri-agent-tools), recorded as plan evidence.
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

// A stubbed hive: a real root harness `e2e-hive` with two member harnesses
// (parent_slug → root), plus an unrelated solo harness. None need to exist in
// the live workspace — projects/lite is intercepted.
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
 * the dock fetches `/api/harness/<slug>/status` for. The returned Set is the
 * dock-keying oracle: a slug in it means the dock keyed to that harness.
 */
async function stubAndRecord(page: Page): Promise<Set<string>> {
  const statusSlugs = new Set<string>();
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECTS_LITE) });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    const m = /\/api\/harness\/([^/]+)\/status/.exec(route.request().url());
    if (m) statusSlugs.add(decodeURIComponent(m[1]));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }) });
  });
  // Keep the dock hermetic: lanes + health are per-slug too; stub them benign.
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) });
  });
  return statusSlugs;
}

/**
 * Navigate to the Harnesses tab for the given URL axes and report whether the
 * per-harness dock mounted (the toolbar "Add panel" affordance is visible).
 * Mirrors adv-contributors-panel.spec.ts — a blank HMR-disabled :3055 never
 * mounts it, and the caller skips rather than fails.
 */
async function gotoHarnessesTab(page: Page, search: string): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&${search}`, { waitUntil: 'domcontentloaded' });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

const SKIP_MSG =
  'The /adv shell did not mount the Harnesses dock. Run against an HMR-enabled Vite or a ' +
  'vite preview of the prebuilt bundle (OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173) — a stale ' +
  "HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

test.describe('/adv Harnesses tab — ?harness= member axis (P-005)', () => {
  test('deep link ?slug=hive&harness=member keys the dock to the MEMBER, not the hive root', async ({ page }) => {
    const statusSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&harness=${MEMBER_RD}`);
    test.skip(!mounted, SKIP_MSG);

    // The dock fetched the focused member's status — and NOT the hive root's
    // (the whole point of the new axis: a hive with members shows the picked
    // one, not the root dock).
    await expect.poll(() => statusSlugs.has(MEMBER_RD), { timeout: 15_000 }).toBe(true);
    expect(statusSlugs.has(HIVE)).toBe(false);
    // The deep link is preserved exactly (restore-exactly).
    expect(page.url()).toContain(`harness=${MEMBER_RD}`);
  });

  test('default (no ?harness=) keys the dock to the hive root (D-001)', async ({ page }) => {
    const statusSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`);
    test.skip(!mounted, SKIP_MSG);

    // Root is a real harness → it is the default focused member.
    await expect.poll(() => statusSlugs.has(HIVE), { timeout: 15_000 }).toBe(true);
    expect(statusSlugs.has(MEMBER_RD)).toBe(false);
    expect(statusSlugs.has(MEMBER_MKT)).toBe(false);
  });

  test('a stale ?harness= (names no member) is ignored, falls back to the root, and is cleared from the URL', async ({ page }) => {
    const statusSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&harness=from-a-different-hive`);
    test.skip(!mounted, SKIP_MSG);

    // Ignored → root default.
    await expect.poll(() => statusSlugs.has(HIVE), { timeout: 15_000 }).toBe(true);
    // And the stale value is dropped from the URL (isHarnessParamStale → setHarness(null)).
    await expect.poll(() => new URL(page.url()).searchParams.get('harness'), { timeout: 10_000 }).toBeNull();
  });

  test('a solo harness keys the dock to its own slug (zero regression)', async ({ page }) => {
    const statusSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${SOLO}`);
    test.skip(!mounted, SKIP_MSG);

    await expect.poll(() => statusSlugs.has(SOLO), { timeout: 15_000 }).toBe(true);
  });

  // ── Partner-owned UI (P-002 member rail, P-003 all-mode cards) ────────────
  // These drive the selector→rail→dock flow end-to-end. They are implemented
  // once su-c3ac8 lands HiveMemberRail/HiveWorkspaceCards + confirms the
  // testid contract (hive-member-rail / hive-member-<slug> / hive-card-<root>).
  // Kept as fixme so the contract is visible + the run is one command away.
  test.fixme('clicking a member in the rail sets ?harness= and re-keys the dock (P-002)', async ({ page }) => {
    const statusSlugs = await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`);
    test.skip(!mounted, SKIP_MSG);
    await page.getByTestId(`hive-member-${MEMBER_MKT}`).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('harness')).toBe(MEMBER_MKT);
    await expect.poll(() => statusSlugs.has(MEMBER_MKT)).toBe(true);
  });

  test.fixme('all-mode: clicking a member card sets both ?slug= and ?harness= (P-003)', async ({ page }) => {
    await stubAndRecord(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}&scope=all`);
    test.skip(!mounted, SKIP_MSG);
    await page.getByTestId(`hive-card-${HIVE}`).getByTestId(`hive-member-${MEMBER_RD}`).click();
    await expect.poll(() => {
      const u = new URL(page.url());
      return `${u.searchParams.get('slug')}:${u.searchParams.get('harness')}:${u.searchParams.get('scope')}`;
    }).toBe(`${HIVE}:${MEMBER_RD}:expanded`);
  });
});
