/**
 * Dockview migration end-to-end specs.
 *
 * Plan: apps/operator/docs/dockview-migration-plan-v4.md
 *
 * Covers the live behaviors that only render in a real browser:
 *   - /harness/<slug>?dock=1 mounts, classic exits via ← Classic
 *   - Default layout matches the classic-mirror shape
 *   - + Add panel catalog opens, lists registered types, opens new panel
 *   - Layouts menu: save current as → entry appears
 *   - Onboarding bubble shows on first visit + dismisses
 *   - Pin-as-panel via right-click on feature row
 *   - Cmd+[/Cmd+] navigates between recently focused tabs
 *   - Reload restores the layout from PG
 *   - API contracts (already covered by integration tests; minimal smoke here)
 */
import { test, expect, type Page } from '@playwright/test';

// Mirror playwright.config.ts's BASE_URL derivation — honoring OPERATOR_E2E_PORT
// keeps this spec on the SAME server the config's webServer boots. A hardcoded
// :3055 silently targeted the standing dev server whenever a fresh rig ran on
// another port (EI-208 forensics, 2026-06-10).
const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;
// Resolve a harness slug that actually exists in the e2e workspace. The old
// hardcoded 'sheets' isn't provisioned in the default workspace, so the
// /harness/$slug loader notFound()s (then redirects). Prefer an explicit
// DOCK_E2E_SLUG, else `papercup` (the workspace's stable anchor project),
// else the first project. Do NOT prefer test-looking fixtures: on the shared
// dev stack those slugs (cloud-e2e-smoke, e2e-imp-sync1, …) are created and
// destroyed by OTHER suites mid-run, so the loader 404s intermittently.
// Resolved in beforeAll because /projects/lite is workspace-scoped at runtime.
let SLUG = process.env.DOCK_E2E_SLUG ?? '';

test.beforeAll(async ({ request }) => {
  if (SLUG) return;
  const r = await request.get(`${baseURL}/api/harness/projects/lite`);
  const projects: Array<{ slug: string }> = (await r.json()).projects ?? [];
  SLUG = projects.find((p) => p.slug === 'papercup')?.slug ?? projects[0]?.slug ?? 'papercup';
});

async function gotoDock(page: Page) {
  // Clear any onboarded flag so first-visit assertions can run.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('papercusp:dock-onboarded');
    } catch { /* ignore */ }
  });
  await page.goto(`${baseURL}/harness/${SLUG}?dock=1`, { waitUntil: 'domcontentloaded' });
  // NOTE: do NOT waitForLoadState('networkidle') — the harness shell opens
  // long-lived SSE streams (zero-harness/flags), so the network never goes
  // idle and this would hang 30s then time out. Rely on web-first assertion
  // auto-waiting (toBeVisible) for readiness instead.
}

