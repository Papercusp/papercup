/**
 * /settings/agent auto-save — layer-2 form flow (the settings-pages.spec.ts
 * smoke only asserts render).
 *
 * Regression suite for the 2026-06-11 owner bugs:
 *   1. WIPE-ON-RELOAD — an invalid/incomplete tier edit used to be EXCLUDED
 *      from the auto-saved body, silently deleting the row from the store;
 *      reload re-hydrated the gutted config. Invalid sections now HOLD their
 *      last saved value (assemble-config.ts) and the strict POST rejects
 *      lossy bodies (422).
 *   2. MID-TYPING WENT LIVE — every keystroke persisted after the debounce.
 *      Text fields are now DraftInput: commit on blur/Enter, after validation.
 *
 * STATEFUL: this spec edits the real agent config of the stack under test,
 * so it captures the stored config up front and restores it in afterAll
 * (empty values restore the host's boot env — EI-337). Tests run SERIAL —
 * each step builds on the previous stored state.
 *
 * Sibling-pattern notes (harness-settings-flow.spec.ts): baseURL mirrors
 * playwright.config.ts; tests SKIP rather than fail when the SPA serves a
 * blank #root (stale HMR-disabled :3055).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

const SKIP_MSG_BLANK =
  '/settings/agent did not mount. Run against an HMR-enabled operator-vite ' +
  '(the playwright.config webServer) — a stale HMR-disabled :3055 serves a blank #root.';

// Debounce in page.tsx is 600ms — anything still unsaved after this window
// was (correctly) never scheduled.
const SAVE_WINDOW_MS = 1200;

const SPEC_INPUT = 'input[aria-label="Tier 4 model spec"]';

let originalConfig: Record<string, unknown> | null = null;

async function getStoredConfig(request: APIRequestContext) {
  const r = await request.get(`${baseURL}/api/agent-config`, { timeout: 15_000 });
  return ((await r.json()) as { config: Record<string, unknown> }).config;
}

async function openPage(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/settings/agent`, { waitUntil: 'load', timeout: 30_000 });
  return page
    .locator('h1', { hasText: 'AI backend' })
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Fill the tier-4 model spec and blur it (blur = the commit trigger). */
async function editSpecAndBlur(page: Page, value: string) {
  const input = page.locator(SPEC_INPUT);
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(value);
  await input.blur();
}

test.describe.configure({ mode: 'serial' });

test.describe('/settings/agent auto-save validation', () => {
  test.beforeAll(async ({ request }) => {
    originalConfig = await getStoredConfig(request).catch(() => null);
    test.skip(originalConfig == null, 'agent-config API unreachable');
    // Known baseline for the tier flow: default menu, no ceilings. Everything
    // else (backend/cmd/models/surfaces) keeps the stack's real values.
    await request.post(`${baseURL}/api/agent-config`, {
      data: { ...originalConfig, tiers: [], tierCeilings: {} },
      headers: { 'Content-Type': 'application/json' },
    });
  });

  test.afterAll(async ({ request }) => {
    if (!originalConfig) return;
    await request.post(`${baseURL}/api/agent-config`, {
      data: originalConfig,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  test('mid-typing never persists (commit is blur-gated)', async ({ page, request }) => {
    test.skip(!(await openPage(page)), SKIP_MSG_BLANK);
    const input = page.locator(SPEC_INPUT);
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.click();
    await input.pressSequentially('fab'); // mid-word, still focused — no blur
    await page.waitForTimeout(SAVE_WINDOW_MS);
    const cfg = await getStoredConfig(request);
    expect(cfg.tiers).toEqual([]); // still the untouched default menu
    const probe = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[aria-label="Tier 4 model spec"]');
      const first = inputs[0] as HTMLInputElement | undefined;
      return {
        count: inputs.length,
        value: first?.value,
        // DraftInput wraps the input in a column-flex span — the old page's
        // bare input has a row-flex DIV parent. Distinguishes served module.
        parentTag: first?.parentElement?.tagName,
        parentFlexDir: first?.parentElement ? getComputedStyle(first.parentElement).flexDirection : null,
        statusLine: document.querySelector('h1 span')?.textContent,
      };
    });
    console.log('DOM PROBE:', JSON.stringify(probe));
    await page.keyboard.press('Escape'); // revert the draft
    await expect(input).toHaveValue('opus:xhigh');
  });

  test('an invalid spec is flagged inline and never persisted', async ({ page, request }) => {
    test.skip(!(await openPage(page)), SKIP_MSG_BLANK);
    await editSpecAndBlur(page, 'opush'); // bare unknown alias — the typo class
    await expect(page.getByRole('alert').filter({ hasText: 'not a known model alias' })).toBeVisible();
    await page.waitForTimeout(SAVE_WINDOW_MS);
    const cfg = await getStoredConfig(request);
    expect(cfg.tiers).toEqual([]); // nothing persisted, nothing wiped
  });

  test('a valid edit commits on blur and survives reload', async ({ page, request }) => {
    test.skip(!(await openPage(page)), SKIP_MSG_BLANK);
    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/agent-config') && r.request().method() === 'POST' && r.status() === 200,
      { timeout: 15_000 },
    );
    await editSpecAndBlur(page, 'fable:max');
    await saved;
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
    const cfg = await getStoredConfig(request);
    const tiers = cfg.tiers as Array<{ name: string; spec: string }>;
    expect(tiers).toHaveLength(4);
    expect(tiers[3]).toMatchObject({ name: 'max', spec: 'fable:max' });
  });

  test('WIPE REGRESSION: an invalid edit holds the stored value across reload', async ({ page, request }) => {
    test.skip(!(await openPage(page)), SKIP_MSG_BLANK);
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
    await editSpecAndBlur(page, 'opus:'); // mid-typed effort suffix — invalid
    await expect(page.getByRole('alert').filter({ hasText: 'invalid spec' })).toBeVisible();
    await page.waitForTimeout(SAVE_WINDOW_MS);
    // The store kept the last valid menu — the row was NOT deleted…
    const cfg = await getStoredConfig(request);
    const tiers = cfg.tiers as Array<{ spec: string }>;
    expect(tiers).toHaveLength(4);
    expect(tiers[3].spec).toBe('fable:max');
    // …and a reload re-hydrates the saved value, not a gutted menu.
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
  });
});
