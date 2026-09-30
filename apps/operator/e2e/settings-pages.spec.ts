/**
 * Settings pages — render-without-crash smoke for the operator's settings surface.
 *
 * /settings/* hosts ~20 pages. This spec verifies each renders (HTTP 200 or
 * auth-redirect 30x). It does NOT click through forms — those are layer-2 work.
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const SETTINGS_PAGES = [
  '/settings/profile',
  '/settings/backups',
  '/settings/voice',
  '/settings/shortcuts',
  '/settings/personalization',
  '/settings/remote-access',
  '/settings/agent',
  '/settings/plugins',
  '/settings/plugins/tools',
  '/settings/operator',
  '/settings/p2p',
  '/settings/api-keys',
  '/settings/omp',
  '/settings/user',
  '/settings/user/search',
  '/settings/user/memory',
  '/settings/publishing',
  '/settings/plugin-runtime',
];

test.describe('settings pages render', () => {
  for (const path of SETTINGS_PAGES) {
    test(`${path} renders without 500`, async ({ page }) => {
      const res = await page.goto(`${baseURL}${path}`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
      expect(res?.status() ?? 0).toBeLessThan(500);
      expect([200, 302, 307]).toContain(res?.status() ?? 0);
    });
  }
});
