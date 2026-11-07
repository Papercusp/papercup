import path from 'node:path';
import { test, expect } from './_egress';
import { root, startDesktopGridFixtureServer, type DesktopGridFixtureServer } from './_desktop-grid-fixture-server';

// Reuse the maintained isolated component server; the real PG reader matrix
// exercises persistence/eligibility separately. This browser fixture supplies
// controlled reader responses and runs the actual owner components unchanged.
let fixture: DesktopGridFixtureServer;
test.beforeAll(async () => {
  const stub = 'apps/operator/e2e/__fixtures__/grading-system-history-sync.ts';
  fixture = await startDesktopGridFixtureServer('apps/operator/e2e/__fixtures__/grading-system-history.tsx', {
    '@papercusp/sync': stub,
    '@papercusp/operator-core/lib/call-tool': stub,
    '@/lib/useLexicon': stub,
    [path.join(root, 'apps/operator/lib/useLexicon')]: stub,
    [path.join(root, 'apps/operator/lib/useLexicon.ts')]: stub,
  }, ['@radix-ui/react-collapsible']);
});
test.afterAll(async () => fixture?.server.close());

test('grading history shows measured age review labels and last accepted result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => {
    errors.push(error.message);
    console.error('Grading history fixture page error:', error.message);
  });
  await page.goto(fixture.origin);
  await expect(page.getByRole('note')).toHaveText('Controlled history fixture');
  await expect(page.getByLabel('History view')).toHaveValue('review-history');
  await expect(page.getByLabel('Last accepted result')).toContainText('older-accepted');
  await page.getByRole('button', { name: /Grading history/ }).click();
  const history = page.locator('table.pc-rubric-history');
  await expect(history).toContainText('newer-pending');
  await expect(history).toContainText('newer-review-failed');
  await expect(history).not.toContainText('older-accepted');
  await history.getByText('newer-pending', { exact: true }).click();
  await expect(page.getByLabel('Latest attempt')).toContainText('unavailable ms · error');
  await expect(page.getByLabel('Last measurement')).toContainText('840 ms · pass');
  await expect(page.getByLabel('Last measurement')).toContainText('60001 ms · stale');
  await expect(page.getByText('Excluded: grading-audit-pending')).toBeVisible();
  await expect(page.getByRole('table', { name: '2 criterion ratings' })).toContainText('manual');
  await page.getByRole('button', { name: /Back to grading history/ }).click();
  await page.getByRole('button', { name: 'Load older scorecards' }).click();
  await expect(history).toContainText('unreviewed-history');
  await expect(history).toContainText('diagnostic-history');
  await expect(history).toContainText('stale-history');
  await page.getByLabel('History view').selectOption('accepted');
  await expect(history).toContainText('older-accepted');
  await expect(history).not.toContainText('newer-pending');
  await expect(page.getByRole('button', { name: 'Load older scorecards' })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as {
    __gradingHistoryRequests: Array<{ queryName: string; args: Record<string, unknown> }>;
  }).__gradingHistoryRequests);
  expect(calls).toEqual(expect.arrayContaining([
    { queryName: 'scorecards.list', args: { rubricRef: 'grading-history-browser', mode: 'accepted', limit: 1 } },
    { queryName: 'scorecards.list', args: { rubricRef: 'grading-history-browser', mode: 'accepted', limit: 100 } },
  ]));
  expect(errors).toEqual([]);
});
