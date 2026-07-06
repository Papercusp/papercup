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

  // The deploy/git-sync journey (WI-3204 audit): the agent-e2e doc's own
  // coverage checklist (§13) lists `/admin/{plans,git,features,tables,dbos,run}`
  // as a unit, with "/admin/git pipeline view renders" called out explicitly —
  // but before this, only run/features/tables had ANY e2e smoke. /admin/git,
  // /admin/dbos, and /admin/plans (route-level; plan-detail-flow.spec.ts
  // covers plan-detail interaction separately) had zero coverage.
  test('/admin/git renders without 500 and shows the pipeline view', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/git`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
    // GitClient.tsx: stable "Pipeline" heading, present regardless of sync data.
    await expect(page.getByText('Pipeline', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('/admin/dbos renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/dbos`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/plans renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/plans`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });
});
