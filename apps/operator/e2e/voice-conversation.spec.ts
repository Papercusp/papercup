import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './_axe';

/**
 * Voice conversation surface + voice-state accessibility E2E.
 *
 * P-007 (voice conversation flow) + P-020 (a11y of the voice-state aria-live
 * regions) of plan voice-production-test-coverage-2026-06-01.
 *
 * Per voice-mode.spec.ts: headless Chromium can't drive a real mic / STT / TTS
 * (no audio device, empty voice list, Voicemode services absent in CI), so the
 * AUTOMATED voice E2E covers the DETERMINISTIC surface only:
 *   - the web voice-mode button stays dark by default (TESTING-gated, D-011)
 *   - the EL Conv AI session-token endpoint is auth-gated
 *   - the dual aria-live regions exist (the screen-reader mirror of TTS)
 *   - the shell is a11y-clean (no serious/critical axe violations) with the
 *     voice aria-live regions mounted
 *
 * A real spoken-conversation round-trip (mic → STT → operator turn → <say> →
 * TTS, with barge-in) is the MANUAL agent-e2e procedure driven through the live
 * Tauri shell — see /internal/docs/testing/agent-e2e — not an automated headless
 * test. This spec runs against :3055 headless Chromium in CI (run-e2e label),
 * the same sanctioned path as voice-mode.spec.ts.
 */

test.describe('voice conversation surface (deterministic; real audio = agent-e2e)', () => {
  test.beforeEach(async ({ page }) => {
    // Mark tutorial complete so the voice affordances render their full UI.
    await page.addInitScript(() => {
      sessionStorage.setItem('oracle-tutorial-complete', 'true');
    });
  });

  test('voice-mode button stays dark by default (web operator chat is TESTING-gated)', async ({ page }) => {
    // native-terminal-desktop D-011 / P-016: the web operator chat sidebar —
    // the VoiceButton's host — only mounts behind FLAGS.TESTING (default OFF);
    // the desktop voice entry is the terminal-native pui surface. Guard the
    // gating here; VoiceButton's operable/labelled behavior is covered by its
    // component tests.
    await page.goto('/harness');
    await expect(page.getByRole('complementary', { name: 'Swarm sidebar' })).toBeVisible();
    await expect(page.getByRole('button', { name: /voice mode/i })).toHaveCount(0);
  });

  test('the EL Conv AI session-token endpoint is device-JWT gated (no anonymous mint)', async ({ page }) => {
    // The mobile voice-conversation token mint must not be reachable without a
    // device principal — a deterministic guard on the cost-bearing endpoint.
    const resp = await page.request.get('/api/device/voice-session-init');
    expect([401, 403]).toContain(resp.status());
  });
});

test.describe('voice-state accessibility (P-020)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('oracle-tutorial-complete', 'true');
    });
  });

  test('dual aria-live regions are present (screen-reader mirror of spoken output)', async ({ page }) => {
    await page.goto('/harness');
    const polite = page.locator('#voice-aria-polite');
    await expect(polite).toHaveAttribute('aria-live', 'polite');
    await expect(polite).toHaveAttribute('role', 'status');
    const assertive = page.locator('#voice-aria-assertive');
    await expect(assertive).toHaveAttribute('aria-live', 'assertive');
    await expect(assertive).toHaveAttribute('role', 'alert');
  });

  test('app shell with voice aria-live regions has no serious or critical a11y violations', async ({ page }) => {
    // The voice aria-live mirror mounts globally (asserted above); the web
    // voice BUTTON is TESTING-gated off by default (D-011), so the scan keys
    // on the shell + aria regions, not the button.
    await page.goto('/harness');
    await expect(page.locator('#voice-aria-polite')).toHaveAttribute('aria-live', 'polite');
    await expectNoA11yViolations(page);
  });
});
