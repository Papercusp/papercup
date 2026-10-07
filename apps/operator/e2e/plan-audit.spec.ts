import { expect, test } from '@playwright/test';

test('sidebar audit opens report, navigates evidence, and reopens history', async ({ page }) => {
  // UI contracts use a controlled HTTP seam; a separate real-PG integration
  // suite proves persistence and workspace isolation (not a mocked database).
  const run = { id: '11111111-1111-4111-8111-111111111111', scope: 'single', planSlugs: ['audit-fixture'], status: 'complete', startedAt: '2026-10-07T00:00:00Z', rowCount: 1 };
  await page.route('**/api/admin/plan-audit**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('format') === 'html') {
      // Load the production shared renderer, never a lookalike report fixture.
      const { renderPlanAuditReport } = await import('../../../packages/operator-core/lib/plan-audit-report');
      await route.fulfill({ contentType: 'text/html', body: renderPlanAuditReport({ rows: [{ slug: 'audit-fixture', title: 'Audit fixture', status: 'active', category: 'Finish', implementation: 'Verified implementation', recommendation: 'Review evidence', citations: [{ path: 'src/real.ts' }] }] }) });
    } else await route.fulfill({ json: url.searchParams.has('runId') ? { run } : { runs: [run] } });
  });
  await page.goto('/?opcv=plans&paudit=' + run.id);
  const frame = page.frameLocator('iframe[title="Plan audit report"]');
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await expect(frame.getByText('src/real.ts', { exact: true }).first()).toBeVisible();
  await frame.getByRole('searchbox').fill('not-found');
  await expect(frame.getByText('No matching plans.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Saved audits' }).click();
  await page.getByRole('button', { name: /single audit.*complete/ }).click();
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '← Back to plans' })).toBeVisible();
  await expect(frame.getByRole('searchbox')).toBeVisible();
  await page.getByRole('button', { name: '← Back to plans' }).click();
  await expect(page.getByTestId('plan-audit-pane')).toHaveCount(0);
});
