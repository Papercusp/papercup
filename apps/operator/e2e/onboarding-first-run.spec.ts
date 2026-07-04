/**
 * Agent-chat-first onboarding — first-run routing + console surface
 * (plan agent-first-onboarding-2026-07-03, P-009 — the routing half; the
 * scripted concierge→handoff flow with a fake agent binary is
 * scripts/__tests__/onboard-launcher-flow.integration.test.ts).
 *
 * On a FRESH boot (setup-wizard state has no finished_at) the root route
 * gateways to the Onboarding Console (/onboarding) when
 * ONBOARDING_AGENT_FIRST is on, to the classic GUI wizard when it is off
 * (the reversible cutover), and a finished install lands on /adv. The
 * wizard-state + flag payloads are page.route-mocked so the spec is hermetic
 * on any host — the shared dev server's real install finished long ago, and
 * no DB state is touched.
 *
 * In a plain browser the console degrades to the explicit wizard-fallback
 * card (a browser can't spawn a pty) — that IS the correct non-Tauri
 * behavior, and its escape hatch back to /setup?force=1 is part of the
 * contract. The real pty console renders only inside the Tauri shell
 * (verified per /internal/docs/testing/agent-e2e).
 */
import { expect, test, type Page } from '@playwright/test';

const FLAG_KEY = 'papercusp-onboarding-agent-first';

async function mockWizardState(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/desktop/setup-wizard-state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

async function mockOnboardingFlag(page: Page, on: boolean) {
  await page.route('**/api/flags/bootstrap*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ flags: { [FLAG_KEY]: on }, evaluatedAt: 1, source: 'e2e-mock' }),
    }),
  );
}

test.describe('first-run gateway (/)', () => {
  test('fresh boot + flag ON → the agent-chat Onboarding Console', async ({ page }) => {
    await mockWizardState(page, {}); // no finished_at ⇒ first run
    await mockOnboardingFlag(page, true);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/onboarding\b/);
    // Browser (non-Tauri) degrades to the wizard-fallback card — assert the
    // console surface mounted and offers the escape hatch.
    await expect(page.getByRole('heading', { name: 'Welcome to Papercusp' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open the setup wizard' })).toBeVisible();
  });

  test('fresh boot + flag OFF → the classic GUI wizard (reversible cutover)', async ({ page }) => {
    await mockWizardState(page, {});
    await mockOnboardingFlag(page, false);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/setup\b/);
  });

  test('finished install → /adv, never onboarding', async ({ page }) => {
    await mockWizardState(page, { finished_at: '2026-01-01T00:00:00.000Z' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/adv\b/);
    expect(page.url()).toContain('tab=harnesses');
  });
});

test.describe('onboarding console surface (/onboarding)', () => {
  test('browser fallback card routes to the GUI wizard at /setup?force=1', async ({ page }) => {
    await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
    const escapeHatch = page.getByRole('button', { name: 'Open the setup wizard' });
    // Generous first-paint budget: on a cold vite dev server the first request
    // triggers a full module-graph transform that can exceed the 5s default.
    await expect(escapeHatch).toBeVisible({ timeout: 20_000 });
    await escapeHatch.click();
    await page.waitForURL(/\/setup\?/);
    expect(page.url()).toContain('force=1');
  });
});
