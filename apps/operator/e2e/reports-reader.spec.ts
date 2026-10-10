/** Real Markdown/geometry coverage for the owner-selected Reports refined reader. */
import { test, expect } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { reportFullFixture, reportSummaryFixture } from '../../operator-vite/src/components/reports/reports-test-fixture';

const report = {
  ...reportFullFixture,
  title: 'Reports refined reader browser fixture',
  summary: 'A readable summary appears before the report body.',
  body_md: Array.from({ length: 8 }, (_, i) => `## Finding ${i + 1}\n\n${'Evidence and next steps for this finding. '.repeat(30)}`).join('\n\n'),
};
const previous = { ...report, report_id: 'edition-1', supersedes_report_id: null, title: 'Original reader fixture', body_md: '## Original finding\n\nOriginal evidence.' };
const summary = { ...reportSummaryFixture, title: report.title, summary: report.summary };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/flags/bootstrap', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ flags: { 'papercusp-reports-library': true }, evaluatedAt: Date.now(), source: 'override' }) }));
  await page.route('**/api/flags/stream', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture flags\n\n' }));
  // Fixture traffic never mutates the current user's saved read markers.
  await page.route('**/api/user/preferences', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ contentType: 'application/json', body: '{"payload":{}}' });
    else await route.continue();
  });
});

for (const width of [1440, 900, 390]) {
  test(`refined reader remains readable at ${width}px and its outline scrolls the report`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const sync = await stubSyncQueries(page, (name, args) => {
      if (name === 'reports.list') return [summary];
      if (name === 'reports.get') return args.reportId === 'edition-1' ? [previous] : [report];
      if (name === 'reports.lineage') return [{ ...summary, report_id: 'edition-1', published_at: '2026-09-30T12:00:00Z' }, summary];
      if (name === 'userPreferences.current') return [{ payload: {} }];
      return undefined;
    });
    await page.goto('/reports?sel=edition-2');
    await sync.waitForServed(['reports.list', 'reports.get', 'reports.lineage']);
    await expect(page.locator('.reports-article-main > h2')).toHaveText(report.title);
    await expect(page.locator('.reports-body h2').first()).toHaveText('Finding 1');
    await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link')).toHaveCount(8);
    const geometry = await page.locator('.reports-page').evaluate(root => {
      const workspace = root.querySelector('.reports-workspace')!;
      const list = root.querySelector('.reports-list')!;
      const reader = root.querySelector('.reports-reader')!;
      const outline = root.querySelector('.reports-outline')!;
      const listBox = list.getBoundingClientRect(); const readerBox = reader.getBoundingClientRect();
      return { overflow: root.scrollWidth > root.clientWidth + 1,
        columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
        stacked: readerBox.top >= listBox.bottom - 1,
        outlineVisible: outline.getBoundingClientRect().width > 100,
        summaryBeforeBody: !!(root.querySelector('.reports-summary')!.compareDocumentPosition(root.querySelector('.reports-body')!) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(geometry.overflow).toBe(false); expect(geometry.summaryBeforeBody).toBe(true);
    expect(geometry.outlineVisible).toBe(true); expect(geometry.stacked).toBe(width === 390);
    if (width === 1440) expect(geometry.columns).toBe(2);

    const outerScroll = await page.evaluate(() => window.scrollY);
    // dispatch avoids Playwright scrolling the whole page to reach the outline:
    // this assertion isolates what the product click handler itself scrolls.
    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Finding 7', exact: true }).dispatchEvent('click');
    await expect.poll(() => page.locator('.reports-article-main').evaluate(root => root.scrollTop)).toBeGreaterThan(100);
    await expect(page.getByRole('progressbar', { name: 'Reading progress' })).not.toHaveAttribute('value', '0');
    expect(new URL(page.url()).searchParams.get('sel')).toBe('edition-2');
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
    await page.getByRole('button', { name: 'Compare editions', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Edition comparison' }).getByText('Original evidence.')).toBeVisible();
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await page.locator('.reports-article-main').evaluate(root => { root.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`reports-reader-${width}.png`), fullPage: true });
    sync.assertServed('reports.list', 'reports.get', 'reports.lineage', 'userPreferences.current');
  });
}
