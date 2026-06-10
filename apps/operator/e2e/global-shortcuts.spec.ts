/**
 * Global keyboard shortcuts (P-004 e2e remainder, app-wide-test-coverage-2026-06-05).
 *
 * The shortcut stack is: one window-level dispatcher mounted once at the SPA
 * root (GlobalShortcutDispatcher → shortcut-bus) + a registry of combos
 * (shortcut-registry) + thin root components wiring actions to effects
 * (GlobalShortcutsHelp → `?shortcuts=` nuqs state; GlobalAppShortcuts →
 * router.push; GlobalNavShortcuts → window.history). The bus/match/registry
 * have unit suites (shortcut-bus.test.ts, shortcut-match.test.ts,
 * shortcut-registry.test.ts) — what NOTHING covered is the real-browser
 * integration: an actual keydown reaching the mounted dispatcher and
 * producing the router/nuqs effect. This spec drives exactly that, on the
 * /adv shell:
 *
 *   1. Mod+/ toggles the cheat sheet open AND writes `?shortcuts=true`
 *      (nuqs — deep-linkable, agent-readable); same combo toggles it closed.
 *   2. `?` (shift+slash) is the classic alternate.
 *   3. `?shortcuts=true` deep-links straight into the open sheet (nuqs
 *      round-trip).
 *   4. A literal '?' typed in a text input is NOT swallowed: the
 *      form-tag guard skips the handler AND — because `shortcuts.show` is
 *      category 'global', not 'palette' — the dispatcher must not
 *      preventDefault the skipped combo (the registry comment documents this
 *      exact trap), so the character lands in the input.
 *   5. Mod+, router-pushes /settings; Alt+ArrowLeft (a dead key in the Tauri
 *      webview, deliberately bound to history) goes back to /adv;
 *      Alt+ArrowRight returns to /settings.
 *   6. Mod+I lands on the Conversations tab (on /adv the AdvShell in-place
 *      handler wins over the root fallback — most-recently-registered —
 *      flipping `?tab=` instead of a full navigation; the URL contract is
 *      the same either way).
 *
 * Hermetic shell stubs + the mounted-or-skip guard mirror
 * adv-shell-nav.spec.ts (a stale HMR-disabled :3055 serves a blank #root —
 * skip, don't fail; the config's own webServer boots an HMR-enabled Vite).
 */
import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

const SLUG = 'e2e-shortcuts-pot';

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

const SKIP_MSG =
  'The /adv shell did not mount. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist, or vite preview OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173) — ' +
  "a stale HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

async function stubShellApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECTS_LITE) });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }),
    });
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) });
  });
}

async function gotoAdv(page: Page, search: string): Promise<boolean> {
  const res = await page.goto(`${baseURL}/adv${search}`, { waitUntil: 'domcontentloaded' });
  expect([200, 304]).toContain(res?.status() ?? 0);
  return page
    .getByRole('tablist', { name: 'Adv sections' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/** The Radix cheat-sheet dialog (ShortcutsCheatSheet aria-label). */
function cheatSheet(page: Page) {
  return page.getByRole('dialog', { name: 'Keyboard shortcuts' });
}

function shortcutsParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('shortcuts');
}

test.describe('global keyboard shortcuts (dispatcher → router/nuqs effects)', () => {
  test('Mod+/ toggles the cheat sheet and round-trips ?shortcuts= through nuqs', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    await expect(cheatSheet(page)).toBeHidden();

    await page.keyboard.press('Control+/');
    await expect(cheatSheet(page)).toBeVisible();
    // nuqs contract: open-state is URL state (deep-linkable, agent-readable).
    await expect.poll(() => shortcutsParam(page)).toBe('true');

    // Same combo toggles it closed (GlobalShortcutsHelp's setOpen(!open)) and
    // the default-false value leaves the URL.
    await page.keyboard.press('Control+/');
    await expect(cheatSheet(page)).toBeHidden();
    await expect.poll(() => shortcutsParam(page)).toBe(null);
  });

  test("the classic '?' (shift+slash) alternate opens the sheet", async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    await page.keyboard.press('Shift+/');
    await expect(cheatSheet(page)).toBeVisible();
  });

  test('?shortcuts=true deep-links straight into the open sheet', async ({ page }) => {
    await stubShellApis(page);
    // Can't reuse gotoAdv's tablist guard here: the deep-linked Radix modal
    // is open ON LOAD and aria-hides everything outside itself, so the
    // tab strip is invisible to role queries while the sheet shows. The
    // dialog appearing is itself proof the shell mounted; only a blank
    // #root (stale HMR-disabled :3055) skips.
    const res = await page.goto(`${baseURL}/adv?slug=${SLUG}&scope=expanded&shortcuts=true`, {
      waitUntil: 'domcontentloaded',
    });
    expect([200, 304]).toContain(res?.status() ?? 0);
    const sheetMounted = await cheatSheet(page)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!sheetMounted && !(await page.locator('#root *').first().isVisible().catch(() => false)), SKIP_MSG);

    await expect(cheatSheet(page)).toBeVisible();
  });

  test("a literal '?' typed into a text input is neither swallowed nor a shortcut", async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    // A bare probe input in the live DOM: what's under test is the mounted
    // dispatcher's form-tag gating, not any particular form.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'e2e-shortcut-probe';
      input.type = 'text';
      document.body.appendChild(input);
      input.focus();
    });

    await page.keyboard.type('?');

    // The form-tag guard skipped the handler — no sheet, no URL state —
    // and category 'global' means the dispatcher must NOT preventDefault a
    // skipped combo, so the character reached the input.
    await expect(page.locator('#e2e-shortcut-probe')).toHaveValue('?');
    await expect(cheatSheet(page)).toBeHidden();
    expect(shortcutsParam(page)).toBe(null);
  });

  test('Mod+, opens /settings; Alt+Arrows traverse history (the dead-key binding)', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    await page.keyboard.press('Control+,');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');

    // Alt+Left/Right are dead keys in the Tauri webview; GlobalNavShortcuts
    // binds them to window.history so back/forward work on every route.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/adv');

    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
  });

  test('Mod+I lands on the Conversations tab (in-place AdvShell handler wins on /adv)', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    test.skip(!mounted, SKIP_MSG);

    await page.keyboard.press('Control+i');
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('conversations');
    await expect(page.locator('.pc-advshell__copy h1')).toHaveText('Conversations');
  });
});
