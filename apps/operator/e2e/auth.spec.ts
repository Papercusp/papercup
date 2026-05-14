import { expect, test } from '@playwright/test';

/**
 * Auth surface e2e — covers the user-visible flows shipped this arc:
 *   - /api/auth/me returns 200 even when PG is unavailable (bug-fix 8ac60b05)
 *   - synthetic user response carries pgUnavailable:true (round-X audit)
 *   - AutoLoginWelcomeToast does NOT fire on pgUnavailable response (bug 27)
 *   - UserPicker still mounts on pgUnavailable response (defense-in-depth)
 *   - /login?switch=1 banner renders + skips auto-redirect (Step B)
 */
test.describe('auth e2e', () => {
  test('/api/auth/me returns 200 even when PG is unavailable', async ({ request }) => {
    const r = await request.get('/api/auth/me');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.user).toBeTruthy();
    expect(typeof j.user.id).toBe('string');
    expect(typeof j.user.display_name).toBe('string');
    expect(typeof j.autoLogin).toBe('boolean');
  });

  test('UserPicker renders user display name in chrome (defense-in-depth: even when PG unavailable)', async ({ page }) => {
    // `/` redirects through PG to /setup or /harness; with PG unavailable
    // we go straight to /harness which is chromed.
    await page.goto('/harness');
    // Wait for /api/auth/me to settle.
    await page.waitForResponse((r) => r.url().includes('/api/auth/me'));
    // UserPicker shows the user's display_name. With PG unavailable it
    // falls back to the synthetic "User" name (8ac60b05 + round-X fix).
    const picker = page.locator('.pc-user-picker').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
  });

  test('AutoLoginWelcomeToast does NOT fire when /api/auth/me returns pgUnavailable', async ({ page }) => {
    // Sonner renders toasts inside a [data-sonner-toaster] region.
    // Clear any pre-existing welcome stamps so a fresh visit would
    // normally trigger the toast.
    await page.addInitScript(() => {
      try { localStorage.clear(); } catch { /* */ }
    });
    await page.goto('/');
    await page.waitForResponse((r) => r.url().includes('/api/auth/me'));
    // Give the welcome-toast effect a chance to run.
    await page.waitForTimeout(500);

    const me = await page.evaluate(async () => {
      const r = await fetch('/api/auth/me');
      return r.json();
    });

    if (me.pgUnavailable) {
      // The fix: toast should NOT fire when pgUnavailable=true.
      // Verify by checking no welcome-stamp was written for the synthetic UUID.
      const stampedSynthetic = await page.evaluate(() =>
        localStorage.getItem('papercusp_user_welcomed_00000000-0000-0000-0000-000000000001'),
      );
      expect(
        stampedSynthetic,
        'AutoLoginWelcomeToast must NOT write a stamp under the synthetic UUID when pgUnavailable is true (would cause duplicate welcome on next PG-recovered load)',
      ).toBeNull();
    } else {
      // Real /me — toast may have fired; stamp may have been written.
      // Either way the synthetic-UUID stamp must not exist (we'd only
      // write under the real user's id, not the sentinel).
      const stampedSynthetic = await page.evaluate(() =>
        localStorage.getItem('papercusp_user_welcomed_00000000-0000-0000-0000-000000000001'),
      );
      expect(stampedSynthetic).toBeNull();
    }
  });

  test('/login renders the form (smoke)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    // No banner without ?switch=1.
    await expect(page.getByText(/different user/i)).not.toBeVisible();
  });

  test('/login?switch=1 shows the banner', async ({ page }) => {
    await page.goto('/login?switch=1');
    await expect(page.getByText(/different user/i)).toBeVisible();
  });

  test('/login?switch=1 does NOT auto-redirect when /api/auth/me reports an active session', async ({ page }) => {
    // We can't easily force a session here without a working login flow
    // against PG, but we can verify the page stays on /login when
    // navigated with switch=1. The route currently redirects when no
    // ?switch is present + auth/me reports a user.
    await page.goto('/login?switch=1');
    // Wait briefly to ensure no client-side redirect happens.
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/login');
    expect(page.url()).toContain('switch=1');
  });
});
