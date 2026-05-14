/**
 * Admin pages — render-without-crash smoke for the operator's admin surface.
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('admin pages', () => {
  test('/admin renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/run renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/run`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/features renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/features`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/tables renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/tables`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });
});