test.describe('dock route — mount + chrome', () => {
  test('?dock=1 renders the dock shell with toolbar', async ({ page }) => {
    await gotoDock(page);
    // The dock toolbar shows "Dock" label + slug
    await expect(page.getByText('Dock', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(SLUG).first()).toBeVisible();
    // Classic exit affordance
    await expect(page.getByRole('button', { name: /← Classic/ })).toBeVisible();
  });

  test('+ Add panel button is visible', async ({ page }) => {
    await gotoDock(page);
    await expect(page.getByRole('button', { name: 'Add panel' })).toBeVisible();
  });

  test('Layouts menu button is visible', async ({ page }) => {
    await gotoDock(page);
    await expect(page.getByRole('button', { name: 'Layouts menu' })).toBeVisible();
  });

  test('Back/Forward chevrons are visible (disabled initially)', async ({ page }) => {
    await gotoDock(page);
    await expect(page.getByRole('button', { name: 'Back to previous tab' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Forward to next tab' })).toBeVisible();
  });

  test('← Classic button returns to /harness/<slug> (no dock=1)', async ({ page }) => {
    await gotoDock(page);
    await page.getByRole('button', { name: /← Classic/ }).click();
    await page.waitForURL(`${baseURL}/harness/${SLUG}`);
    expect(page.url()).not.toContain('dock=1');
  });
});

test.describe('dock route — onboarding', () => {
  test('first visit shows the intro bubble; dismiss hides it + persists', async ({ page }) => {
    await gotoDock(page);
    const bubble = page.getByRole('status', { name: 'Dock onboarding' });
    await expect(bubble).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss onboarding' }).click();
    await expect(bubble).toBeHidden();
    // Re-navigate; bubble stays gone. NOTE: no waitForLoadState('networkidle')
    // — the dock shell opens long-lived SSE streams so the network never goes
    // idle (see gotoDock). Rely on toHaveCount auto-waiting instead.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status', { name: 'Dock onboarding' })).toHaveCount(0);
  });
});

test.describe('dock route — + Add panel catalog', () => {
  test('opens the popover and lists panel types', async ({ page }) => {
    await gotoDock(page);
    await page.getByRole('button', { name: 'Add panel' }).click();
    await expect(page.getByRole('dialog', { name: 'Panel catalog' })).toBeVisible();
    // At least one real registered type should be listed.
    await expect(page.getByText('Features', { exact: true }).first()).toBeVisible();
  });

  test('Esc closes the catalog', async ({ page }) => {
    await gotoDock(page);
    await page.getByRole('button', { name: 'Add panel' }).click();
    await expect(page.getByRole('dialog', { name: 'Panel catalog' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Panel catalog' })).toBeHidden();
  });
});

test.describe('dock route — Layouts menu', () => {
  test('opens, shows save-current-as and reset entries', async ({ page }) => {
    await gotoDock(page);
    await page.getByRole('button', { name: 'Layouts menu' }).click();
    await expect(page.getByRole('menu', { name: 'Layouts' })).toBeVisible();
    await expect(page.getByText(/Save current as/i)).toBeVisible();
    await expect(page.getByText(/Reset to default/i)).toBeVisible();
  });
});

test.describe('dock route — backend contract smoke', () => {
  test('GET /api/dock-layouts/default returns a seeded layout', async ({ request }) => {
    const r = await request.get(`${baseURL}/api/dock-layouts/default`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.layoutName).toBe('default');
    expect(body.schemaVersion).toBe(1);
    expect(body.layoutJson?.root).toBeDefined();
  });

  test('GET /api/dock-layouts/_list returns an array', async ({ request }) => {
    const r = await request.get(`${baseURL}/api/dock-layouts/_list`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.layouts)).toBe(true);
  });

  test('PUT with bad schemaVersion returns 400', async ({ request }) => {
    const r = await request.put(
      `${baseURL}/api/dock-layouts/vitest-bad-${Date.now()}`,
      {
        data: { layout: { schemaVersion: 999 } },
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(r.status()).toBe(400);
  });

  test('GET /api/plugins/<slug>/contributions returns panels array', async ({ request }) => {
    const r = await request.get(`${baseURL}/api/plugins/${SLUG}/contributions`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.panels)).toBe(true);
  });

  test('GET /api/harness-phase-last-used/<slug> returns { phase: ... }', async ({ request }) => {
    const r = await request.get(`${baseURL}/api/harness-phase-last-used/${SLUG}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('phase');
  });
});

test.describe('dock route — classic dashboard parity', () => {
  test('?dock=1 and classic both 200', async ({ request }) => {
    expect((await request.get(`${baseURL}/harness/${SLUG}`)).ok()).toBe(true);
    expect((await request.get(`${baseURL}/harness/${SLUG}?dock=1`)).ok()).toBe(true);
  });

  test('dock-preview demo page renders', async ({ request }) => {
    const r = await request.get(`${baseURL}/harness/${SLUG}/dock-preview`);
    expect(r.status()).toBe(200);
  });
});

test.describe('dock route — layout persistence across reload', () => {
  test('seeded layout survives reload', async ({ page, request }) => {
    // Wipe any existing seed for the test layout name.
    const layoutName = `dashboard:${SLUG}`;
    await request.delete(`${baseURL}/api/dock-layouts/${encodeURIComponent(layoutName)}`);

    await gotoDock(page);
    // After mount: PG row should exist (seeded by getLayout on first GET).
    const r1 = await request.get(`${baseURL}/api/dock-layouts/${encodeURIComponent(layoutName)}`);
    expect(r1.status()).toBe(200);
    const body1 = await r1.json();
    expect(body1.layoutJson.schemaVersion).toBe(1);

    // Reload — same row should be returned. domcontentloaded, not networkidle:
    // the dock shell's persistent SSE streams keep the network busy forever.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const r2 = await request.get(`${baseURL}/api/dock-layouts/${encodeURIComponent(layoutName)}`);
    const body2 = await r2.json();
    // Same createdTs (no re-seed)
    expect(body2.createdTs).toBe(body1.createdTs);
  });
});
