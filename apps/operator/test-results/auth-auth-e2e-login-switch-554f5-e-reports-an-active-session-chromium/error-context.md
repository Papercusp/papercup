# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> auth e2e >> /login?switch=1 does NOT auto-redirect when /api/auth/me reports an active session
- Location: e2e/auth.spec.ts:84:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/login?switch=1
Call log:
  - navigating to "http://localhost:3055/login?switch=1", waiting until "load"

```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Auth surface e2e — covers the user-visible flows shipped this arc:
  5  |  *   - /api/auth/me returns 200 even when PG is unavailable (bug-fix 8ac60b05)
  6  |  *   - synthetic user response carries pgUnavailable:true (round-X audit)
  7  |  *   - AutoLoginWelcomeToast does NOT fire on pgUnavailable response (bug 27)
  8  |  *   - UserPicker still mounts on pgUnavailable response (defense-in-depth)
  9  |  *   - /login?switch=1 banner renders + skips auto-redirect (Step B)
  10 |  */
  11 | test.describe('auth e2e', () => {
  12 |   test('/api/auth/me returns 200 even when PG is unavailable', async ({ request }) => {
  13 |     const r = await request.get('/api/auth/me');
  14 |     expect(r.status()).toBe(200);
  15 |     const j = await r.json();
  16 |     expect(j.user).toBeTruthy();
  17 |     expect(typeof j.user.id).toBe('string');
  18 |     expect(typeof j.user.display_name).toBe('string');
  19 |     expect(typeof j.autoLogin).toBe('boolean');
  20 |   });
  21 | 
  22 |   test('UserPicker renders user display name in chrome (defense-in-depth: even when PG unavailable)', async ({ page }) => {
  23 |     // `/` redirects through PG to /setup or /harness; with PG unavailable
  24 |     // we go straight to /harness which is chromed.
  25 |     await page.goto('/harness');
  26 |     // Wait for /api/auth/me to settle.
  27 |     await page.waitForResponse((r) => r.url().includes('/api/auth/me'));
  28 |     // UserPicker shows the user's display_name. With PG unavailable it
  29 |     // falls back to the synthetic "User" name (8ac60b05 + round-X fix).
  30 |     const picker = page.locator('.pc-user-picker').first();
  31 |     await expect(picker).toBeVisible({ timeout: 10_000 });
  32 |   });
  33 | 
  34 |   test('AutoLoginWelcomeToast does NOT fire when /api/auth/me returns pgUnavailable', async ({ page }) => {
  35 |     // Sonner renders toasts inside a [data-sonner-toaster] region.
  36 |     // Clear any pre-existing welcome stamps so a fresh visit would
  37 |     // normally trigger the toast.
  38 |     await page.addInitScript(() => {
  39 |       try { localStorage.clear(); } catch { /* */ }
  40 |     });
  41 |     await page.goto('/');
  42 |     await page.waitForResponse((r) => r.url().includes('/api/auth/me'));
  43 |     // Give the welcome-toast effect a chance to run.
  44 |     await page.waitForTimeout(500);
  45 | 
  46 |     const me = await page.evaluate(async () => {
  47 |       const r = await fetch('/api/auth/me');
  48 |       return r.json();
  49 |     });
  50 | 
  51 |     if (me.pgUnavailable) {
  52 |       // The fix: toast should NOT fire when pgUnavailable=true.
  53 |       // Verify by checking no welcome-stamp was written for the synthetic UUID.
  54 |       const stampedSynthetic = await page.evaluate(() =>
  55 |         localStorage.getItem('papercusp_user_welcomed_00000000-0000-0000-0000-000000000001'),
  56 |       );
  57 |       expect(
  58 |         stampedSynthetic,
  59 |         'AutoLoginWelcomeToast must NOT write a stamp under the synthetic UUID when pgUnavailable is true (would cause duplicate welcome on next PG-recovered load)',
  60 |       ).toBeNull();
  61 |     } else {
  62 |       // Real /me — toast may have fired; stamp may have been written.
  63 |       // Either way the synthetic-UUID stamp must not exist (we'd only
  64 |       // write under the real user's id, not the sentinel).
  65 |       const stampedSynthetic = await page.evaluate(() =>
  66 |         localStorage.getItem('papercusp_user_welcomed_00000000-0000-0000-0000-000000000001'),
  67 |       );
  68 |       expect(stampedSynthetic).toBeNull();
  69 |     }
  70 |   });
  71 | 
  72 |   test('/login renders the form (smoke)', async ({ page }) => {
  73 |     await page.goto('/login');
  74 |     await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  75 |     // No banner without ?switch=1.
  76 |     await expect(page.getByText(/different user/i)).not.toBeVisible();
  77 |   });
  78 | 
  79 |   test('/login?switch=1 shows the banner', async ({ page }) => {
  80 |     await page.goto('/login?switch=1');
  81 |     await expect(page.getByText(/different user/i)).toBeVisible();
  82 |   });
  83 | 
  84 |   test('/login?switch=1 does NOT auto-redirect when /api/auth/me reports an active session', async ({ page }) => {
  85 |     // We can't easily force a session here without a working login flow
  86 |     // against PG, but we can verify the page stays on /login when
  87 |     // navigated with switch=1. The route currently redirects when no
  88 |     // ?switch is present + auth/me reports a user.
> 89 |     await page.goto('/login?switch=1');
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/login?switch=1
  90 |     // Wait briefly to ensure no client-side redirect happens.
  91 |     await page.waitForTimeout(500);
  92 |     expect(page.url()).toContain('/login');
  93 |     expect(page.url()).toContain('switch=1');
  94 |   });
  95 | });
  96 | 
```