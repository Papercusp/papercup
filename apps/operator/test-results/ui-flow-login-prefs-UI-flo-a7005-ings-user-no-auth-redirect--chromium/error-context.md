# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ui-flow-login-prefs.spec.ts >> UI flow: signup → settings round-trip >> authenticated user reaches /settings/user (no auth redirect)
- Location: e2e/ui-flow-login-prefs.spec.ts:80:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/login
Call log:
  - navigating to "http://127.0.0.1:3055/login", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Multi-step UI flow: signup → land authenticated, navigate, verify state persistence.
  3   |  *
  4   |  * Catches:
  5   |  *   - Cookie not set correctly after signup
  6   |  *   - Redirect loop on /settings/user without auth
  7   |  *   - Form submit doesn't redirect on success
  8   |  *   - logout doesn't clear the cookie
  9   |  *
  10  |  * Username pattern (from app/login/page.tsx:210): [a-z0-9_-]{2,32}
  11  |  */
  12  | import { test, expect } from '@playwright/test';
  13  | 
  14  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  15  | 
  16  | function genUsername(prefix: string): string {
  17  |   const stamp = Date.now().toString(36);
  18  |   const rand = Math.random().toString(36).slice(2, 6);
  19  |   return `${prefix}-${stamp}-${rand}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
  20  | }
  21  | 
  22  | async function doSignup(page: import('@playwright/test').Page, username: string): Promise<void> {
> 23  |   await page.goto(`${baseURL}/login`);
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3055/login
  24  | 
  25  |   // Switch to signup mode — wait for the "Create a new user instead" toggle.
  26  |   // The form initially renders in login mode (only username + password checkbox).
  27  |   const toggle = page.getByRole('button', { name: /create a new user/i });
  28  |   await toggle.waitFor({ state: 'visible', timeout: 5_000 });
  29  |   await toggle.click();
  30  | 
  31  |   // After the toggle, the display_name input appears. Wait for it before filling.
  32  |   const displayNameInput = page.getByLabel(/display name/i);
  33  |   await displayNameInput.waitFor({ state: 'visible', timeout: 5_000 });
  34  | 
  35  |   // Fill required fields
  36  |   await page.getByLabel(/^username$/i).fill(username);
  37  |   await displayNameInput.fill(`E2E ${username.slice(-6)}`);
  38  | 
  39  |   // Submit
  40  |   await page.getByRole('button', { name: /^create user$/i }).click();
  41  | 
  42  |   // Wait for redirect off /login
  43  |   await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 10_000 });
  44  | }
  45  | 
  46  | async function skipIfPgUnavailable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  47  |   try {
  48  |     const r = await request.get(`${baseURL}/api/auth/me`);
  49  |     const j = await r.json();
  50  |     return Boolean(j.pgUnavailable);
  51  |   } catch {
  52  |     return false;
  53  |   }
  54  | }
  55  | 
  56  | test.describe('UI flow: signup → settings round-trip', () => {
  57  |   test.beforeEach(async ({ request }) => {
  58  |     if (await skipIfPgUnavailable(request)) {
  59  |       test.skip(true, 'PG unavailable in this env; UI signup flow requires PG');
  60  |     }
  61  |   });
  62  | 
  63  |   test('signup creates session and lands authenticated', async ({ page, context }) => {
  64  |     const username = genUsername('flow1');
  65  |     await doSignup(page, username);
  66  | 
  67  |     // Verify session cookie is set
  68  |     const cookies = await context.cookies(baseURL);
  69  |     const session = cookies.find((c) => c.name === 'papercusp_session');
  70  |     expect(session?.value).toBeTruthy();
  71  |     expect(session?.httpOnly).toBe(true);
  72  | 
  73  |     // Verify /me reflects the new user
  74  |     const meRes = await page.request.get(`${baseURL}/api/auth/me`);
  75  |     const me = await meRes.json();
  76  |     expect(me.user?.username).toBe(username);
  77  |     expect(me.autoLogin).toBeFalsy();
  78  |   });
  79  | 
  80  |   test('authenticated user reaches /settings/user (no auth redirect)', async ({ page }) => {
  81  |     const username = genUsername('flow2');
  82  |     await doSignup(page, username);
  83  | 
  84  |     const res = await page.goto(`${baseURL}/settings/user`);
  85  |     expect(res?.status()).toBe(200);
  86  |     expect(page.url()).not.toContain('/login');
  87  |   });
  88  | 
  89  |   test('logout clears the session and reverts to default user', async ({ page }) => {
  90  |     const username = genUsername('flow3');
  91  |     await doSignup(page, username);
  92  | 
  93  |     // Confirm signed in
  94  |     let me = await page.request.get(`${baseURL}/api/auth/me`).then((r) => r.json());
  95  |     expect(me.user?.username).toBe(username);
  96  | 
  97  |     // POST /api/auth/logout
  98  |     const out = await page.request.post(`${baseURL}/api/auth/logout`);
  99  |     expect(out.status()).toBe(200);
  100 | 
  101 |     // After logout, /me should now return autoLogin=true (default user)
  102 |     me = await page.request.get(`${baseURL}/api/auth/me`).then((r) => r.json());
  103 |     expect(me.autoLogin).toBe(true);
  104 |     expect(me.user?.username).toBe('default');
  105 |   });
  106 | 
  107 |   test('login form rejects invalid username pattern', async ({ page }) => {
  108 |     await page.goto(`${baseURL}/login`);
  109 |     await page.getByRole('button', { name: /create a new user/i }).click();
  110 | 
  111 |     // HTML5 pattern validation blocks UPPERCASE letters
  112 |     const usernameInput = page.getByLabel(/^username$/i);
  113 |     await usernameInput.fill('UPPERCASE');
  114 |     const validity = await usernameInput.evaluate(
  115 |       (el) => (el as HTMLInputElement).validity.patternMismatch,
  116 |     );
  117 |     expect(validity).toBe(true);
  118 |   });
  119 | 
  120 |   test('login as existing user works after signup', async ({ page, context }) => {
  121 |     const username = genUsername('flow5');
  122 |     await doSignup(page, username);
  123 | 
```