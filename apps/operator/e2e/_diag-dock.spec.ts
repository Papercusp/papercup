import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3070';
const SLUG = process.env.DOCK_E2E_SLUG ?? 'papercup';

test('DIAG: dock=1 survival + adapter liveness', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('nuqs-merge-adapter') || m.type() === 'error') logs.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

  await page.goto(`${baseURL}/harness/${SLUG}?dock=1`, { waitUntil: 'domcontentloaded' });
  const urlT0 = page.url();
  await page.waitForTimeout(1500);
  const urlT1 = page.url();
  await page.waitForTimeout(4000);
  const urlT2 = page.url();

  const marker = await page.evaluate(() => (window as unknown as Record<string, unknown>).__NUQS_MERGE_ADAPTER__ ?? 'ABSENT');
  const hasClassic = await page.getByRole('button', { name: /← Classic/ }).count();

  console.log('DIAG_MARKER=' + JSON.stringify(marker));
  console.log('DIAG_URL_T0=' + urlT0);
  console.log('DIAG_URL_T1=' + urlT1);
  console.log('DIAG_URL_T2=' + urlT2);
  console.log('DIAG_HAS_CLASSIC=' + hasClassic);
  console.log('DIAG_ADAPTER_LOGS=' + JSON.stringify(logs.slice(0, 12)));
  expect(true).toBe(true);
});
