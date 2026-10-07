/** Real Chromium exercises the production shared renderer through HTTP. This
 * registered Vitest e2e check is runnable by the acceptance test router. */
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPlanAuditReport } from './plan-audit-report';
const document = { generatedAt: '2026-10-07T00:00:00Z', rows: Array.from({ length: 95 }, (_, n) => ({ slug: 'plan-' + n, title: 'Plan ' + String(n).padStart(2, '0'), category: n % 2 ? 'Finish' : 'History', status: 'active', implementation: 'Built ' + n, citations: [{ path: 'src/' + n + '.ts' }] })) };
let browser: Browser;
let url: string;
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(renderPlanAuditReport(document)); });
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();if (!address || typeof address === 'string') throw new Error('Missing browser fixture address');
  url = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close();await new Promise<void>(resolve => server.close(() => resolve())); });
describe('audit report browser navigation', () => {
  it('retains complete evidence across pagination, filters, deep-link reload and mobile viewport', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url + '/#plan=plan-94');
      expect(await page.locator('#detail').textContent()).toContain('src/94.ts');
      expect(await page.locator('#results button').count()).toBeLessThanOrEqual(40);
      expect(await page.locator('#audit').evaluate(node => JSON.parse(node.textContent!).rows.length)).toBe(95);
      await page.getByRole('searchbox').fill('Plan 05');
      expect(await page.locator('#shown').textContent()).toBe('1 of 95 records');
      expect(await page.locator('#detail').textContent()).toContain('Built 5');
      await page.reload();expect(await page.locator('#detail').textContent()).toContain('Built 5');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('searchbox').fill('missing');
      expect(await page.locator('#detail').textContent()).toContain('No matching plans');
      await page.getByRole('button', { name: 'Evidence & limits' }).click();
      expect(await page.locator('dialog').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await page.locator('dialog').isVisible()).toBe(false);
    } finally { await page.close(); }
  });
});
