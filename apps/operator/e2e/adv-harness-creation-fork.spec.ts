/**
 * /adv Harnesses tab — the creation fork (harnesses-tab-hive-model Phase 2,
 * P-010 + P-011 e2e). Drives the REAL "New" → CreateHarnessPicker fork on the
 * live default path (`/adv?tab=harnesses&slug=<hive>`), NOT a component story
 * with injected props (the EI-89 / D-007 bug class is "works under injected
 * props, mis-wired on the live default path").
 *
 * Covers:
 *   P-010  the three-mode creation fork (👑 New <hive> · Add to <hive> ·
 *          Standalone), defaulting to into-hive when a hive scope is selected.
 *   P-011  add-into-hive threads `hive` to POST /api/harness/projects (the
 *          membership edge) and lands the new member FOCUSED in the rail
 *          (`?harness=<new>` + the rail's aria-current).
 *
 * Hermetic: stubs `/api/harness/projects/lite` (a real root + parent_slug
 * children) and the create POST (asserting the membership edge), so it needs
 * no real hive in the workspace and never writes anything. Companion to
 * adv-harness-member-axis.spec.ts (Phase 1, P-001/P-002/P-003).
 *
 * NB (same as the Phase-1 spec): the operator-vite SPA only renders against a
 * BUILT bundle (staging-served dist on :3170, or a vite preview) — a stale
 * HMR-disabled :3055 serves a blank #root, so these `test.skip`. The WebKitGTK/
 * Tauri-shell confirmation per D-007 is a separate agent-driven run (isolated
 * Xvfb), recorded as plan evidence.
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

const HIVE = 'e2e-hive';
const MEMBER_RD = 'e2e-hive-rd';
const NEW_MEMBER = 'e2e-hive-new';

/** projects/lite stub: a real root + an existing member + the to-be-created
 *  member (so the rail can render it focused once the create lands). */
const PROJECTS_LITE = {
  projects: [
    { slug: HIVE, path: `/tmp/${HIVE}`, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false },
    { slug: MEMBER_RD, path: `/tmp/${MEMBER_RD}`, hasState: true, hasSpec: false, parent_slug: HIVE, harness_kind: 'coding', is_shared: false },
    { slug: NEW_MEMBER, path: `/tmp/${NEW_MEMBER}`, hasState: true, hasSpec: false, parent_slug: HIVE, harness_kind: 'coding', is_shared: false },
  ],
};

interface CreateCapture {
  bodies: Array<Record<string, unknown>>;
}

/**
 * Stub projects/lite + the benign dock fetches, and CAPTURE the create POST
 * bodies (the P-011 membership-edge oracle). The create is stubbed to succeed
 * with NEW_MEMBER, so onCreated fires without touching disk.
 */
async function stubAndCapture(page: Page): Promise<CreateCapture> {
  const cap: CreateCapture = { bodies: [] };
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECTS_LITE) });
  });
  // The into-hive / standalone create — capture the body (asserts `hive`), succeed.
  await page.route('**/api/harness/projects', async (route) => {
    if (route.request().method() === 'POST') {
      cap.bodies.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, project: { slug: NEW_MEMBER, path: `/tmp/${NEW_MEMBER}` } }),
      });
      return;
    }
    await route.continue();
  });
  // The new-hive create (separate endpoint) — capture + succeed.
  await page.route('**/api/harness/hives', async (route) => {
    if (route.request().method() === 'POST') {
      cap.bodies.push({ __hivesEndpoint: true, ...JSON.parse(route.request().postData() ?? '{}') });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, project: { slug: 'e2e-new-hive' } }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }) });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) });
  });
  return cap;
}

const DOCK_MOUNT = { role: 'button', name: 'Add panel' } as const;
const SKIP_MSG =
  'The /adv shell did not mount the Harnesses tab. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist on :3170 via OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170, or a vite preview) — ' +
  "a stale HMR-disabled :3055 serves a blank #root.";

async function gotoHarnessesTab(page: Page, search: string): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&${search}`, { waitUntil: 'domcontentloaded' });
  return page
    .getByRole(DOCK_MOUNT.role, { name: DOCK_MOUNT.name })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Open the create picker. EI-319: the bottom-right "New harness" FAB this spec
 * originally drove was REMOVED (HarnessesWorkspace: "the bottom-right 'New
 * harness' FAB is removed — deprecated"); the live opener is the shell
 * header's "New" button (title 'Create or add a new harness') — the same
 * opener adv-hive-from-github-url.spec.ts drives. Returns the fork tablist.
 */
async function openPicker(page: Page) {
  await page.getByTitle('Create or add a new harness').click();
  const fork = page.getByRole('tablist', { name: 'Creation mode' });
  await expect(fork).toBeVisible({ timeout: 10_000 });
  return fork;
}

test.describe('/adv Harnesses tab — creation fork (P-010/P-011)', () => {
  test('P-010 New on a hive scope opens the fork with all three modes, into-hive default-selected', async ({ page }) => {
    await stubAndCapture(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`);
    test.skip(!mounted, SKIP_MSG);

    const fork = await openPicker(page);
    // All three modes present on the LIVE default path (not injected props).
    await expect(fork.getByRole('tab', { name: `Add to ${HIVE}` })).toBeVisible();
    await expect(fork.getByRole('tab', { name: 'Standalone' })).toBeVisible();
    await expect(fork.getByRole('tab', { name: /New/ })).toBeVisible(); // 👑 New <hive/pot>
    // Default when a hive scope is selected: into-hive (D-005 — the common case).
    await expect(fork.getByRole('tab', { name: `Add to ${HIVE}` })).toHaveAttribute('aria-selected', 'true');
  });

  test('P-010 toggling to Standalone flips the selected mode', async ({ page }) => {
    await stubAndCapture(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`);
    test.skip(!mounted, SKIP_MSG);

    const fork = await openPicker(page);
    await fork.getByRole('tab', { name: 'Standalone' }).click();
    await expect(fork.getByRole('tab', { name: 'Standalone' })).toHaveAttribute('aria-selected', 'true');
    await expect(fork.getByRole('tab', { name: `Add to ${HIVE}` })).toHaveAttribute('aria-selected', 'false');
  });

  test('P-011 add-into-hive threads the membership edge and lands the new member focused', async ({ page }) => {
    const cap = await stubAndCapture(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`);
    test.skip(!mounted, SKIP_MSG);

    await openPicker(page); // into-hive default (hive scope selected)
    // Pick the "New local directory" entry → NewLocalForm.
    await page.getByRole('button', { name: /New local directory/i }).click();
    await page.getByPlaceholder('my-project').first().fill(NEW_MEMBER); // slug
    await page.getByPlaceholder('/home/user/projects').fill('/tmp');     // parentDir
    await page.getByPlaceholder('my-project').nth(1).fill(NEW_MEMBER);   // folderName
    await page.getByRole('button', { name: 'Create harness' }).click();

    // P-011a: the create carried the membership edge to the selected hive.
    await expect.poll(() => cap.bodies.find((b) => !b.__hivesEndpoint)?.hive, { timeout: 10_000 }).toBe(HIVE);
    // P-011b: the new member lands FOCUSED in the rail (?harness=<new> + aria-current),
    // with ?slug= still the hive (handleCreated: into-hive → setHarness(new)).
    await expect.poll(() => new URL(page.url()).searchParams.get('harness'), { timeout: 10_000 }).toBe(NEW_MEMBER);
    await expect(page.getByTestId(`hive-member-${NEW_MEMBER}`)).toHaveAttribute('aria-current', 'true', { timeout: 15_000 });
  });
});
