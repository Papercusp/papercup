import { test, expect, type Page } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
const SLUG = 'e2e-wi-filter-pot';
const WORK_ITEMS = [
  { id: 'WI-1', kind: 'bug', family: 'issue', title: 'First stubbed item', summary: null, state: 'open', assignee: 'alice', assignedBy: null, severity: 'high', priority: 1, rank: 1, planSlug: null, spineRole: null, spineStatus: null, updatedAt: '2026-06-14T00:00:00.000Z', origin: null, auditVerdict: null, verifiedAuthorGithubUserId: null },
  { id: 'F-2', kind: 'feature', family: 'feature', title: 'Second stubbed item', summary: null, state: 'in_progress', assignee: 'bob', assignedBy: null, severity: null, priority: 2, rank: 2, planSlug: null, spineRole: null, spineStatus: null, updatedAt: '2026-06-14T00:00:00.000Z', origin: null, auditVerdict: null, verifiedAuthorGithubUserId: null },
];
async function stubApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: SLUG, path: `/tmp/${SLUG}`, name: SLUG, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }] }) }));
  await page.route('**/api/harness/*/status**', async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }) }));
  await page.route('**/api/harness/*/lanes**', async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) }));
  await page.route('**/api/harness/*/agents**', async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) }));
  await page.route('**/api/zero-harness/rest-query-batch**', async (r) => {
    const post = r.request().postDataJSON() as { queries?: Array<{ name?: string }> } | null;
    const results = (post?.queries ?? []).map((q) => ({ rows: q.name === 'workItems.byHarness' ? WORK_ITEMS : [], version: String(Date.now()) }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
}
test('debug checkbox flow', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await stubApis(page);
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self`, { waitUntil: 'domcontentloaded' });
  const mounted = await page.getByRole('button', { name: 'Add panel' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
  console.log('MOUNTED:', mounted);
  if (!mounted) { console.log('ERRORS:', errors); return; }
  await page.getByRole('button', { name: 'Add panel' }).click();
  const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
  await expect(catalog).toBeVisible();
  await catalog.getByText('Work items', { exact: true }).first().click();
  const bar = page.locator('.pc-advpanel__filterbar').first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  const addFilter = bar.getByRole('combobox', { name: 'Add a column filter' });
  await addFilter.click();
  const opt = page.getByRole('option', { name: 'State', exact: true });
  await opt.waitFor({ state: 'visible' });
  // try to wait for the popper to settle
  await page.waitForTimeout(400);
  await opt.click();
  const editor = page.getByRole('dialog', { name: 'Edit State filter' });
  await expect(editor).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(400);
  console.log('EDITOR HTML:', (await editor.innerHTML()).slice(0, 600));
  const cb = editor.getByRole('checkbox', { name: 'open' });
  console.log('CHECKBOX COUNT:', await cb.count());
  await cb.click();
  await page.waitForTimeout(500);
  console.log('URL AFTER CLICK:', page.url());
  console.log('CHIPS:', await bar.locator('.pc-advpanel__chip').allInnerTexts());
  console.log('ERRORS:', errors);
});
