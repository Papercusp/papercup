import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const shellCss = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const reportsCss = readFileSync(new URL('../../operator-vite/src/components/reports/ReportsRoute.css', import.meta.url), 'utf8');

test('Reports fullscreen reader escapes the route content box', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/*', route => route.abort());
  await page.setContent(`
    <style>${shellCss}\n${reportsCss}</style>
    <main data-route-transition-page="true" style="margin: 80px 48px; width: 900px; height: 500px">
      <div class="reports-page">
        <section class="reports-reader reports-reader--fullscreen" aria-label="Report reader">
          <button>Restore report reader</button>
        </section>
      </div>
    </main>
  `);

  await expect.poll(() => page.getByRole('region', { name: 'Report reader' }).boundingBox()).toEqual({
    x: 0, y: 0, width: 1280, height: 800,
  });
});
